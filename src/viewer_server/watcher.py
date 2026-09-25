"""watchdog FSEvents handler — 监听 .runtime/jobs/ / characters/ / 图片目录 → SSE 广播。
macOS 用 FSEvents（默认）；Linux 用 inotify；显式不用 PollingObserver。
"""
from __future__ import annotations

import itertools
import json
import logging
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from character_workflow.lib import data_root
from viewer_server.sse import hub

if TYPE_CHECKING:
    from character_workflow.lib.schemas import TeamLibraryIndex, TeamLibraryMount

logger = logging.getLogger(__name__)


class JobsHandler(FileSystemEventHandler):
    # jobs 文件全部走 tmp+replace 原子写；inotify（Linux）对 replace 发的是 moved，
    # mac FSEvents 合并成 modified —— 不补 on_moved 在 Linux 上会整体丢推送。
    def on_modified(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path, event.is_directory)

    def on_created(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path, event.is_directory)

    def on_moved(self, event: FileSystemEvent) -> None:
        dest = getattr(event, "dest_path", "") or event.src_path
        self._emit(dest, event.is_directory)

    def _emit(self, raw_path: str, is_dir: bool) -> None:
        if is_dir:
            return
        p = Path(raw_path)
        if p.suffix != ".json" or p.name.endswith(".tmp"):
            return
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return
        hub.broadcast("job-changed", {
            "job_id": data.get("job_id"),
            "status": data.get("status"),
        })


class CharactersHandler(FileSystemEventHandler):
    # Skill / routes 用 atomic replace（tmp.replace），FSEvents 可能只发
    # on_moved 或 on_created，不补全这两个 hook 就会漏掉 spec 改动。
    def on_modified(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path, event.is_directory)

    def on_created(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path, event.is_directory)

    def on_moved(self, event: FileSystemEvent) -> None:
        dest = getattr(event, "dest_path", "") or event.src_path
        self._emit(dest, event.is_directory)

    def _emit(self, raw_path: str, is_dir: bool) -> None:
        if is_dir:
            return
        p = Path(raw_path)
        if p.name != "spec.md":
            return
        hub.broadcast("spec-changed", {"character_id": p.parent.name})


class WorkshopRequestsHandler(JobsHandler):
    def _emit(self, raw_path: str, is_dir: bool) -> None:
        path = Path(raw_path)
        if is_dir or path.suffix != ".json" or not path.stem.startswith("wr-"):
            return
        hub.broadcast("workshop-request-changed", {"request_id": path.stem})


class ProjectsHandler(FileSystemEventHandler):
    def on_modified(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path)

    def on_created(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path)

    def on_moved(self, event: FileSystemEvent) -> None:
        dest = getattr(event, "dest_path", "") or event.src_path
        self._emit(dest)

    def _emit(self, raw_path: str) -> None:
        if Path(raw_path).name != "projects.json":
            return
        hub.broadcast("projects-changed", {})


class ActiveCharacterHandler(FileSystemEventHandler):
    # 同 JobsHandler：原子写在 Linux 上发 moved；首次写 active 文件是 created。
    def on_modified(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path)

    def on_created(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path)

    def on_moved(self, event: FileSystemEvent) -> None:
        dest = getattr(event, "dest_path", "") or event.src_path
        self._emit(dest)

    def _emit(self, raw_path: str) -> None:
        p = Path(raw_path)
        if p.name != "active-character.json":
            return
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return
        hub.broadcast("active-character-changed", {"active_id": data.get("active_id")})


class CanvasDocumentsHandler(FileSystemEventHandler):
    # 画布文档 canvas.json 也是 tmp+replace 原子写：Linux 发 moved，首次建项目是 created。
    # Agent（canvas_apply_changes / import_media / run）与浏览器都经 save_canvas_document 落盘，
    # 只盯文件就能覆盖全部写入方；浏览器拿到事件后按 revision 决定要不要重载。
    def on_modified(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path, event.is_directory)

    def on_created(self, event: FileSystemEvent) -> None:
        self._emit(event.src_path, event.is_directory)

    def on_moved(self, event: FileSystemEvent) -> None:
        dest = getattr(event, "dest_path", "") or event.src_path
        self._emit(dest, event.is_directory)

    def _emit(self, raw_path: str, is_dir: bool) -> None:
        if is_dir:
            return
        p = Path(raw_path)
        if p.name != "canvas.json":
            return
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        hub.broadcast("canvas-document-changed", {
            "project_id": p.parent.name,
            "revision": data.get("revision"),
        })


