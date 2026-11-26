"""UDP LAN beacons announce only identity and port. Manifests come from their sender IP."""
from __future__ import annotations

import hashlib
import ipaddress
import logging
import os
import queue
import socket
import threading
import time
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

import httpx
from pydantic import BaseModel, Field

from character_workflow.lib import collab_config as config

log = logging.getLogger(__name__)
_NETWORKS = [ipaddress.IPv4Network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8")]
TTL = 12


def is_lan_ip(host: str) -> bool:
    try:
        ip = ipaddress.IPv4Address(host)
        return any(ip in network for network in _NETWORKS)
    except ValueError:
        return False


def lan_endpoint(value: str) -> str:
    host, sep, port = value.strip().partition(":")
    try:
        ip = ipaddress.IPv4Address(host)
        if not is_lan_ip(host):
            raise ValueError
        number = int(port) if sep and port.isascii() and port.isdigit() else (None if sep else config.DEFAULT_PORT)
        if number is None or not 1 <= number <= 65535:
            raise ValueError
    except ValueError as error:
        raise ValueError("请输入局域网 IPv4 地址及端口") from error
    return f"{ip}:{number}"


class Card(BaseModel):
    project_id: str = Field(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9_-]+$")
    name: str = Field(min_length=1, max_length=160)
    cover_version_id: str | None = Field(default=None, max_length=160)
    node_count: int = Field(ge=0)
    mode: Literal["view", "edit"]
    requires_passcode: bool
    allow_borrow_provider: bool
    online_count: int = Field(ge=0)
    updated_at: str = Field(max_length=64)


class Manifest(BaseModel):
    protocol_version: int
    host_id: UUID
    display_name: str = Field(max_length=40)
    shares: list[Card] = Field(max_length=1000)


class Beacon(BaseModel):
    proto: int
    host_id: UUID
    display_name: str = Field(max_length=40)
    port: int = Field(ge=1, le=65535)
    share_count: int = Field(ge=0, le=1000)
    revision: int
    ts: int


@dataclass
class Peer:
    address: str
    manifest: Manifest
    revision: int
    seen: float

    @property
    def key(self) -> str:
        return hashlib.sha256(f"{self.manifest.host_id}@{self.address}".encode()).hexdigest()[:32]

    def cards(self, *, is_self=False) -> list[dict]:
        return [
            {**row.model_dump(), "is_self": is_self, "peer_key": self.key,
             "protocol_version": self.manifest.protocol_version, "display_name": self.manifest.display_name}
            for row in self.manifest.shares
        ]


def fetch_manifest(address: str) -> Manifest:
    address = lan_endpoint(address)
    with httpx.Client(trust_env=False, follow_redirects=False, timeout=3) as client:
        with client.stream("GET", f"http://{address}/collab/v1/manifest",
                           headers={"Accept-Encoding": "identity"}) as response:
            response.raise_for_status()
            if response.headers.get("content-encoding", "identity") != "identity":
                raise ValueError("共享清单编码无效")
            data = bytearray()
            deadline = time.monotonic() + 5
            for chunk in response.iter_raw(65536):
                data.extend(chunk)
                if len(data) > 1024 * 1024 or time.monotonic() > deadline:
                    raise ValueError("共享清单过大")
    return Manifest.model_validate_json(data)


class Discovery:
    def __init__(self):
        self.lock = threading.Lock()
        self.peers: dict[str, Peer] = {}
        self._pending: set[str] = set()
        self._queue: queue.Queue = queue.Queue(maxsize=128)
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._socket: socket.socket | None = None
        self._port = 5182

    def probe(self, address: str, *, beacon: Beacon | None = None) -> Peer:
        address = lan_endpoint(address)
        manifest = fetch_manifest(address)
        if beacon and beacon.host_id != manifest.host_id:
            raise ValueError("共享主机身份已变更")
        peer = Peer(address, manifest, beacon.revision if beacon else -1, time.monotonic())
        if str(manifest.host_id) != config.read_config().host_id:
            with self.lock:
                if len(self.peers) >= 256 and address not in self.peers:
                    del self.peers[min(self.peers, key=lambda key: self.peers[key].seen)]
                self.peers[address] = peer
        return peer

    def online(self) -> list[Peer]:
        since = time.monotonic() - TTL
        with self.lock:
            return [p for p in self.peers.values() if p.seen >= since]

    def get(self, key: str) -> Peer:
        for peer in self.online():
            if peer.key == key:
                if peer.manifest.protocol_version != config.COLLAB_PROTOCOL_VERSION:
                    raise ValueError("对方版本不兼容，请更新")
                return peer
        raise KeyError("房主已离线")

    def forget(self, address: str) -> None:
        with self.lock:
            self.peers.pop(address, None)

    def _enqueue(self, address: str, beacon: Beacon | None) -> None:
        with self.lock:
            if address in self._pending or self._queue.full():
                return
            self._pending.add(address)
            self._queue.put_nowait((address, beacon))

    def on_beacon(self, packet: bytes, sender: str, host_id: str) -> None:
        if len(packet) > 1200:
            return
        try:
            beacon = Beacon.model_validate_json(packet)
            address = lan_endpoint(f"{sender}:{beacon.port}")
        except ValueError:
            return
        if str(beacon.host_id) == host_id:
            return
        with self.lock:
            peer = self.peers.get(address)
            if peer and peer.manifest.host_id == beacon.host_id:
                if not beacon.share_count:
                    del self.peers[address]
                    return
                if peer.revision == beacon.revision:
                    peer.seen = time.monotonic()
                    return
        if beacon.share_count:
            self._enqueue(address, beacon)

    @property
    def active(self):
        return bool(self._threads)

    def start(self, beacon_factory, addresses) -> None:
        if self._threads:
            return
        self._port = int(os.environ.get("GAME_ATELIER_COLLAB_DISCOVERY_PORT", "5182"))
        self._stop.clear()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if hasattr(socket, "SO_REUSEPORT"):
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.bind(("", self._port))
            sock.settimeout(.25)
            self._socket = sock
        except OSError:
            sock.close()
            log.warning("共享画布 UDP 发现暂时不可用，手动连接仍然可用")
        self._addresses = addresses
        self._beacon_factory = beacon_factory
        host_id = config.read_config().host_id
        self._threads = [threading.Thread(target=self._maintain, daemon=True, name="collab-discovery"),
                         threading.Thread(target=self._worker, daemon=True, name="collab-manifests")]
        if self._socket:
            self._threads.append(threading.Thread(target=self._receive, args=(sock, host_id),
                                                  daemon=True, name="collab-beacons"))
        for thread in self._threads:
            thread.start()

    def broadcast(self, beacon: Beacon | None) -> None:
        sock = self._socket
        if beacon is None or sock is None:
            return
        body = beacon.model_dump_json().encode()
        # Limited broadcast works across subnet sizes. Directed broadcasts also reach local
        # Ethernet adapters on machines whose preferred route belongs to a VPN.
        destinations = {"255.255.255.255"}
        for host in self._addresses():
            destinations.add(str(ipaddress.IPv4Network(f"{host}/24", strict=False).broadcast_address))
        for dest in destinations:
            try:
                sock.sendto(body, (dest, self._port))
            except OSError:
                pass

    def _receive(self, sock: socket.socket, host_id: str) -> None:
        while not self._stop.is_set():
            try:
                data, (sender, _) = sock.recvfrom(1201)
            except socket.timeout:
                continue
            except OSError:
                break
            self.on_beacon(data, sender, host_id)

    def _maintain(self):
        next_poll = 0.
        while not self._stop.is_set():
            try:
                self.broadcast(self._beacon_factory())
                if time.monotonic() >= next_poll:
                    for address in config.read_config().manual_peers:
                        self._enqueue(address, None)
                    next_poll = time.monotonic() + 10
            except (ValueError, OSError):
                log.warning("共享画布发现暂时不可用")
            self._stop.wait(3)

    def _worker(self):
        while not self._stop.is_set():
            try:
                address, beacon = self._queue.get(timeout=.25)
            except queue.Empty:
                continue
            try:
                self.probe(address, beacon=beacon)
            except (httpx.HTTPError, OSError, ValueError):
                if beacon is None:
                    self.forget(address)
            finally:
                with self.lock:
                    self._pending.discard(address)

    def stop(self) -> None:
        self._stop.set()
        if self._socket:
            self._socket.close()
        for thread in self._threads:
            thread.join()
        self._socket = None
        self._threads.clear()
        with self.lock:
            self.peers.clear()
            self._pending.clear()
            self._queue = queue.Queue(maxsize=128)


discovery = Discovery()
