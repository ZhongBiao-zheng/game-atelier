#!/usr/bin/env python3
"""Bootstrap entrypoint for the game-atelier Plugin.

Only stdlib + platformdirs (single pure-Python dep). Runs under system python.
After venv is built, business logic switches to <data_root>/.venv/python.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import queue
import re
import threading
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

try:
    import platformdirs
except ModuleNotFoundError:  # 系统 python 常无 platformdirs，degrade 到逐平台兜底
    platformdirs = None

APP_NAME = "game-atelier"
ENV_VAR = "GAME_ATELIER_DATA_ROOT"

# Plugin directory == repo root (this file lives in scripts/).
PLUGIN_DIR = Path(__file__).resolve().parent.parent


def is_bundle() -> bool:
    """只有包内解释器才能启用离线运行路径，目录名或环境变量不能冒充。"""
    return Path(sys.executable).resolve().is_relative_to(PLUGIN_DIR.parent / "python")


def _user_config_dir() -> Path:
    """等价 platformdirs.user_config_dir(APP_NAME)；platformdirs 缺失时逐平台兜底。

    bootstrap 可在系统 python 下跑（Codex 经软链装入、用裸 `python` 跑本脚本时，
    系统 python 常无 platformdirs）。兜底路径必须与 venv python（有 platformdirs）
    写 config 的位置逐字节一致，否则读不到已配置的 data-root。对照 platformdirs 4.x：
      Windows: %LOCALAPPDATA%/<app>/<app>（appauthor 缺省=appname → 双层）
      macOS:   ~/Library/Application Support/<app>
      Linux:   $XDG_CONFIG_HOME/<app> 或 ~/.config/<app>
    """
    if platformdirs is not None:
        return Path(platformdirs.user_config_dir(APP_NAME))
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / APP_NAME / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / APP_NAME


def global_config_file() -> Path:
    return _user_config_dir() / "data-root"


def resolve_data_root() -> Path | None:
    if env := os.environ.get(ENV_VAR):
        return Path(env).expanduser().resolve()
    cfg = global_config_file()
    if cfg.exists():
        text = cfg.read_text(encoding="utf-8").strip()
        if text:
            return Path(text).expanduser().resolve()
    return None


def _venv_python(data_root: Path) -> Path:
    if is_bundle():
        return Path(sys.executable)
    if sys.platform == "win32":
        return data_root / ".venv" / "Scripts" / "python.exe"
    return data_root / ".venv" / "bin" / "python"


def _venv_hash_file(data_root: Path) -> Path:
    return data_root / ".config" / "venv-hash"


def _venv_signature() -> str:
    """只在依赖、锁定版本、Python 要求或 editable 源码位置变化时同步环境。"""
    h = hashlib.sha256()
    for name in ("pyproject.toml", "uv.lock", ".python-version"):
        h.update(name.encode("utf-8") + b"\0")
        h.update((PLUGIN_DIR / name).read_bytes())
        h.update(b"\0")
    h.update(str(PLUGIN_DIR).encode("utf-8"))
    return h.hexdigest()


def _venv_is_current(data_root: Path) -> bool:
    if is_bundle():
        return True
    hash_file = _venv_hash_file(data_root)
    return (
        _venv_python(data_root).is_file()
        and hash_file.is_file()
        and hash_file.read_text(encoding="utf-8").strip() == _venv_signature()
    )


# ---------- 版本更新检查 ----------
# CNB 的 tag 只由通过发布门禁的镜像作业推送；GitHub 只读正式 Release。
CNB_URL = "https://cnb.cool/ZhongBiao-zheng/game-atelier.git"
GITHUB_URL = "https://github.com/ZhongBiao-zheng/game-atelier.git"
LATEST_RELEASE_URL = "https://api.github.com/repos/ZhongBiao-zheng/game-atelier/releases/latest"
UPDATE_CACHE_CHANNEL = "tag-releases-v1"
RELEASE_TAG = re.compile(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")
# uv 找不到本机 Python 3.11+ 时要下载一份；默认源是 GitHub，国内基本下不动。
PYTHON_INSTALL_MIRROR = "https://registry.npmmirror.com/-/binary/python-build-standalone"
UPDATE_CACHE_TTL_OK = 24 * 3600  # 拉取成功后 24h 内不再联网
UPDATE_CACHE_TTL_FAIL = 3600  # 拉取失败 1h 内不重试，避免断网时每次 --check 都等超时
UPDATE_FETCH_TIMEOUT = 3  # 秒；应用内提示是顺路的，绝不为它拖慢 skill 启动
UPDATE_CNB_TIMEOUT = 1.5  # 应用内提示里 CNB 的份额，余量留给 GitHub
# 一键启动：更新正是这一步的目的，实测 CNB 列 tag 要 3–9 秒，按 3 秒预算永远查不到新版。
LAUNCH_CNB_TIMEOUT = 8
LAUNCH_FETCH_TIMEOUT = LAUNCH_CNB_TIMEOUT + 3


def _update_cache_file() -> Path:
    # 放 config dir 而非 data_root：data_root 未配置（首启向导前）也要能缓存
    return _user_config_dir() / "update-check.json"


def _current_version() -> str | None:
    try:
        payload = json.loads(
            (PLUGIN_DIR / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")
        )
        return payload.get("version") or None
    except (OSError, json.JSONDecodeError):
        return None


def _version_tuple(v: str) -> tuple[int, ...]:
    return tuple(int(p) for p in v.split("."))


def _release(tag: str, source: str) -> dict:
    if not isinstance(tag, str) or not RELEASE_TAG.fullmatch(tag):
        raise ValueError("不是正式版本 tag")
    return {"tag": tag, "version": tag[1:], "source": source}


def _query_latest_release(use_git: bool, deadline: float, cnb_timeout: float | None = None) -> dict:
    errors = []
    if use_git:
        try:
            result = subprocess.run(
                ["git", "ls-remote", "--tags", "--refs", CNB_URL],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=min(cnb_timeout or UPDATE_CNB_TIMEOUT, max(0.01, deadline - time.monotonic())),
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            )
            if result.returncode:
                raise OSError("CNB tag 查询失败")
            tags = [line.split()[1].removeprefix("refs/tags/")
                    for line in result.stdout.splitlines()
                    if len(line.split()) == 2 and line.split()[1].startswith("refs/tags/")]
            tags = [tag for tag in tags if RELEASE_TAG.fullmatch(tag)]
            if not tags:
                raise ValueError("CNB 暂无正式 tag")
            return _release(max(tags, key=lambda tag: _version_tuple(tag[1:])), "cnb")
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            errors.append("CNB 查询超时" if isinstance(error, subprocess.TimeoutExpired) else str(error))
    # CNB Release API 实测匿名 401；无 git 的安装包直接查询公开 GitHub Release。
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("更新检查预算已用完")
    try:
        request = urllib.request.Request(LATEST_RELEASE_URL, headers={
            "Accept": "application/vnd.github+json", "User-Agent": "GameAtelier-Updater",
        })
        with urllib.request.urlopen(request, timeout=remaining) as response:
            payload = json.loads(response.read(1024 * 1024).decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("draft") is not False or payload.get("prerelease") is not False or not payload.get("published_at"):
            raise ValueError("没有已发布的正式 Release")
        return _release(payload.get("tag_name"), "github")
    except (OSError, ValueError) as error:
        errors.append(str(error))
        raise OSError("；".join(errors)) from None


def _fetch_latest_release(
    use_git: bool, budget: float | None = None, cnb_timeout: float | None = None,
) -> tuple[dict | None, str | None]:
    # socket timeout 不是总时限（DNS/慢速分块可能拖长）；主线程只等固定预算。
    # worker 不写缓存，超时后的迟到响应不会改变本次判断，也不会阻止进程退出。
    results = queue.Queue(maxsize=1)
    budget = budget or UPDATE_FETCH_TIMEOUT
    deadline = time.monotonic() + budget

    def query():
        try:
            results.put((_query_latest_release(use_git, deadline, cnb_timeout), None))
        except Exception as error:
            results.put((None, str(error)))

    threading.Thread(target=query, daemon=True).start()
    try:
        return results.get(timeout=max(0.001, deadline - time.monotonic()))
    except queue.Empty:
        return None, f"更新检查超过 {budget:g} 秒预算"


def latest_release(*, use_git: bool = False, fresh: bool = False) -> dict | None:
    """源码与安装包共用发现/缓存；HTTP 模式不读取只被 tag 确认的结果。

    fresh=True 给一键启动：不读缓存、用长预算查一次，结果照样写缓存供应用内提示复用。"""
    if os.environ.get("GAME_ATELIER_NO_UPDATE_CHECK"):
        return None
    cache = _read_update_cache()
    mode = "git" if use_git else "http"
    now = time.time()
    checked_at = cache.get("checked_at", 0)
    release = cache.get("release")
    valid = cache.get("channel") == UPDATE_CACHE_CHANNEL and cache.get("mode") == mode
    if release is not None:
        try:
            valid = valid and release == _release(release["tag"], release["source"])
            valid = valid and release["source"] in ({"cnb", "github"} if use_git else {"github"})
        except (KeyError, TypeError, ValueError):
            valid = False
    ttl = UPDATE_CACHE_TTL_OK if release else UPDATE_CACHE_TTL_FAIL
    if not fresh and valid and isinstance(checked_at, (int, float)) and 0 <= now - checked_at < ttl:
        return release
    release, error = (_fetch_latest_release(use_git, LAUNCH_FETCH_TIMEOUT, LAUNCH_CNB_TIMEOUT)
                      if fresh else _fetch_latest_release(use_git))
    cache.update({"channel": UPDATE_CACHE_CHANNEL, "mode": mode, "checked_at": now,
                  "release": release, "latest": release["version"] if release else None})
    _write_update_cache(cache)
    if error:
        print(f"无法检查更新：{error}", file=sys.stderr)
    return release


def _read_update_cache() -> dict:
    try:
        data = json.loads(_update_cache_file().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_update_cache(cache: dict) -> None:
    try:
        f = _update_cache_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def update_info() -> dict | None:
    """--check 顺路的更新检查。返回 None = 当前版本未知（异常安装），不提更新。

    dismissed=True 表示用户对 latest 这个版本明确说过"这次不更新"（--dismiss-update），
    SKILL.md 据此闭嘴；出了更高版本 dismissed 自动失效。
    """
    # 测试/CI 关网禁写：既不联网也不碰真实用户 config 目录
    if os.environ.get("GAME_ATELIER_NO_UPDATE_CHECK"):
        return None

    current = _current_version()
    if current is None:
        return None

    release = latest_release(use_git=not is_bundle())
    latest = release["version"] if release else None
    cache = _read_update_cache()
    info = {"current": current, "latest": latest, "update_available": False, "dismissed": False}
    if not latest:
        return info
    try:
        info["update_available"] = _version_tuple(latest) > _version_tuple(current)
    except ValueError:
        return info
    info["dismissed"] = info["update_available"] and cache.get("dismissed") == latest
    return info


def dismiss_update() -> int:
    """记录"用户拒绝更新到 latest"。同版本不再问，新版本再提。"""
    cache = _read_update_cache()
    latest = cache.get("latest")
    if not latest:
        print(json.dumps({"status": "noop", "reason": "无已知的最新版本可忽略"}, ensure_ascii=False))
        return 0
    cache["dismissed"] = latest
    _write_update_cache(cache)
    print(json.dumps({"status": "ok", "dismissed": latest}, ensure_ascii=False))
    return 0


def _web_dist_ok() -> bool:
    """前端构建产物是否随插件就位。缺失 → viewer-server 无前端可挂、开窗 404。"""
    return (PLUGIN_DIR / "web" / "dist" / "index.html").exists()


def _uv_install_instruction() -> str:
    if sys.platform == "win32":
        return "powershell -c \"irm https://astral.sh/uv/install.ps1 | iex\""
    return "curl -LsSf https://astral.sh/uv/install.sh | sh"


def check() -> dict:
    # 前端产物缺失先于一切：没有 UI，启了 server 也只会开窗 404。
    if not _web_dist_ok():
        return {
            "status": "needs_web_build",
            "data_root": None,
            "uv_path": shutil.which("uv"),
            "venv_python": None,
            "platform": sys.platform,
            "next_action": (
                "前端未构建（缺 web/dist）。开发模式跑 `make build`；"
                "插件用户：安装包缺预构建 UI，请重装插件或反馈打包问题——不要在此状态下开窗。"
            ),
        }

    data_root = resolve_data_root()
    if data_root is None:
        return {
            "status": "needs_data_root",
            "data_root": None,
            "uv_path": shutil.which("uv"),
            "venv_python": None,
            "platform": sys.platform,
            "next_action": "选数据目录（CC 向导问用户）",
        }

    uv_path = shutil.which("uv")
    if uv_path is None and not is_bundle():
        return {
            "status": "needs_uv",
            "data_root": str(data_root),
            "uv_path": None,
            "venv_python": None,
            "platform": sys.platform,
            "next_action": f"安装 uv: {_uv_install_instruction()}",
        }

    venv_py = _venv_python(data_root)
    if not _venv_is_current(data_root):
        return {
            "status": "needs_venv",
            "data_root": str(data_root),
            "uv_path": uv_path,
            "venv_python": str(venv_py),
            "platform": sys.platform,
            "next_action": "运行 bootstrap.py --ensure-venv 安装依赖",
        }

    keys_file = data_root / ".config" / "keys.json"
    if not keys_file.exists():
        return {
            "status": "needs_first_key",
            "data_root": str(data_root),
            "uv_path": uv_path,
            "venv_python": str(venv_py),
            "platform": sys.platform,
            "next_action": "添加第一把图像服务 key（CC 向导问用户）",
        }

    try:
        payload = json.loads(keys_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return {
            "status": "needs_keys_repair",
            "data_root": str(data_root),
            "uv_path": uv_path,
            "venv_python": str(venv_py),
            "platform": sys.platform,
            "stderr": f"keys.json 解析失败: {e}",
            "next_action": "手动修复 keys.json 或删除后重新添加 key",
        }

    keys = payload.get("keys") if isinstance(payload, dict) else None
    if not keys:
        return {
            "status": "needs_first_key",
            "data_root": str(data_root),
            "uv_path": uv_path,
            "venv_python": str(venv_py),
            "platform": sys.platform,
            "next_action": "keys.json 中 'keys' 列表为空，添加第一把 key",
        }

    return {
        "status": "ready",
        "data_root": str(data_root),
        "uv_path": uv_path,
        "venv_python": str(venv_py),
        "platform": sys.platform,
        "next_action": "ready",
    }


def ensure_venv(*, quiet: bool = False) -> int:
    """按签名同步唯一运行环境；普通启动不执行 uv，不访问包源。"""
    if is_bundle():
        return 0
    data_root = resolve_data_root()
    if data_root is None:
        print(json.dumps({
            "status": "error",
            "error": "data_root not configured — run --init-data-root first",
        }, ensure_ascii=False))
        return 1

    if _venv_is_current(data_root):
        if not quiet:
            print(json.dumps({
                "status": "ok",
                "data_root": str(data_root),
                "venv_python": str(_venv_python(data_root)),
                "venv_hash": _venv_signature(),
            }, ensure_ascii=False))
        return 0

    uv_path = shutil.which("uv")
    if uv_path is None:
        print(json.dumps({
            "status": "error",
            "error": f"uv not installed — install via: {_uv_install_instruction()}",
        }, ensure_ascii=False))
        return 2

    # Windows 无法替换仍被服务加载的 .pyd / DLL；只有需要同步时才提前停止占用者。
    if _venv_python(data_root).exists() and (data_root / ".runtime" / "server.pid").exists():
        print("更新运行依赖前停止旧实例…", file=sys.stderr, flush=True)
        # 从新代码路径运行 stop，旧插件缓存可能已移除、editable 尚未重新指向新目录。
        stop_args = [str(PLUGIN_DIR / "src" / "viewer_server" / "server.py"), "stop"]
        if run_in_venv(stop_args, stdout=sys.stderr):
            print("旧实例未停止，未修改运行环境。", file=sys.stderr)
            return 4

    venv = data_root / ".venv"
    venv.parent.mkdir(parents=True, exist_ok=True)
    env = {
        "UV_PYTHON_INSTALL_MIRROR": PYTHON_INSTALL_MIRROR,
        **os.environ,
        "UV_PROJECT_ENVIRONMENT": str(venv),
    }
    # 启动器 / Agent 可能带着另一个 venv；同步目标只由数据目录决定。
    env.pop("VIRTUAL_ENV", None)
    hash_file = _venv_hash_file(data_root)
    hash_file.unlink(missing_ok=True)
    print("正在安装运行依赖…", file=sys.stderr, flush=True)
    proc = subprocess.run(
        [uv_path, "sync", "--locked", "--no-dev", "--project", str(PLUGIN_DIR)],
        env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        if quiet:
            print("运行依赖安装失败，请检查网络后重新启动。", file=sys.stderr)
            print(proc.stderr or proc.stdout or "uv sync failed", file=sys.stderr)
        else:
            print(json.dumps({
                "status": "error",
                "error": "uv sync failed",
                "stderr": proc.stderr or "",
                "stdout": proc.stdout or "",
            }, ensure_ascii=False))
        return 3

    hash_file.parent.mkdir(parents=True, exist_ok=True)
    hash_file.write_text(_venv_signature(), encoding="utf-8")

    if not quiet:
        print(json.dumps({
            "status": "ok",
            "data_root": str(data_root),
            "venv_python": str(_venv_python(data_root)),
            "venv_hash": _venv_signature(),
        }, ensure_ascii=False))
    return 0


_MEMORY_TEMPLATE = """\
# game-atelier MEMORY

