"""Deterministic loopback provider. Decisions use chat messages, never the grading rubric."""

import base64
import io
import json
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw


def illustration(w, h, red=False):
    image = Image.new("RGB", (w, h), "#eadfc6")
    draw = ImageDraw.Draw(image)
    draw.ellipse((w * 0.65, h * 0.08, w * 0.65 + h * 0.27, h * 0.35), fill="#cc764c")
    for x, y in [(0, 0.48), (0.35, 0.30), (0.8, 0.42)]:
        draw.polygon([(w * (x - 0.45), h), (w * x, h * y), (w * (x + 0.4), h)], fill="#627d79")
    draw.polygon(
        [(0, h * 0.83), (w * 0.48, h * 0.60), (w, h * 0.8), (w, h), (0, h)], fill="#324e50"
    )
    color = "#be5543" if red else "#c99e64"
    for x in (0.25, 0.5, 0.75):
        draw.ellipse((w * x - h * 0.04, h * 0.37, w * x + h * 0.04, h * 0.45), fill="#272e30")
        draw.polygon(
            [(w * x, h * 0.44), (w * x - h * 0.11, h * 0.76), (w * x + h * 0.07, h * 0.76)],
            fill=color,
        )
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


def reply(messages, tools):
    last_user = max(i for i, msg in enumerate(messages) if msg["role"] == "user")
    content = messages[last_user]["content"]
    text = (
        content
        if isinstance(content, str)
        else " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    )
    calls = [c for m in messages[last_user + 1 :] for c in m.get("tool_calls", [])]
    used = [c["function"]["name"] for c in calls]
    canvas = any(tool.get("function", {}).get("name") == "get_canvas" for tool in tools)
    prompt = text.split("图1 upload:")[0].strip()
    args = {
        "kind": "image",
        "alias": "eval",
        "model": "gpt-image-1",
        "prompt": prompt,
        "count": 1,
        "params": {"ratio": "16:9"},
    }
    if prompt.strip() == "帮我做个图":
        return None, "你想要角色立绘、场景概念图，还是活动海报？"
    if match := re.search(r"(\d+)\s*张\s*(\d+)x(\d+)", prompt):
        args.update(count=int(match[1]), params={"size": f"{match[2]}x{match[3]}"})
    if "竖版" in prompt:
        args["params"] = {"ratio": "9:16"}
    if "拔剑" in prompt and "秒" in prompt:
        args.update(kind="video", model="kling-v2", params={"duration": 5})
    refs = re.findall(r"upload:[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?", text)
    if refs:
        args["references"] = [{"media_ref": ref} for ref in refs]
    if "披风" in text:
        for m in reversed(messages[:last_user]):
            match = re.search(r"studio-[a-f0-9]{32}", str(m.get("content")))
            if m["role"] == "tool" and match:
                args["references"] = [{"media_ref": "output:" + match[0] + ":0"}]
                break
    if canvas and "get_canvas" not in used:
        return "get_canvas", {}
    if canvas and "apply_changes" not in used:
        arguments = {
            "changes": [
                {
                    "op": "add_surface",
                    "kind": "image",
                    "node_id": "eval-art",
                    "title": "创作结果",
                    "position": {"x": 420, "y": 0},
                },
                {
                    "op": "set_draft",
                    "mode": "image",
                    "node_id": "eval-art",
                    "alias": "eval",
                    "model": "gpt-image-1",
                    "prompt": prompt,
                    "params": {"ratio": "16:9"},
                },
            ]
        }
        for message in messages[last_user + 1 :]:
            if message.get("role") == "tool":
                try:
                    document = json.loads(message["content"])
                except (ValueError, TypeError):
                    continue
                for node in document.get("nodes", []):
                    if node.get("type") == "image":
                        arguments["changes"].append(
                            {
                                "op": "connect",
                                "source_node_id": node["id"],
                                "target_node_id": "eval-art",
                            }
                        )
                break
        return "apply_changes", arguments
    if "run_generations" not in used:
        item = {"surface_node_id": "eval-art", "count": 1} if canvas else args
        return "run_generations", {"items": [item]}
    return None, "已完成本轮创作。"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_payload(self, payload, mime):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/eval-clip.mp4":
            clip = Path(__file__).resolve().parents[2] / "tests/fixtures/video/h264-24f.mp4"
            self.send_payload(clip.read_bytes(), "video/mp4")
        elif self.path.startswith("/kling/v1/videos/"):
            url = f"http://127.0.0.1:{self.server.server_port}/eval-clip.mp4"
            self.send_payload(
                json.dumps(
                    {"data": {"task_status": "succeed", "task_result": {"videos": [{"url": url}]}}}
                ).encode(),
                "application/json",
            )
        else:
            self.send_error(404)

    def do_POST(self):
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path.startswith("/kling/v1/videos/"):
            self.send_payload(
                json.dumps({"data": {"task_id": secrets.token_hex(8)}}).encode(), "application/json"
            )
            return
        if self.path.split("?")[0].endswith(("/images/generations", "/images/edits")):
            red = "红色".encode() in data or b"\\u7ea2" in data
            request = (
                json.loads(data) if self.headers.get_content_type() == "application/json" else {}
            )
            size = (
                (1024, 1536)
                if b"1024x1536" in data
                else (360, 640)
                if "竖版".encode() in data
                else (640, 360)
            )
            encoded = base64.b64encode(illustration(*size, red)).decode()
            copies = min(4, max(1, int(request.get("n", 1))))
            self.send_payload(
                json.dumps({"data": [{"b64_json": encoded}] * copies}).encode(), "application/json"
            )
            return
        if self.path.split("?")[0] != "/v1/chat/completions":
            self.send_error(404)
            return
        body = json.loads(data)
        tool, value = reply(body["messages"], body.get("tools", []))
        if tool:
            delta = {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_" + secrets.token_hex(8),
                        "type": "function",
                        "function": {"name": tool, "arguments": json.dumps(value)},
                    }
                ]
            }
        else:
            delta = {"content": value}
        frame = {
            "id": "chat-eval",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": body["model"],
        }
        chunks = [
            {
                "choices": [
                    {"index": 0, "delta": {"role": "assistant", **delta}, "finish_reason": None}
                ]
            },
            {
                "choices": [
                    {"index": 0, "delta": {}, "finish_reason": "tool_calls" if tool else "stop"}
                ]
            },
            {
                "choices": [],
                "usage": {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150},
            },
        ]
        stream = "".join("data: " + json.dumps({**frame, **c}) + "\n\n" for c in chunks)
        self.send_payload((stream + "data: [DONE]\n\n").encode(), "text/event-stream")


