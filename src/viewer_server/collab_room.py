"""In-process canvas rooms shared by the host loopback and LAN ASGI event loops."""
from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass, field

from character_workflow.lib import data_root
from character_workflow.lib.canvas_projects import canvas_project_dir
from character_workflow.lib.collab_sanitize import public_document


@dataclass(eq=False)
class Member:
    client_id: str
    display_name: str
    owner: bool
    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(64))
    color_index: int = 0
    selected: list[str] = field(default_factory=list)
    positions: dict = field(default_factory=dict)

    def public(self):
        return {"client_id": self.client_id, "display_name": self.display_name,
                "role": "owner" if self.owner else "guest", "color_index": self.color_index,
                "selected_node_ids": self.selected, "positions": self.positions}

    def offer(self, event):
        if self.queue.full():
            # A slow consumer must reconnect for a fresh snapshot rather than miss a mutation.
            while not self.queue.empty():
                self.queue.get_nowait()
            self.queue.put_nowait({"type": "room_closed", "reason": "同步积压，请重连"})
            return
        self.queue.put_nowait(event)


class Room:
    def __init__(self, project_id):
        self.project_id = project_id
        self.lock = threading.RLock()
        self.members: set[Member] = set()
        self.revision = -1
        self.mtime = None
        self.document = None

    def join(self, member):
        with self.lock:
            used = {m.color_index for m in self.members}
            member.color_index = next((i for i in range(6) if i not in used), len(self.members) % 6)
            self.members.add(member)
            self._presence()

    def leave(self, member):
        with self.lock:
            self.members.discard(member)
            self._presence()

    def list_members(self):
        with self.lock:
            return [m.public() for m in sorted(self.members, key=lambda m: (not m.owner, m.client_id))]

    def update_presence(self, member, selected, positions):
        with self.lock:
            member.selected, member.positions = selected, positions
            self._presence()

    def _presence(self):
        self.broadcast({"type": "presence_state", "members": self.list_members()})

    def broadcast(self, event, clients=None):
        with self.lock:
            for member in self.members:
                if clients is None or member.client_id in clients:
                    if not member.loop.is_closed():
                        member.loop.call_soon_threadsafe(member.offer, event)

    def refresh(self, *, notify=True):
        """Local editor, runner and Agent all publish through the same atomic document file."""
        with self.lock:
            path = canvas_project_dir(self.project_id) / "canvas.json"
            stat = path.stat()
            stamp = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
            if self.mtime == stamp and self.document is not None:
                return self.document
            doc = public_document(self.project_id)
            if notify and self.revision >= 0 and self.revision != doc["revision"]:
                self.broadcast({"type": "document_sync", "document": doc, "revision": doc["revision"]})
            self.mtime, self.revision, self.document = stamp, doc["revision"], doc
            return doc

    def apply(self, raw, member, authorize):
        from character_workflow.lib.collab_ops import apply_op
        from character_workflow.lib import data_root_move
        from fastapi import HTTPException

        if not data_root_move.enter_write():
            raise HTTPException(409, "正在迁移数据目录")
        try:
            with self.lock:
                previous = self.refresh()
                result = apply_op(self.project_id, raw, client_id=member.client_id,
                                  actor_name=member.display_name, owner=member.owner, authorize=authorize)
                doc = self.refresh(notify=False)
                event = {"type": "op_applied", "op_id": raw["op_id"], "client_id": member.client_id,
                         "revision": doc["revision"], "touched_node_ids": sorted(result.touched_node_ids)}
                if result.duplicate or result.revision != doc["revision"]:
                    event["document"] = doc
                else:
                    event["base_revision"] = previous["revision"]
                    event["delta"] = document_delta(previous, doc)
                self.broadcast(event, {member.client_id} if result.duplicate else None)
                if result.conflict_clients:
                    self.broadcast({"type": "conflict_notice", "node_ids": sorted(result.touched_node_ids),
                                    "by": member.display_name}, result.conflict_clients)
        finally:
            data_root_move.leave_write()


def document_delta(previous, current):
    delta = {"updated_at": current["updated_at"]}
    for section in ("nodes", "connections"):
        before = {row["id"]: row for row in previous[section]}
        after = {row["id"]: row for row in current[section]}
        delta[section] = [row for key, row in after.items() if before.get(key) != row]
        delta["removed_" + section] = list(before.keys() - after.keys())
    delta["content_versions"] = {key: value for key, value in current["content_versions"].items()
                                 if previous["content_versions"].get(key) != value}
    return delta


_rooms = {}
_registry_lock = threading.Lock()


def join(project_id, member):
    key = data_root.resolve_data_root(), project_id
    with _registry_lock:
        room = _rooms.setdefault(key, Room(project_id))
        room.join(member)
        return room


def release(room, member):
    with _registry_lock:
        room.leave(member)
        if not room.members:
            _rooms.pop((data_root.resolve_data_root(), room.project_id), None)


def close_room(project_id, reason):
    with _registry_lock:
        room = _rooms.get((data_root.resolve_data_root(), project_id))
        if room:
            room.broadcast({"type": "room_closed", "reason": reason})
