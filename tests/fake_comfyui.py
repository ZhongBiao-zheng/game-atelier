"""HTTP fixture matching ComfyUI server.py / execution.py response envelopes.

Run directly for browser QA: uv run python tests/fake_comfyui.py --port 18188
"""
from __future__ import annotations

import argparse
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from PIL import Image


class FakeComfyUI(ThreadingHTTPServer):
    def __init__(self, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.prompts = {}
        self.uploads = []
        self.deleted = []
        self.completed = set()
        self.interrupted = []
        self.mode = "success"
        self.polls = 0
        self.delay = 2
        self.foreign_running = True
        stream = io.BytesIO()
        Image.new("RGB", (64, 64), "#669988").save(stream, format="PNG")
        self.png = stream.getvalue()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_port}"

    def __enter__(self):
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.shutdown()
        self.server_close()
        self.thread.join()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, data, status=200):
        content = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "image/png" if isinstance(data, bytes) else "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        path = urlsplit(self.path).path
        state = self.server
        if path == "/system_stats":
            return self.respond({"system": {"comfyui_version": "test"}, "devices": [
                {"name": "Fake GPU", "type": "cuda", "index": 0, "vram_total": 16 * 1024**3,
                 "vram_free": 12 * 1024**3}]})
        if path.startswith("/object_info"):
            kind = path.rsplit("/", 1)[-1]
            return self.respond({kind: {"input": {"required": {
                "steps": ["INT", {"default": 20, "min": 1, "max": 10000}],
                "lora_name": [["example.safetensors"]],
                "sampler_name": [["euler", "dpmpp_2m"]],
                "strength_model": ["FLOAT", {"min": -10, "max": 10, "step": 0.01}],
            }}, "output_node": kind == "SaveImage"}})
        if path == "/queue":
            rows = [[index, identifier, payload["prompt"], {}, ["9"]]
                    for index, (identifier, payload) in enumerate(state.prompts.items())
                    if identifier not in state.deleted and identifier not in state.completed]
            running = [[-1, "someone-else", {}, {}, []]] if state.foreign_running else []
            if state.polls > state.delay and rows and state.mode != "timeout":
                running, rows = rows[:1], rows[1:]
            elif state.polls > state.delay and rows and not state.foreign_running:
                running, rows = rows[:1], rows[1:]
            return self.respond({"queue_running": running, "queue_pending": rows})
        if path.startswith("/history/"):
            state.polls += 1
            identifier = path.rsplit("/", 1)[-1]
            if state.mode == "timeout" or state.polls <= state.delay + 1:
                return self.respond({})
            state.completed.add(identifier)
            status = {"status_str": "success", "completed": True, "messages": []}
            if state.mode == "error":
                status = {"status_str": "error", "completed": False, "messages": [
                    ["execution_error", {"node_id": "3", "exception_message": "fake execution error"}]]}
            return self.respond({identifier: {"status": status, "outputs": {"9": {"images": [
                {"filename": "result.png", "subfolder": "atelier", "type": "output"},
                {"filename": "preview.png", "subfolder": "", "type": "temp"}]}}}})
        if path == "/view":
            return self.respond(state.png)
        self.respond({}, 404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        state = self.server
        if self.path == "/upload/image":
            state.uploads.append(body)
            return self.respond({"name": f"uploaded-{len(state.uploads)}.png",
                                 "subfolder": "", "type": "input"})
        data = json.loads(body or b"{}")
        if self.path == "/prompt":
            identifier = f"prompt-{len(state.prompts) + 1}"
            state.prompts[identifier] = data
            state.polls = 0
            return self.respond({"prompt_id": identifier, "number": len(state.prompts), "node_errors": {}})
        if self.path == "/queue":
            state.deleted.extend(data.get("delete", []))
            return self.respond(b"")
        if self.path == "/interrupt":
            state.interrupted.append(data.get("prompt_id"))
            return self.respond(b"")
        self.respond({}, 404)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18188)
    args = parser.parse_args()
    with FakeComfyUI(args.port) as server:
        print(server.url, flush=True)
        threading.Event().wait()
