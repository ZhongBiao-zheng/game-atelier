"""本机假厂商：按 (方法, 路径) 排队返回预设响应，记录收到的请求。自定义接口测试专用。"""
from __future__ import annotations

import io
import json
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from PIL import Image

MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 64


def png_bytes(color: str = "#336699") -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (32, 32), color).save(stream, format="PNG")
    return stream.getvalue()


@dataclass
class Received:
    method: str
    path: str
    query: str
    headers: dict[str, str]
    body: bytes

    def json(self):
        return json.loads(self.body)


class FakeVendor(ThreadingHTTPServer):
    def __init__(self, port: int = 0):
        super().__init__(("127.0.0.1", port), _Handler)
        self.routes: dict[tuple[str, str], list[tuple[int, object, dict]]] = {}
        self.received: list[Received] = []

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_port}"

    def on(self, method: str, path: str, *responses) -> None:
        """每个响应是 body 或 (status, body) 或 (status, body, headers)；最后一个重复使用。"""
        queue = []
        for item in responses:
            if not isinstance(item, tuple):
                item = (200, item, {})
            elif len(item) == 2:
                item = (*item, {})
            queue.append(item)
        self.routes[(method, path)] = queue

    def calls(self, method: str | None = None, path: str | None = None) -> list[Received]:
        return [r for r in self.received
                if (method is None or r.method == method) and (path is None or r.path == path)]

    def __enter__(self):
        self.thread = threading.Thread(target=self.serve_forever, kwargs={"poll_interval": 0.05},
                                       daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.shutdown()
        self.server_close()
        self.thread.join()


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _serve(self):
        server: FakeVendor = self.server  # type: ignore[assignment]
        parts = urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        server.received.append(Received(self.command, parts.path, parts.query,
                                        {k: v for k, v in self.headers.items()}, body))
        queue = server.routes.get((self.command, parts.path))
        if not queue:
            status, payload, headers = 404, {"error": {"message": "not found"}}, {}
        else:
            status, payload, headers = queue.pop(0) if len(queue) > 1 else queue[0]
        content = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream" if isinstance(payload, bytes)
                         else "application/json")
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    do_GET = _serve
    do_POST = _serve