## 出图通用

## 开发

<!-- session-count: 0/5 -->
"""


def init_data_root(target: Path) -> int:
    """Create the data-root skeleton and write the global config pointer."""
    resolved = target.expanduser().resolve()
    for sub in (".config", ".runtime", "projects", "characters"):
        (resolved / sub).mkdir(parents=True, exist_ok=True)

    memory_file = resolved / "MEMORY.md"
    if not memory_file.exists():
        memory_file.write_text(_MEMORY_TEMPLATE, encoding="utf-8")

    cfg = global_config_file()
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(str(resolved) + "\n", encoding="utf-8")

    print(json.dumps({
        "status": "ok",
        "data_root": str(resolved),
        "config_file": str(cfg),
    }, ensure_ascii=False))
    return 0


def run_in_venv(forward_args: list[str], *, stdout=None) -> int:
    """Forward `forward_args` to <data_root>/.venv/python. Use from SKILL.md so
    installed-Plugin invocations don't depend on system python."""
    data_root = resolve_data_root()
    if data_root is None:
        print(json.dumps({
            "status": "error",
            "error": "data_root not set — run bootstrap.py --init-data-root first",
        }, ensure_ascii=False))
        return 1
    venv_py = _venv_python(data_root)
    if not venv_py.exists():
        print(json.dumps({
            "status": "error",
            "error": "venv not built — run bootstrap.py --ensure-venv",
        }, ensure_ascii=False))
        return 2
    env = {
        **os.environ,
        "VIRTUAL_ENV": str(data_root / ".venv"),
        "UV_PROJECT_ENVIRONMENT": str(data_root / ".venv"),
    }
    if is_bundle():
        env.pop("VIRTUAL_ENV", None)
        env.pop("UV_PROJECT_ENVIRONMENT", None)
        env["PYTHONPATH"] = str(PLUGIN_DIR / "src")
    proc = subprocess.run([str(venv_py), *forward_args], env=env, stdout=stdout)
    return proc.returncode


