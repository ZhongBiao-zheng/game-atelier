"""Child process entry point. The requested checkout is on PYTHONPATH."""

import ipaddress
import json
import os
from pathlib import Path
import socket
import sys


def _loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def restrict_fake_network(ports):
    # Check DNS too: a refused HTTP connection must not send a public DNS query first.
    def audit(event, args):
        if event in {"socket.connect", "socket.sendto"}:
            sock, address = args
            if sock.family not in (socket.AF_INET, socket.AF_INET6):
                return
            if not _loopback(address[0]) or address[1] not in ports:
                raise PermissionError("仅允许本次评测的假上游")
        elif event in {"socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr"}:
            if args[0] is not None and not _loopback(args[0]):
                raise PermissionError("假上游评测禁止外部 DNS")

    sys.addaudithook(audit)


if __name__ == "__main__":
    if "ATELIER_EVAL_FAKE_PORTS" in os.environ:
        restrict_fake_network(set(json.loads(os.environ["ATELIER_EVAL_FAKE_PORTS"])))

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
        Path(sys.argv[1]).write_text(str(listener.getsockname()[1]), encoding="ascii")
        uvicorn.Server(config).run(sockets=[listener])
