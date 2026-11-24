"""Launch a disposable Atelier checkout and talk to its public HTTP interface."""

from __future__ import annotations

from contextlib import contextmanager
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import quote, urlsplit
import uuid

import requests


_CREDENTIAL_FIELDS = frozenset(
    {
        "access_key",
        "access_key_id",
        "access_key_secret",
        "secret_key",
        "api_key",
        "token",
        "access_token",
        "refresh_token",
        "session_token",
        "grant_token",
        "client_secret",
        "password",
        "authorization",
        "proxy-authorization",
        "x-api-key",
        "cookie",
        "set-cookie",
        "x-goog-api-key",
    }
)
_URL = re.compile(r"""(?i)\b(?:https?|wss?|ftp|file)://[^\s<>"'`]+""")
_AUTH_LINE = re.compile(
    r"""(?ix)\b(authorization|proxy-authorization|x-api-key|x-goog-api-key|set-cookie|cookie)"""
    r"""["']?\s*[:=]\s*[^\r\n]+"""
)
_HEADERS = {"headers", "request_headers", "response_headers"}
_STARTUP_TIMEOUT = 30
_STDERR_BYTES = 16 * 1024
_STDERR_FIELDS = re.compile(
    r"""(?i)\b(?:%s)["']?\s*[:=]\s*[^\r\n]+"""
    % "|".join(re.escape(field) for field in sorted(_CREDENTIAL_FIELDS | _HEADERS | {"api-key"}))
)


class StartupError(RuntimeError):
    """A startup error whose message can be displayed to the operator."""


def _scrub_text(value, data_root, secrets):
    value = _URL.sub("[redacted URL]", value)
    value = value.replace(str(data_root.parent), "<isolated>")
    for secret in sorted(secrets, key=len, reverse=True):
        value = value.replace(secret, "[redacted]")
    return _AUTH_LINE.sub("[redacted header]", value)


class _StartupStderr:
    def __init__(self, stream):
        self._tail = b""
        self._record = True
        self._thread = threading.Thread(target=self._drain, args=(stream,), daemon=True)
        self._thread.start()

    def _drain(self, stream):
        with stream:
            while chunk := stream.read1(_STDERR_BYTES):
                if self._record:
                    # One extra byte tells the formatter whether the first line was cut.
                    self._tail = (self._tail + chunk)[-(_STDERR_BYTES + 1) :]

    def discard(self):
        self._record = False
        self._tail = b""

    def error(self, message, data, secrets, server_root):
        self._thread.join(timeout=1)
        raw = self._tail
        truncated = len(raw) > _STDERR_BYTES
        if truncated:
            # A partial URL or credential would no longer match the redactor.
            raw = raw.partition(b"\n")[2]
        value = _scrub_text(raw.decode("utf-8", errors="replace"), data, secrets)
        value = _STDERR_FIELDS.sub("[redacted credential]", value)
        for root in (data.parent.resolve(), server_root, Path(__file__).resolve().parents[2]):
            value = value.replace(str(root), "<local>")
        lines = value.splitlines()
        excerpt = "\n".join(lines[-12:])
        if truncated or len(lines) > 12 or len(excerpt) > 3000:
            excerpt = "（前文已截断）\n" + excerpt[-3000:]
        return StartupError(f"{message}\nstderr：{excerpt or '（无输出）'}")


def selected_keys(data_root, providers):
    # Only the selected records enter the new key file. OSS secrets and unselected route
    # configuration belong to the source workspace and are never copied.
    try:
        db = json.loads((data_root / ".config" / "keys.json").read_text(encoding="utf-8"))
        keys = [key for key in db["keys"] if key["alias"] in providers]
    except (OSError, TypeError, ValueError, KeyError):
        raise ValueError("无法读取指定数据目录的供应商配置") from None
    if not providers or {key["alias"] for key in keys} != set(providers):
        raise ValueError("点名的供应商在指定数据目录中不存在")
    result = {"version": db.get("version", 1), "keys": keys}
    if db.get("default_alias") in providers:
        result["default_alias"] = db["default_alias"]
    return result


def _copy_price_snapshots(source, data, keys):
    names = set()
    for key in keys["keys"]:
        host = (urlsplit(key.get("base_url") or "").hostname or "").lower()
        for domain, filename in (("tu-zi.com", "tuzi.json"), ("openai-hk.com", "openai-hk.json")):
            if host == domain or host.endswith("." + domain):
                names.add(filename)
        if key.get("provider") == "tokendance":
            names.add("tokendance.json")
    for name in names:
        path = source.resolve() / ".runtime" / "prices" / name
        if path.is_file() and path.resolve() == path:
            target = data / ".runtime" / "prices"
            target.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target / name)