class ImagesHandler(FileSystemEventHandler):
    def __init__(self, character_resolver):
        self._resolve = character_resolver

    def on_created(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        p = Path(event.src_path)
        if p.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            return
        cid = self._resolve(p)
        hub.broadcast("image-added", {"character_id": cid, "path": str(p)})


class TeamLibraryHandler(FileSystemEventHandler):
    """挂载目录任何变化 → 防抖后全量重扫 → 按 diff 广播 team-library-changed。

    团队库是活的 SVN / 网盘工作副本：一次 update 会发出成百上千条事件，逐条解析没有意义，
    也测不准（FSEvents 会合并）。这里只把事件当「有动静」的信号，真值永远来自一次全量重扫。
    """

    def __init__(self, mount, delay: float = 2.0):
        self.mount = mount
        self.delay = delay
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()

    def on_any_event(self, event: FileSystemEvent) -> None:
        # .svn / .git 内部每次同步都在改写，扫描本就剪枝掉了它们，别让它们持续拖住防抖。
        root_parts = len(Path(self.mount.mount_path).parts)
        parts = Path(event.src_path).parts[root_parts:]
        if any(part.startswith(".") for part in parts):
            return
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(self.delay, self.rescan)
            self._timer.daemon = True
            self._timer.start()

    def cancel(self) -> None:
        """取消还没跑的那次重扫（卸载 / 停服）。"""
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None

    def rescan(self) -> None:
        from character_workflow.lib import team_library as tl

        # 目录掉线不能当成「库空了」：scan_library 对不存在的目录不抛 OSError，
        # 它只会返回空索引（is_dir() 假 → 空列表；os.walk 缺目录静默跳过）。
        # 照扫就会把缓存索引清空并广播一整轮 removed，网盘一抖画师的库就「全没了」。
        if not tl.library_reachable(self.mount):
            return
        refresh_team_library(self.mount)


_refresh_guard = threading.Lock()
_refresh_locks: dict[str, threading.Lock] = {}
# 每次刷新开扫前领一张递增票；落盘时只让「开扫更晚」的结果覆盖，见 refresh_team_library。
_scan_tickets = itertools.count()
_committed_tickets: dict[str, int] = {}


def _refresh_lock(library_id: str) -> threading.Lock:
    with _refresh_guard:
        return _refresh_locks.setdefault(library_id, threading.Lock())


def _next_ticket() -> int:
    with _refresh_guard:
        return next(_scan_tickets)


def refresh_team_library(mount: TeamLibraryMount) -> TeamLibraryIndex:
    """全量重扫 → 读旧索引、落盘、按 diff 逐条广播 team-library-changed，返回最新索引。

    扫描在锁外：网盘上整库扫描是秒级甚至更久，持锁扫描会让分享路由写完后的刷新一直排在
    启动补扫 / 防抖重扫后面。锁只护「读旧索引 → 写新索引 → 广播」这一段——同一个库两次刷新
    各自读到同一份旧索引，就会把同一条 added 广播两遍。

    扫描并发之后，先开扫的可能后扫完：它看到的目录更旧，落盘就会把新分享的资产盖掉、
    广播一条假 removed。所以按开扫顺序领票，已经有更晚开扫的结果落盘时，这次结果作废，
    直接返回已落盘的那份（它开扫时本次调用方要看的写入已经完成了）。
    调用方负责先判可达（不可达时扫出的是空索引，见 TeamLibraryHandler.rescan）。
    """
    from character_workflow.lib import team_library_index as idx
    from character_workflow.lib.schemas import TeamLibraryChangeEvent

    ticket = _next_ticket()
    after = idx.build_index(mount)
    with _refresh_lock(mount.library_id):
        if _committed_tickets.get(mount.library_id, -1) > ticket:
            return idx.read_index(mount.library_id) or after
        before = idx.read_index(mount.library_id)
        idx.write_index(after)
        _committed_tickets[mount.library_id] = ticket
        for change in idx.diff_index(before, after):
            event = TeamLibraryChangeEvent(library_id=mount.library_id, **change)
            hub.broadcast("team-library-changed", event.model_dump(mode="json"))
    return after


_observer: Observer | None = None
_team_watches: dict[str, object] = {}
_team_handlers: dict[str, TeamLibraryHandler] = {}


def watch_team_library(mount) -> None:
    """同一 library_id 只监听一条路径；路径变了（重挂到别的画布 / 盘符变了）就换过去。

    schedule 失败（目录此刻不可达）不记录：下次挂载 / rescan / 卸载同步时会再试。
    """
    if _observer is None:
        return
    current = _team_handlers.get(mount.library_id)
    if current is not None and current.mount.mount_path == mount.mount_path:
        return
    if current is not None:
        unwatch_team_library(mount.library_id)
    handler = TeamLibraryHandler(mount)
    try:
        _team_watches[mount.library_id] = _observer.schedule(
            handler, mount.mount_path, recursive=True
        )
        _team_handlers[mount.library_id] = handler
    except OSError:
        pass


def sync_team_library_watch(library_id: str) -> None:
    """按挂载表把某个库的监听对齐到 get_mount 选中的那条；已无挂载就停掉。"""
    from character_workflow.lib import team_library as tl

    try:
        mount = tl.get_mount(library_id)
    except KeyError:
        unwatch_team_library(library_id)
        return
    watch_team_library(mount)


def sync_team_library_watches() -> None:
    """全量对齐：挂载表里的每个库监听 get_mount 选中的路径，已不在表里的停掉。"""
    from character_workflow.lib import team_library as tl

    try:
        mounted = {mount.library_id for mount in tl.list_mounts()}
    except ValueError:
        # 挂载表坏了只影响团队库监听，不该拦住启动 / 删画布（路由层会把它报成 500）。
        return
    for library_id in sorted(mounted | set(_team_handlers)):
        sync_team_library_watch(library_id)


def unwatch_team_library(library_id: str) -> None:
    watch = _team_watches.pop(library_id, None)
    handler = _team_handlers.pop(library_id, None)
    if handler is not None:
        # 先取消待跑的防抖重扫：卸载后再跑一次就是对着一个已经不该看的目录写缓存。
        handler.cancel()
    if _observer is not None and watch is not None:
        try:
            _observer.unschedule(watch)
        except KeyError:
            pass


def stop_team_library_watches() -> None:
    """停服：取消全部待跑重扫，别让 daemon timer 在解释器关闭时才醒。"""
    for handler in list(_team_handlers.values()):
        handler.cancel()
    _team_handlers.clear()
    _team_watches.clear()


def _rescan_one(library_id: str) -> None:
    from character_workflow.lib import team_library as tl

    try:
        mount = tl.get_mount(library_id)
        # 不可达时 scan_library 扫出空索引：照扫就是广播一整轮 removed（见 TeamLibraryHandler）。
        if tl.library_reachable(mount):
            refresh_team_library(mount)
    except Exception:
        logger.exception("团队库 %s 启动补扫失败", library_id)


def rescan_team_libraries() -> list[threading.Thread]:
    """启动补扫：每个库在自己的 daemon 线程里重扫一次，按 diff 广播停服期间的变化。

    有旧索引只发增量（diff_index），没有就静默建索引——不会把整库当新分享刷一遍。顺带让 P3 之前
    的老缓存补上 input_sha256。每个库单独一条线程且不 join：死掉的网盘上连 library_reachable
    的 is_dir() 都可能挂住，串行就会让后面的库全部等它。任何一个库失败只记日志。
    返回启动的线程，只给测试 join 用。
    """
    from character_workflow.lib import team_library as tl

    try:
        library_ids = sorted({mount.library_id for mount in tl.list_mounts()})
    except (ValueError, OSError) as error:
        logger.warning("团队库启动补扫跳过：读不了挂载记录（%s）", error)
        return []
    threads = [
        threading.Thread(
            target=_rescan_one, args=(library_id,),
            name=f"team-library-rescan-{library_id}", daemon=True,
        )
        for library_id in library_ids
    ]
    for thread in threads:
        thread.start()
    return threads


def _start_team_library_rescan() -> None:
    # 整库扫描是秒级（网盘上更久），放后台线程，别拖住 server 启动。
    threading.Thread(
        target=rescan_team_libraries, name="team-library-startup-rescan", daemon=True
    ).start()


def start_watchers() -> Observer:
    runtime = data_root.runtime_dir()
    project_root = data_root.resolve_data_root()

    observer = Observer()

    jobs_dir = runtime / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    observer.schedule(JobsHandler(), str(jobs_dir), recursive=False)
    requests_dir = runtime / "workshop" / "requests"
    requests_dir.mkdir(parents=True, exist_ok=True)
    observer.schedule(WorkshopRequestsHandler(), str(requests_dir), recursive=False)

    runtime.mkdir(parents=True, exist_ok=True)
    observer.schedule(ActiveCharacterHandler(), str(runtime), recursive=False)
    observer.schedule(ProjectsHandler(), str(runtime), recursive=False)

    chars_dir = project_root / "characters"
    # 启动时目录可能尚不存在（全新安装）——不先建好就 schedule 不上，
    # 首个角色的 spec-changed / image-added 会一直不广播，直到重启。
    chars_dir.mkdir(parents=True, exist_ok=True)
    # recursive=True: spec.md 现在嵌在 characters/<id>/ 下，FSEvents 不递归看不见。
    observer.schedule(CharactersHandler(), str(chars_dir), recursive=True)

    canvases_dir = data_root.canvases_dir()
    canvases_dir.mkdir(parents=True, exist_ok=True)
    # recursive=True：canvas.json 在 canvases/<project_id>/ 下；媒体文件也在里面，靠文件名过滤。
    observer.schedule(CanvasDocumentsHandler(), str(canvases_dir), recursive=True)

    cfg_path = runtime / "config.json"
    if cfg_path.exists():
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        image_root = cfg.get("image_storage_root", "")
        if image_root:
            try:
                Path(image_root).mkdir(parents=True, exist_ok=True)
                observer.schedule(
                    ImagesHandler(lambda p: p.parent.name),
                    image_root, recursive=True,
                )
            except OSError:
                # config 里的路径建不出来（权限/挂载盘掉了）→ 跳过该 watcher，不拦启动。
                pass

    global _observer
    _observer = observer
    stop_team_library_watches()
    sync_team_library_watches()

    observer.start()
    # 监听建好之后再补扫：补扫期间库里的新变化由监听接住，不会漏在两者之间。
    _start_team_library_rescan()
    return observer
