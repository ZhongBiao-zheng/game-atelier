"""Launch a disposable Atelier checkout and talk to its public HTTP interface."""

from __future__ import annotations

from contextlib import contextmanager
import ipaddress
import json
import os
from pathlib import Path
import re
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

    def scrub(self, value):
        if isinstance(value, str):
            value = value.replace(str(self.data_root.parent), "<isolated>")
            for secret in sorted(self._secrets, key=len, reverse=True):
                value = value.replace(secret, "[redacted]")
            return _AUTH_LINE.sub("[redacted header]", _URL.sub("[redacted URL]", value))
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
            if (signum := getattr(signal, name, None)) is not None:
                previous[signum] = signal.signal(signum, interrupt)
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


@contextmanager
def serve(
    server_root: Path, *, keys_from: Path | None, providers: list[str], fake_keys: dict | None
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
            stderr=subprocess.DEVNULL,
        )
        api = None
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    raise RuntimeError(
                        f"隔离服务启动失败（退出码 {proc.returncode}），请检查目标检出的依赖"
                    )
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
                time.sleep(0.08)
            else:
                raise TimeoutError("隔离服务未能在 30 秒内启动")
            yield api
        finally:
            if api is not None:
                api.close()
            _stop(proc)
