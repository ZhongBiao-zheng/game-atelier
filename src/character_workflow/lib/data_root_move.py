"""更换数据目录：按目标内容分流（ADR 见规格 D1）。

- 目标不存在或是空文件夹 → 复制当前数据、校验、切换指针；原目录保留不删。
- 目标已是 Atelier 数据目录（有 `.config/` 或 `canvases/`）→ 直接切换指针。
- 目标非空且不是 Atelier 数据 → 拒绝，让用户新建子文件夹。

写入门闩：`start()` 先封住门闩（`enter_write()` 起一律拒绝），等在途写请求排空，再确认没有进行中的
生成 / Agent / 网关任务，然后才复制或切换；门闩到整个更换结束（成功、失败或回滚）才打开。

切换提交（`_commit`）：运行记录（pid / 端口 / 实例 / 外壳控制）交接到新目录 → 原子写指针 → 本进程
改用新目录 → 文件监听接管。任何一步失败都退回旧指针、旧环境与旧监听，迁移报失败；复制来的半成品清掉。
复制路径的 `.atelier-moving` 标记在指针提交之后才删；启动时 `recover_interrupted()` 认得留下的标记。

任务记录等 JSON 里的产物路径是绝对路径：复制时解析 JSON，只把「值整体是旧目录下绝对路径」的字段换成
新目录，提示词等正文字段原样不动。回收站里单独移进去的文件没有扩展名，按清单里记的原路径认 JSON。
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_text
from character_workflow.lib.file_lock import try_file_lock

logger = logging.getLogger(__name__)

ATELIER_MARKERS = (".config", "canvases")
INCOMPLETE_MARKER = ".atelier-moving"
_ENV_VAR = "GAME_ATELIER_DATA_ROOT"
# 不复制：运行环境（.venv 里的脚本写死了旧路径，换目录后由启动器重建）与本次服务的运行文件。
_SKIP_TOP = {".venv"}
_SKIP_RUNTIME = {
    "server.pid", "server.port", "server.instance", "server.log", "server.start.lock",
    "shell-control.json", "shell-owned", "locks", "maintenance", data_root.UNCONFIRMED_MARKER,
}
# 本进程的运行身份：切换提交时交接到新目录（CLI / 外壳 / MCP 都按数据目录找它）。旧目录里的那份保留：
# 外壳缓存着旧目录，靠它继续核对和停止同一个服务；进程退出后两边都按失效记录清理。
_RUN_RECORDS = ("server.pid", "server.port", "server.instance", "shell-control.json", "shell-owned")
_PRIVATE_RECORDS = {"shell-control.json"}
_REWRITE_SUFFIXES = {".json", ".jsonl"}
# 正文字段：值整体恰好像一条路径也不改（提示词是用户原文）。
_TEXT_KEYS = frozenset({
    "prompt", "negative_prompt", "revised_prompt", "text", "content", "lyrics", "message",
    "title", "label", "name", "description", "caption", "note", "notes", "summary",
})
_DRAIN_SECONDS = 10.0
_START_LOCK_ATTEMPTS = 50
_START_LOCK_DELAY = 0.2

Phase = Literal["idle", "copying", "verifying", "done", "failed"]


class MoveRejected(ValueError):
    """目标不能用；message 是给用户看的一句话。"""


@dataclass
class MoveState:
    phase: Phase = "idle"
    source: str | None = None
    target: str | None = None
    total_bytes: int = 0
    copied_bytes: int = 0
    total_files: int = 0
    copied_files: int = 0
    error: str | None = None
    started_at: float | None = None
    finished_at: float | None = None
    mode: Literal["copy", "switch"] | None = None
    # 技术原文（异常类型与信息），界面收在「查看技术详情」里。
    detail: str | None = None


_lock = threading.Lock()
_drained = threading.Condition(_lock)
_state = MoveState()
_sealed = False
_writers = 0


def snapshot() -> dict:
    with _lock:
        return asdict(_state)


def active() -> bool:
    """门闩封着：正在排空、复制、校验或提交。"""
    with _lock:
        return _sealed


def enter_write() -> bool:
    """写请求进门：门闩封着时拒绝（请求未受理，可原样重发）；放行的必须配对 `leave_write()`。"""
    global _writers
    with _lock:
        if _sealed:
            return False
        _writers += 1
        return True


def leave_write() -> None:
    global _writers
    with _lock:
        _writers -= 1
        _drained.notify_all()


def _seal() -> None:
    global _sealed
    with _lock:
        if _sealed:
            raise MoveRejected("正在迁移数据目录，请等它完成")
        _sealed = True


def _unseal() -> None:
    global _sealed
    with _lock:
        _sealed = False


def _drain(timeout: float) -> bool:
    with _lock:
        return _drained.wait_for(lambda: _writers == 0, timeout=timeout)


def _set(**changes) -> None:
    with _lock:
        for key, value in changes.items():
            setattr(_state, key, value)


def is_atelier_root(path: Path) -> bool:
    return any((path / name).is_dir() for name in ATELIER_MARKERS)


def classify(target: Path, current: Path) -> Literal["same", "switch", "copy"]:
    if target == current:
        return "same"
    if target.is_relative_to(current):
        raise MoveRejected("不能把数据目录放进它自己的子文件夹")
    if current.is_relative_to(target):
        raise MoveRejected("不能选择当前数据目录的上级文件夹，请新建一个子文件夹")
    if target.exists() and not target.is_dir():
        raise MoveRejected("选中的不是文件夹")
    if not target.exists():
        return "copy"
    if (target / INCOMPLETE_MARKER).exists():
        raise MoveRejected("这个文件夹里有一次没完成的迁移，请清空后再选")
    if is_atelier_root(target):
        return "switch"
    if any(target.iterdir()):
        raise MoveRejected("这个文件夹不是空的，请在里面新建一个子文件夹再选")
    return "copy"


def _skipped(relative: Path) -> bool:
    parts = relative.parts
    if not parts:
        return False
    head = parts[0].casefold()
    if head in _SKIP_TOP:
        return True
    return head == ".runtime" and len(parts) > 1 and parts[1].casefold() in _SKIP_RUNTIME


def _plan(source: Path) -> tuple[list[Path], list[Path], int]:
    """→ (目录, 文件或链接, 总字节)；路径均相对 source。"""
    dirs: list[Path] = []
    files: list[Path] = []
    total = 0
    for current, dirnames, filenames in os.walk(source):
        base = Path(current)
        relative_base = base.relative_to(source)
        kept = []
        for name in dirnames:
            relative = relative_base / name
            if _skipped(relative):
                continue
            if (base / name).is_symlink():
                files.append(relative)  # 目录链接按链接本身复制，不跟进去
                continue
            dirs.append(relative)
            kept.append(name)
        dirnames[:] = kept
        for name in filenames:
            relative = relative_base / name
            if _skipped(relative):
                continue
            files.append(relative)
            path = base / name
            if not path.is_symlink():
                total += path.stat().st_size
    return dirs, files, total


def _trash_json_items(source: Path) -> dict[Path, str]:
    """回收站里单独移进去的文件存成 `items/<序号>`、没有扩展名：按清单的 `original` 认出 JSON / JSONL。

    只读清单（格式归 trash.py 管）；读不出的清单跳过，其条目按普通文件原样复制。"""
    found: dict[Path, str] = {}
    trash = source / ".runtime" / "trash"
    try:
        entries = [entry for entry in trash.iterdir() if entry.is_dir()]
    except OSError:
        return found
    for entry in entries:
        try:
            manifest = json.loads((entry / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        items = manifest.get("items") if isinstance(manifest, dict) else None
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            original, stored = item.get("original"), item.get("stored")
            if not (isinstance(original, str) and isinstance(stored, str) and stored.isdigit()):
                continue
            suffix = PurePosixPath(original).suffix.casefold()
            if suffix in _REWRITE_SUFFIXES:
                found[(entry / "items" / stored).relative_to(source)] = suffix
    return found


def _prefix_forms(path: Path) -> list[str]:
    forms = [str(path)]
    if os.sep == "\\":
        forms.append(path.as_posix())
    return list(dict.fromkeys(forms))


class _PathRewriter:
    """把 JSON 里「整体是旧目录或其下绝对路径」的字符串换到新目录；正文字段不动。"""

    def __init__(self, source: Path, target: Path):
        self.pairs = list(zip(_prefix_forms(source), _prefix_forms(target)))

    def path(self, value: str) -> str:
        for old, new in self.pairs:
            if value == old:
                return new
            if value.startswith(old) and value[len(old)] in "/\\":
                return new + value[len(old):]
        return value

    def walk(self, node: Any, key: str | None = None) -> Any:
        if isinstance(node, str):
            return node if key in _TEXT_KEYS else self.path(node)
        if isinstance(node, list):
            return [self.walk(item, key) for item in node]
        if isinstance(node, dict):
            return {self.path(name): self.walk(value, name) for name, value in node.items()}
        return node

    def document(self, text: str) -> str | None:
        """整份 JSON → 改写后的文本；没有要改的或解析不了 → None（原样复制）。"""
        try:
            data = json.loads(text)
        except ValueError:
            return None
        changed = self.walk(data)
        if changed == data:
            return None
        indent = 2 if "\n" in text.strip() else None
        return json.dumps(changed, ensure_ascii=False, indent=indent)

    def lines(self, text: str) -> str | None:
        """JSONL：逐行改写，解析不了的行原样保留。"""
        out: list[str] = []
        touched = False
        for line in text.splitlines(keepends=True):
            body = line.rstrip("\r\n")
            try:
                data = json.loads(body) if body.strip() else None
            except ValueError:
                data = None
            if data is None:
                out.append(line)
                continue
            changed = self.walk(data)
            if changed == data:
                out.append(line)
                continue
            touched = True
            out.append(json.dumps(changed, ensure_ascii=False) + line[len(body):])
        return "".join(out) if touched else None


def _copy_file(src: Path, dst: Path, kind: str | None, rewriter: _PathRewriter) -> bool:
    """复制一个文件；JSON 里有旧目录路径时改写。返回是否改写过。"""
    if src.is_symlink():
        os.symlink(os.readlink(src), dst)
        return False
    if kind is not None:
        try:
            text = src.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            text = None
        if text is not None:
            changed = rewriter.lines(text) if kind == ".jsonl" else rewriter.document(text)
            if changed is not None:
                dst.write_text(changed, encoding="utf-8", newline="")
                shutil.copystat(src, dst)
                return True
    shutil.copy2(src, dst)
    return False


def _verify(source: Path, target: Path, files: list[Path], rewritten: dict[Path, str]) -> None:
    for relative in files:
        src, dst = source / relative, target / relative
        if src.is_symlink():
            if not dst.is_symlink():
                raise OSError(f"缺少链接 {relative}")
            continue
        if not dst.is_file():
            raise OSError(f"缺少文件 {relative}")
        kind = rewritten.get(relative)
        if kind == ".json":
            json.loads(dst.read_text(encoding="utf-8"))
        if kind is not None:
            continue
        if src.stat().st_size != dst.stat().st_size:
            raise OSError(f"文件大小不一致 {relative}")


def _cleanup(target: Path, created: bool) -> None:
    if created:
        shutil.rmtree(target, ignore_errors=True)
        return
    for child in target.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)


def _write_marker(target: Path, state: Literal["copying", "committing"], source: Path) -> None:
    atomic_write_text(target / INCOMPLETE_MARKER,
                      json.dumps({"state": state, "source": str(source)}, ensure_ascii=False))


def _read_marker(root: Path) -> dict:
    try:
        value = json.loads((root / INCOMPLETE_MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def recover_interrupted() -> str | None:
    """服务启动前调：当前数据目录还带着迁移标记 = 上次更换在提交窗口里被强退。

    - 标记是 committing：校验已通过、指针已经指过来，只差删标记 → 删掉，算完成。
    - 标记是 copying（或读不出）却成了当前目录：指针不该指到半成品 → 退回标记里记的来源目录。
      数据目录由环境变量指定时不动指针，只记日志。
    返回 "completed" / "rolled_back" / None。"""
    root = data_root.resolve_data_root()
    if not (root / INCOMPLETE_MARKER).exists():
        return None
    marker = _read_marker(root)
    if marker.get("state") == "committing":
        (root / INCOMPLETE_MARKER).unlink(missing_ok=True)
        logger.info("data root move finished after restart: %s", root)
        return "completed"
    source = marker.get("source")
    if os.environ.get(_ENV_VAR) or not isinstance(source, str) or not is_atelier_root(Path(source)):
        logger.warning("data root %s is an unfinished copy; pointer left unchanged", root)
        return None
    data_root.write_global_config(Path(source))
    logger.warning("data root %s is an unfinished copy; switched back to %s", root, source)
    return "rolled_back"


def _hand_over_records(source_runtime: Path, target_runtime: Path, written: list[Path]) -> None:
    """把本进程的运行记录复制到新目录；目标里已有另一个活着的服务就拒绝。写下的文件记进 written。"""
    from character_workflow.lib.private_json import read_private_json, write_private_json
    from viewer_server.pid import cleanup_stale_pid, read_pid

    cleanup_stale_pid(target_runtime)
    other = read_pid(target_runtime)
    if other is not None and other != os.getpid():
        raise MoveRejected("这个数据目录正被另一个 Cobrush 服务使用，请先停止它")
    for name in _RUN_RECORDS:
        src, dst = source_runtime / name, target_runtime / name
        if not src.is_file():
            continue
        if name in _PRIVATE_RECORDS:
            write_private_json(dst, read_private_json(src))
        else:
            atomic_write_bytes(dst, src.read_bytes())
        written.append(dst)


@contextmanager
def _start_locks(source_runtime: Path, target_runtime: Path) -> Iterator[None]:
    """两边的 `server.start.lock`：交接运行记录时不让 CLI 的 start / stop 插进来读到一半。"""
    with ExitStack() as held:
        for runtime in (source_runtime, target_runtime):
            # 有限次重试（约 10 秒）：CLI 启动最多持锁 8 秒等服务应答。
            for _ in range(_START_LOCK_ATTEMPTS):
                attempt = ExitStack()
                if attempt.enter_context(try_file_lock(runtime / "server.start.lock")):
                    held.push(attempt.pop_all())
                    break
                attempt.close()
                time.sleep(_START_LOCK_DELAY)
            else:
                raise MoveRejected("Cobrush 服务正在启动或停止，请稍后再试")
        yield


def _commit(source: Path, target: Path, mode: str, on_switched: Callable[[], None],
            discard: Callable[[], None]) -> None:
    """切换提交；失败时退回旧目录并把迁移标成失败。调用方持着门闩。"""
    previous_pointer = data_root.read_global_config()
    previous_env = os.environ.get(_ENV_VAR)
    records: list[Path] = []
    switched = False
    try:
        if mode == "copy":
            _write_marker(target, "committing", source)
        with _start_locks(source / ".runtime", target / ".runtime"):
            _hand_over_records(source / ".runtime", target / ".runtime", records)
            data_root.write_global_config(target)
            os.environ[_ENV_VAR] = str(target)
            switched = True
            on_switched()  # 文件监听接管；起不来就抛错，整个切换退回
        # 指针已提交：这之后强退，启动时按 committing 标记补完。
        (target / INCOMPLETE_MARKER).unlink(missing_ok=True)
    except Exception as error:  # noqa: BLE001 —— 任何一步失败都退回旧目录
        _roll_back(previous_pointer, previous_env, records, switched, on_switched)
        discard()
        _fail(error, "切换到新目录时出错，已退回原目录")
        return
    _set(phase="done", finished_at=time.time())


def _roll_back(previous_pointer: str | None, previous_env: str | None, records: list[Path],
               switched: bool, on_switched: Callable[[], None]) -> None:
    for step in (
        lambda: data_root.restore_global_config(previous_pointer),
        lambda: _restore_env(previous_env),
        *[(lambda path=path: path.unlink(missing_ok=True)) for path in records],
        *([on_switched] if switched else []),  # 监听挪回旧目录
    ):
        try:
            step()
        except Exception:  # noqa: BLE001 —— 回滚尽力做完每一步
            logger.exception("data root move rollback step failed")


def _restore_env(previous: str | None) -> None:
    if previous is None:
        os.environ.pop(_ENV_VAR, None)
    else:
        os.environ[_ENV_VAR] = previous


def _fail(error: Exception, fallback: str) -> None:
    if isinstance(error, MoveRejected):
        reason = str(error)
    elif isinstance(error, OSError) and error.errno == 28:
        reason = "目标磁盘空间不足"
    elif isinstance(error, PermissionError):
        reason = "没有写入目标文件夹的权限"
    else:
        reason = fallback
    _set(phase="failed", error=reason, finished_at=time.time(),
         detail=f"{type(error).__name__}: {error}")


def _copy(source: Path, target: Path, created: bool, on_switched: Callable[[], None]) -> None:
    try:
        try:
            dirs, files, total = _plan(source)
            _set(total_bytes=total, total_files=len(files))
            target.mkdir(parents=True, exist_ok=True)
            _write_marker(target, "copying", source)
            for relative in dirs:
                (target / relative).mkdir(parents=True, exist_ok=True)
            rewriter = _PathRewriter(source, target)
            trash_json = _trash_json_items(source)
            rewritten: dict[Path, str] = {}
            copied = 0
            for index, relative in enumerate(files, start=1):
                src = source / relative
                (target / relative).parent.mkdir(parents=True, exist_ok=True)
                kind = trash_json.get(relative) or (
                    relative.suffix.casefold() if relative.suffix.casefold() in _REWRITE_SUFFIXES
                    else None)
                if _copy_file(src, target / relative, kind, rewriter):
                    rewritten[relative] = kind
                if not src.is_symlink():
                    copied += src.stat().st_size
                _set(copied_bytes=copied, copied_files=index)
            _set(phase="verifying")
            _verify(source, target, files, rewritten)
        except Exception as error:  # noqa: BLE001 —— 任何失败都要清掉半成品并报给界面
            _cleanup(target, created)
            _fail(error, "复制数据时出错")
            return
        _commit(source, target, "copy", on_switched, discard=lambda: _cleanup(target, created))
    finally:
        _unseal()


def start(target_text: str, *, busy: Callable[[], int] = lambda: 0,
          on_switched: Callable[[], None] = lambda: None) -> dict:
    """开始更换；直接切换的情形同步完成，复制在后台线程里跑。

    busy() 返回进行中的生成 / Agent / 网关任务数；先查一次快速拒绝，封住门闩、排空在途写请求后再查一次，
    这之间不会再有新工作进来。on_switched() 在指针提交后把文件监听挪到当前目录，抛错 = 切换失败、退回。"""
    global _state
    current = data_root.resolve_data_root().resolve()
    target = Path(target_text).expanduser().resolve()
    mode = classify(target, current)
    if mode == "same":
        return snapshot()
    if count := busy():
        raise MoveRejected(f"有 {count} 个生成正在进行，完成后再更换数据目录")
    _seal()
    try:
        if not _drain(_DRAIN_SECONDS):
            raise MoveRejected("还有修改正在保存，请稍后再更换数据目录")
        if count := busy():
            raise MoveRejected(f"有 {count} 个生成正在进行，完成后再更换数据目录")
        now = time.time()
        created = not target.exists()
        with _lock:
            _state = MoveState(phase="copying" if mode == "copy" else "verifying",
                               source=str(current), target=str(target), mode=mode, started_at=now)
    except BaseException:
        _unseal()
        raise
    if mode == "switch":
        try:
            _commit(current, target, "switch", on_switched, discard=lambda: None)
        finally:
            _unseal()
        return snapshot()
    try:
        threading.Thread(
            target=_copy, args=(current, target, created, on_switched),
            name="data-root-move", daemon=True,
        ).start()
    except BaseException:
        _unseal()
        raise
    return snapshot()
