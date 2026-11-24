"""Child process entry point. The requested checkout is on PYTHONPATH."""

import ipaddress
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import threading


def _loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


_pairing = threading.local()


def _allow_socketpair():
    # Windows has no native socketpair: Python emulates it by listening on a loopback port and
    # connecting to it, and asyncio needs one per event loop. That in-process connection must
    # pass; every other loopback port stays limited to the fake upstreams.
    original = socket.socketpair

    def socketpair(*args, **kwargs):
        _pairing.active = True
        try:
            return original(*args, **kwargs)
        finally:
            _pairing.active = False

    socket.socketpair = socketpair


def restrict_network(ports, preflight_marker):
    if os.name == "nt":
        _allow_socketpair()

    # Check DNS too: a refused HTTP connection must not send a public DNS query first.
    def audit(event, args):
        if event not in {
            "socket.connect",
            "socket.sendto",
            "socket.getaddrinfo",
            "socket.gethostbyname",
            "socket.gethostbyaddr",
        }:
            return
        checking = preflight_marker.exists()
        if not checking and ports is None:
            return
        if event in {"socket.connect", "socket.sendto"}:
            sock, address = args
            if sock.family not in (socket.AF_INET, socket.AF_INET6):
                return
            if getattr(_pairing, "active", False) and _loopback(address[0]):
                return
            if checking or not _loopback(address[0]) or address[1] not in ports:
                raise PermissionError("仅允许本次评测的假上游")
        elif event in {"socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr"}:
            if args[0] is not None and not _loopback(args[0]):
                raise PermissionError("假上游评测禁止外部 DNS")

    sys.addaudithook(audit)


def stop_if_parent_exits(port_file):
    # The evaluator is the only writer, and closes its pipe after a normal shutdown.
    # EOF here means it died without stopping us. An ongoing provider call must not
    # keep a non-daemon worker thread (and hence the isolated process) alive.
    try:
        while os.read(sys.stdin.fileno(), 1):
            pass
        root = port_file.parent
        if (
            root.name.startswith("atelier-agent-eval-")
            and port_file.name == "port"
            and str(root / "home") == os.environ.get("HOME")
            and str(root / "data") == os.environ.get("GAME_ATELIER_DATA_ROOT")
        ):
            (root / "data" / ".config" / "keys.json").unlink(missing_ok=True)
            shutil.rmtree(root, ignore_errors=True)
    finally:
        os._exit(1)


if __name__ == "__main__":
    port_file = Path(sys.argv[1])
    threading.Thread(target=stop_if_parent_exits, args=(port_file,), daemon=True).start()
    ports = os.environ.get("ATELIER_EVAL_FAKE_PORTS")
    restrict_network(
        set(json.loads(ports)) if ports is not None else None, port_file.with_name("preflight")
    )

    import uvicorn

    # A fresh data root needs no recovery. Skip the host's announcement, update and price
    # synchronizers; all measured agent behavior is driven through the public HTTP routes.
    config = uvicorn.Config(
        "viewer_server.server_app:build_app",
        factory=True,
        lifespan="off",
        loop="asyncio",
        log_level="error",
        access_log=False,
        timeout_graceful_shutdown=2,
    )
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port_file.write_text(str(listener.getsockname()[1]), encoding="ascii")
        uvicorn.Server(config).run(sockets=[listener])