def credential_values(value):
    if isinstance(value, list):
        for item in value:
            yield from credential_values(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            if key.lower() in _CREDENTIAL_FIELDS and isinstance(item, str) and item:
                yield item
                yield quote(item, safe="")
            else:
                yield from credential_values(item)


class LocalAPI(requests.Session):
    def __init__(self, port, root, keys):
        super().__init__()
        self.base_url = f"http://127.0.0.1:{port}"
        self.data_root = root
        self.trust_env = False
        self.headers.update(
            {
                "Origin": self.base_url,
                "Sec-Fetch-Site": "same-origin",
                "X-Atelier-Client": uuid.uuid4().hex,
            }
        )
        self._lease = None
        self._secrets = set(credential_values(keys))

    def finish_preflight(self):
        (self.data_root.parent / "preflight").unlink()

    def scrub(self, value):
        if isinstance(value, str):
            return _scrub_text(value, self.data_root, self._secrets)
        if isinstance(value, (list, tuple)):
            return [self.scrub(item) for item in value]
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                field = str(key).lower()
                sensitive = field in _CREDENTIAL_FIELDS or field.replace("-", "_") in _HEADERS
                result[self.scrub(key)] = "[redacted]" if sensitive else self.scrub(item)
            return result
        return value

    def request(self, method, url, **kwargs):
        if not url.startswith("/") or url.startswith("//"):
            raise ValueError("评测驱动只接受当前服务的相对路径")
        if self._lease is not None and time.monotonic() >= self._lease:
            self.renew_lease()
        if method.upper() not in {"GET", "HEAD", "OPTIONS"} and not any(
            name in kwargs for name in ("json", "data", "files")
        ):
            kwargs["json"] = {}
        kwargs.setdefault("timeout", 10)
        kwargs["allow_redirects"] = False
        return super().request(method, self.base_url + url, **kwargs)

    def renew_lease(self):
        response = super().request(
            "POST",
            self.base_url + "/api/connection/editor-lease",
            json={"client_id": self.headers["X-Atelier-Client"]},
            allow_redirects=False,
            timeout=5,
        )
        response.raise_for_status()
        self._lease = time.monotonic() + 10

    def connect(self):
        status = self.get("/api/connection/status", timeout=1)
        # Pre-local-session checkouts serve business routes directly. The child exclusively
        # owns the bound socket, so an absent handshake cannot select another live service.
        if status.status_code in {404, 405} or "application/json" not in status.headers.get(
            "content-type", ""
        ):
            return
        status.raise_for_status()
        self.post("/api/connection/local-session", json={}).raise_for_status()
        self._secrets.update(cookie.value for cookie in self.cookies)
        self.renew_lease()


def _fake_ports(keys):
    ports = set()
    for key in keys.get("keys", []):
        url = urlsplit(key.get("base_url") or "")
        try:
            local = url.hostname == "localhost" or ipaddress.ip_address(url.hostname).is_loopback
        except ValueError:
            local = False
        if not local or url.scheme not in {"http", "https"}:
            raise ValueError("假供应商必须使用回环地址")
        ports.add(url.port or (443 if url.scheme == "https" else 80))
    return sorted(ports)


def _environment(home, data, server_root, fake):
    env = {
        key: value
        for key, value in os.environ.items()
        if key.upper()
        in {
            "PATH",
            "WINDIR",
            "SYSTEMROOT",
            "SYSTEMDRIVE",
            "PATHEXT",
            "COMSPEC",
            "LANG",
            "LC_ALL",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "REQUESTS_CA_BUNDLE",
        }
    }
    for key, folder in {
        "XDG_CONFIG_HOME": "config",
        "XDG_CACHE_HOME": "cache",
        "XDG_DATA_HOME": "share",
        "LOCALAPPDATA": "local",
        "APPDATA": "roaming",
        "TMPDIR": "tmp",
        "TMP": "tmp",
        "TEMP": "tmp",
    }.items():
        path = home / folder
        path.mkdir(exist_ok=True)
        env[key] = str(path)
    env.update(
        HOME=str(home),
        USERPROFILE=str(home),
        PYTHONPATH=str(server_root / "src"),
        GAME_ATELIER_DATA_ROOT=str(data),
        PYTHONNOUSERSITE="1",
        PYTHONDONTWRITEBYTECODE="1",
        OPENAI_AGENTS_DISABLE_TRACING="true",
        PYTHONUTF8="1",
    )
    if fake is not None:
        env.update(
            NO_PROXY="*", no_proxy="*", ATELIER_EVAL_FAKE_PORTS=json.dumps(_fake_ports(fake))
        )
    else:
        env.update(
            {
                k: v
                for k, v in os.environ.items()
                if k.lower()
                in {
                    "http_proxy",
                    "https_proxy",
                    "all_proxy",
                    "no_proxy",
                }
            }
        )
    return env


def _stop(proc):
    try:
        if proc.poll() is None:
            if os.name == "posix":
                os.killpg(proc.pid, signal.SIGTERM)
            else:
                proc.terminate()
            try:
                proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                if os.name == "posix":
                    os.killpg(proc.pid, signal.SIGKILL)
                else:
                    proc.kill()
                proc.wait()
    finally:
        proc.stdin.close()


@contextmanager
def _interrupt_on_termination():
    # Only the CLI's main thread owns the process signal handlers. The pipe still
    # protects children of callers that embed the harness in another thread.
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    previous = {}
    interrupted = False

    def interrupt(signum, frame):
        nonlocal interrupted
        if not interrupted:
            interrupted = True
            raise KeyboardInterrupt

    try:
        for name in ("SIGINT", "SIGTERM", "SIGHUP"):
            signum = getattr(signal, name, None)
            if signum is not None and signal.getsignal(signum) != signal.SIG_IGN:
                previous[signum] = signal.signal(signum, interrupt)
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


@contextmanager
def serve(
    server_root: Path,
    *,
    keys_from: Path | None,
    providers: list[str],
    fake_keys: dict | None,
    preflight: bool = False,
):
    if bool(keys_from is not None) != bool(providers) or (keys_from is None) == (fake_keys is None):
        raise ValueError("真实运行需要同时指定数据目录和供应商")
    server_root = Path(server_root).resolve()
    if not (server_root / "src" / "viewer_server" / "server_app.py").is_file():
        raise ValueError("server-root 不是有 viewer-server 的 Atelier 检出目录")
    keys = fake_keys if fake_keys is not None else selected_keys(Path(keys_from), providers)
    with (
        _interrupt_on_termination(),
        tempfile.TemporaryDirectory(prefix="atelier-agent-eval-") as tmp,
    ):
        root = Path(tmp)
        home = root / "home"
        home.mkdir()
        data = root / "data"
        config = data / ".config"
        config.mkdir(parents=True)
        with os.fdopen(
            os.open(config / "keys.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600),
            "w",
            encoding="utf-8",
        ) as handle:
            json.dump(keys, handle)
        python = server_root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if keys_from is not None:
            _copy_price_snapshots(Path(keys_from), data, keys)
        if preflight:
            (root / "preflight").touch()
        port_file = root / "port"
        proc = subprocess.Popen(
            [
                str(python if python.is_file() else sys.executable),
                str(Path(__file__).with_name("_server.py")),
                str(port_file),
            ],
            env=_environment(home, data, server_root, fake_keys),
            cwd=server_root,
            start_new_session=os.name == "posix",
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        api = None
        try:
            stderr = _StartupStderr(proc.stderr)

            def startup_error(message):
                _stop(proc)
                secrets = api._secrets if api is not None else credential_values(keys)
                return stderr.error(message, data, secrets, server_root)

            deadline = time.monotonic() + _STARTUP_TIMEOUT
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    raise startup_error(f"隔离服务启动失败（退出码 {proc.returncode}）")
                if api is None and port_file.exists():
                    port = port_file.read_text(encoding="ascii")
                    if port.isdigit():
                        api = LocalAPI(int(port), data, keys)
                if api is not None:
                    try:
                        api.connect()
                        break
                    except (requests.ConnectionError, requests.Timeout):
                        pass
                    except requests.HTTPError as exc:
                        raise startup_error(
                            f"隔离服务会话连接失败（HTTP {exc.response.status_code}）"
                        ) from None
                time.sleep(0.08)
            else:
                raise startup_error(f"隔离服务未能在 {_STARTUP_TIMEOUT} 秒内启动")
            stderr.discard()
            yield api
        finally:
            if api is not None:
                api.close()
            _stop(proc)