def launch() -> int:
    """一键启动：按需准备共享运行环境，再用该环境重启服务。"""
    if not _web_dist_ok():
        print("前端文件 web/dist 缺失，请运行一键修复。", file=sys.stderr)
        return 1
    if resolve_data_root() is None:
        init_data_root(Path.home() / APP_NAME)
    if is_bundle():
        update_info()
    started = time.perf_counter()
    result = ensure_venv(quiet=True)
    print(f"[4/6] 检查依赖 … {time.perf_counter() - started:.1f}s", flush=True)
    if result:
        return result
    started = time.perf_counter()
    result = run_in_venv(["-m", "viewer_server.server", "stop"])
    print(f"[5/6] 停止旧实例 … {time.perf_counter() - started:.1f}s", flush=True)
    if result:
        return result
    started = time.perf_counter()
    result = run_in_venv(["-m", "viewer_server.server", "start", "--background"])
    print(f"[6/6] 启动工坊 … {time.perf_counter() - started:.1f}s", flush=True)
    return result


def _force_utf8_stdio() -> None:
    """Windows 控制台默认 GBK；强制 stdout/stderr UTF-8，防中文 next_action / JSON mojibake。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


def main() -> int:
    _force_utf8_stdio()
    # Handle --run before argparse so the remaining args pass through unparsed.
    if len(sys.argv) >= 2 and sys.argv[1] == "--run":
        return run_in_venv(sys.argv[2:])

    parser = argparse.ArgumentParser(description="Bootstrap the game-atelier plugin.")
    parser.add_argument("--check", action="store_true", help="Report current bootstrap state.")
    parser.add_argument(
        "--launch", action="store_true", help="Prepare the shared runtime and launch the viewer.",
    )
    parser.add_argument(
        "--init-data-root",
        metavar="PATH",
        help="Create data-root skeleton at PATH and write global config pointer.",
    )
    parser.add_argument(
        "--ensure-venv",
        action="store_true",
        help="Sync <data_root>/.venv only when its dependency signature changes.",
    )
    parser.add_argument(
        "--dismiss-update",
        action="store_true",
        help="Record that the user declined updating to the latest known version.",
    )
    parser.add_argument(
        "--run",
        action="store_true",
        help="Forward remaining args to <data_root>/.venv/python (handled before argparse).",
    )
    args = parser.parse_args()

    if args.check:
        result = check()
        result["update"] = update_info()
        result["runtime_mode"] = "bundle" if is_bundle() else "source"
        print(json.dumps(result, ensure_ascii=False))
        return 0

    if args.dismiss_update:
        return dismiss_update()

    if args.init_data_root:
        return init_data_root(Path(args.init_data_root))

    if args.ensure_venv:
        return ensure_venv()

    if args.launch:
        return launch()

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