class FakeProvider(ThreadingHTTPServer):
    def __init__(self, models):
        super().__init__(("127.0.0.1", 0), Handler)
        channels = {"eval": []}
        for entry in models:
            alias, model = entry.split("/", 1)
            channels.setdefault(alias, []).append(
                {
                    "id": model,
                    "name": model,
                    "modality": "text",
                    "protocol": "openai-chat",
                    "input_cny_per_m": 2,
                    "output_cny_per_m": 8,
                }
            )
        channels["eval"].append(
            {
                "id": "gpt-image-1",
                "name": "Eval Image",
                "modality": "image",
                "protocol": "openai",
                "per_call_cny": 0.25,
            }
        )
        channels["eval"].append(
            {
                "id": "kling-v2",
                "name": "Eval Video",
                "modality": "video",
                "protocol": "kling",
                "per_call_cny": 1.0,
            }
        )
        self.token = "eval-fixture-" + secrets.token_hex(20)
        self.keys = {
            "keys": [
                {
                    "alias": alias,
                    "provider": "custom",
                    "models": specs,
                    "base_url": f"http://127.0.0.1:{self.server_port}/v1",
                    "access_key": self.token,
                    "created_at": "2026-01-01",
                    "text_protocol": "openai-chat",
                }
                for alias, specs in channels.items()
            ]
        }

    def __enter__(self):
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.shutdown()
        self.thread.join()
        self.server_close()
