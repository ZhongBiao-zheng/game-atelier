"""自定义接口执行器：对本机假厂商跑同步 / 异步 / 视频 / multipart，以及重试、上限与出站检查。"""
import base64
import copy
import json
from pathlib import Path

import pytest
import requests

from character_workflow.lib import http_protocols, keys, outbound_guard
from character_workflow.lib.callers import declarative, dispatch, dispatch_video, video_poll
from character_workflow.lib.job_runner import _friendly_error
from tests.fake_http_vendor import MP4, FakeVendor, png_bytes

SECRET = "sk-test-secret-0123456789"

SYNC = {
    "version": 1, "name": "同步出图", "kind": "image", "auth": {"type": "bearer"},
    "submit": {"path": "/v1/images/generations",
               "body": {"model": "$model", "prompt": "$prompt", "size": "$size", "n": "$n",
                        "image": "$images"}},
    "inputs": {"images": {"max": 2, "encode": "data_url"}},
    "options": {"ratio": ["1:1", "16:9"], "count": 4},
    "derive": {"size": {"from": "ratio", "map": {"1:1": "1024x1024", "16:9": "1536x1024"}}},
    "result": {"urls": ["data.*.url"], "base64": ["data.*.b64_json"], "error": "error.message"},
}
ASYNC = {
    "version": 1, "name": "异步出图", "kind": "image", "auth": {"type": "header", "name": "X-Key"},
    "submit": {"path": "/v1/tasks", "body": {"prompt": "$prompt"}},
    "poll": {"path": "/v1/tasks/${taskId}", "task_id": "data.id", "status": "data.status",
             "success": ["SUCCESS"], "failure": ["FAILED"], "interval_seconds": 1,
             "result": {"urls": ["data.images.*"], "error": "data.reason"}},
}
VIDEO = {
    "version": 1, "name": "视频", "kind": "video", "auth": {"type": "bearer"},
    "submit": {"path": "/v1/videos", "body": {"model": "$model", "prompt": "$prompt",
               "first": "$firstFrame", "last": "$lastFrame", "seconds": "$duration"}},
    "inputs": {"images": {"max": 2}},
    "options": {"duration": [5, 10]},
    "poll": {"path": "/v1/videos/${taskId}", "task_id": "id", "status": "status",
             "success": ["completed"], "failure": ["failed"], "interval_seconds": 1,
             "result": {"urls": ["video_url"]}},
}


@pytest.fixture
def vendor():
    with FakeVendor() as server:
        server.on("GET", "/files/a.png", png_bytes())
        server.on("GET", "/files/v.mp4", MP4)
        yield server


@pytest.fixture(autouse=True)
def fast_polls(monkeypatch):
    monkeypatch.setattr(video_poll.time, "sleep", lambda _s: None)
    monkeypatch.setattr(declarative.time, "sleep", lambda _s: None)


def configure(server, document, *, model="m1", alias="vendor", provider="custom"):
    stored = http_protocols.save_protocol(copy.deepcopy(document))
    keys.add_key(keys.KeySpec(
        alias=alias, provider=provider, base_url=server.url, access_key=SECRET,
        models=[keys.ModelSpec(id=model, name=model, modality=document["kind"],
                               protocol="declarative", declarative_id=stored.id)],
        created_at="2026-11-14T00:00:00Z",
    ))
    return stored.id


def run_image(tmp_path, params=None, **kwargs):
    params = params if params is not None else {}
    return dispatch(prompt="一只猫", model="m1", alias="vendor", output_dir=tmp_path / "out",
                    n=params.get("n", 1), params=params, **kwargs)


def write_refs(tmp_path, count, prefix="r"):
    refs = []
    for index in range(count):
        ref = tmp_path / f"{prefix}{index}.png"
        ref.write_bytes(png_bytes())
        refs.append(str(ref))
    return refs


def test_sync_url_result_with_derived_size_and_references(vendor, tmp_path):
    configure(vendor, SYNC)
    vendor.on("POST", "/v1/images/generations", {"data": [{"url": vendor.url + "/files/a.png"}]})
    paths = run_image(tmp_path, {"ratio": "16:9", "n": 2,
                                 "reference_images": write_refs(tmp_path, 1),
                                 "size_mode": "ratio", "size": "999x999"})
    assert [Path(p).suffix for p in paths] == [".png"]
    call = vendor.calls("POST")[0]
    body = call.json()
    assert body["size"] == "1536x1024" and body["n"] == 2 and body["model"] == "m1"
    assert body["prompt"] == "一只猫"
    assert body["image"][0].startswith("data:image/png;base64,")
    assert call.headers["Authorization"] == f"Bearer {SECRET}"


def test_base64_result_and_missing_optional_keys(vendor, tmp_path):
    configure(vendor, SYNC)
    encoded = base64.b64encode(png_bytes()).decode()
    vendor.on("POST", "/v1/images/generations", {"data": [{"b64_json": encoded}]})
    paths = run_image(tmp_path)
    assert Path(paths[0]).read_bytes() == png_bytes()
    body = vendor.calls("POST")[0].json()
    assert "image" not in body and body["size"] == "1024x1024"  # 缺省取第一个比例


def test_options_are_enforced_before_any_request(vendor, tmp_path):
    configure(vendor, SYNC)
    with pytest.raises(declarative.DeclarativeError, match="比例"):
        run_image(tmp_path, {"ratio": "4:3"})
    with pytest.raises(declarative.DeclarativeError, match="最多出 4 张"):
        run_image(tmp_path, {"n": 5})
    with pytest.raises(declarative.DeclarativeError, match="最多接受 2 张"):
        run_image(tmp_path, {"reference_images": write_refs(tmp_path, 3)})
    assert vendor.received == []


def test_vendor_error_text_keeps_status_for_friendly_hints(vendor, tmp_path):
    configure(vendor, SYNC)
    vendor.on("POST", "/v1/images/generations", (402, {"error": {"message": "余额不足"}}))
    with pytest.raises(declarative.DeclarativeError) as error:
        run_image(tmp_path)
    assert str(error.value) == "custom api 402: 余额不足"
    friendly = _friendly_error(error.value)
    assert "余额不足" in friendly and SECRET not in friendly


def test_transient_502_is_retried_but_500_is_not(vendor, tmp_path):
    configure(vendor, SYNC)
    vendor.on("POST", "/v1/images/generations", (502, {"error": "upstream"}),
              {"data": [{"url": vendor.url + "/files/a.png"}]})
    assert run_image(tmp_path)
    assert len(vendor.calls("POST")) == 2
    vendor.received.clear()
    vendor.on("POST", "/v1/images/generations", (500, {"error": "boom"}))
    with pytest.raises(declarative.DeclarativeError, match="custom api 500"):
        run_image(tmp_path)
    assert len(vendor.calls("POST")) == 1


def test_read_timeout_is_not_retried(vendor, tmp_path, monkeypatch):
    configure(vendor, SYNC)
    calls = []

    def timeout(*_args, **_kwargs):
        calls.append(1)
        raise requests.ReadTimeout("Read timed out")

    monkeypatch.setattr(declarative.requests, "request", timeout)
    with pytest.raises(declarative.DeclarativeError) as error:
        run_image(tmp_path)
    assert len(calls) == 1
    assert "已经计费" in _friendly_error(error.value)


def test_redirect_is_not_followed(vendor, tmp_path):
    configure(vendor, SYNC)
    vendor.on("POST", "/v1/images/generations",
              (302, {}, {"Location": "http://evil.example/steal"}))
    with pytest.raises(declarative.DeclarativeError, match="重定向"):
        run_image(tmp_path)
    assert len(vendor.calls()) == 1


def test_result_path_mismatch_names_the_path(vendor, tmp_path):
    configure(vendor, SYNC)
    vendor.on("POST", "/v1/images/generations", {"output": ["x"]})
    with pytest.raises(declarative.DeclarativeError, match=r"data\.\*\.url"):
        run_image(tmp_path)


def test_result_url_on_another_local_origin_is_refused(vendor, tmp_path):
    configure(vendor, SYNC)
    vendor.on("POST", "/v1/images/generations", {"data": [{"url": "http://127.0.0.1:9/x.png"}]})
    with pytest.raises(declarative.DeclarativeError, match="私有网络"):
        run_image(tmp_path)


def test_oversized_response_is_cut(vendor, tmp_path, monkeypatch):
    configure(vendor, SYNC)
    monkeypatch.setattr(declarative, "SUBMIT_RESPONSE_LIMIT", 64)
    vendor.on("POST", "/v1/images/generations", {"data": [{"url": "x" * 200}]})
    with pytest.raises(declarative.DeclarativeError, match="上限"):
        run_image(tmp_path)


def test_query_auth(vendor, tmp_path):
    configure(vendor, {**SYNC, "auth": {"type": "query", "name": "key"}})
    vendor.on("POST", "/v1/images/generations", {"data": [{"url": vendor.url + "/files/a.png"}]})
    run_image(tmp_path)
    call = vendor.calls("POST")[0]
    assert call.query == f"key={SECRET}" and "Authorization" not in call.headers


def test_multipart_file_upload(vendor, tmp_path):
    document = {
        "version": 1, "name": "表单", "kind": "image", "auth": {"type": "bearer"},
        "submit": {"path": "/v1/edit", "format": "multipart",
                   "body": {"prompt": "$prompt", "image": "$images", "flag": True}},
        "inputs": {"images": {"max": 2, "encode": "file"}},
        "result": {"base64": ["image"]},
    }
    configure(vendor, document)
    vendor.on("POST", "/v1/edit", {"image": base64.b64encode(png_bytes()).decode()})
    run_image(tmp_path, {"reference_images": write_refs(tmp_path, 2)})
    body = vendor.calls("POST")[0].body
    assert body.count(b'name="image"; filename="image.png"') == 2
    assert b'name="flag"\r\n\r\ntrue' in body and "一只猫".encode() in body


def test_async_persists_task_before_polling_and_resumes_without_resubmit(vendor, tmp_path):
    configure(vendor, ASYNC)
    vendor.on("POST", "/v1/tasks", {"data": {"id": "t-1"}})
    vendor.on("GET", "/v1/tasks/t-1", {"data": {"status": "RUNNING"}},
              {"data": {"status": "SUCCESS", "images": [vendor.url + "/files/a.png"]}})
    params: dict = {}
    seen = []

    def persisted():
        seen.append((dict(params), len(vendor.calls("GET", "/v1/tasks/t-1"))))

    assert run_image(tmp_path, params, on_params_changed=persisted)
    assert seen == [({"provider_task_protocol": "declarative", "provider_task_ids": ["t-1"]}, 0)]
    assert vendor.calls("POST")[0].headers["X-Key"] == SECRET
    vendor.received.clear()
    run_image(tmp_path, params)
    assert vendor.calls("POST") == []


def test_async_failure_and_timeout_carry_task_id(vendor, tmp_path, monkeypatch):
    configure(vendor, ASYNC)
    vendor.on("POST", "/v1/tasks", {"data": {"id": "t-2"}})
    vendor.on("GET", "/v1/tasks/t-2", {"data": {"status": "FAILED", "reason": "内容审核"}})
    with pytest.raises(declarative.DeclarativeError, match="内容审核.*task_id=t-2"):
        run_image(tmp_path)

    vendor.on("GET", "/v1/tasks/t-2", {"data": {"status": "RUNNING"}})
    original = video_poll.poll_responses
    monkeypatch.setattr(video_poll, "poll_responses",
                        lambda **kw: original(**{**kw, "max_polls": 2}))
    with pytest.raises(declarative.DeclarativePendingError, match="RUNNING.*task_id=t-2"):
        run_image(tmp_path)


def test_post_poll(vendor, tmp_path):
    document = copy.deepcopy(ASYNC)
    document["poll"].update(path="/v1/query", method="POST", body={"id": "$taskId"})
    configure(vendor, document)
    vendor.on("POST", "/v1/tasks", {"data": {"id": "t-3"}})
    vendor.on("POST", "/v1/query",
              {"data": {"status": "SUCCESS", "images": [vendor.url + "/files/a.png"]}})
    assert run_image(tmp_path)
    assert vendor.calls("POST", "/v1/query")[0].json() == {"id": "t-3"}


def test_video_first_last_frames_and_download(vendor, tmp_path):
    configure(vendor, VIDEO, model="v1")
    vendor.on("POST", "/v1/videos", {"id": "vid-1"})
    vendor.on("GET", "/v1/videos/vid-1",
              {"status": "completed", "video_url": vendor.url + "/files/v.mp4"})
    params = {"reference_images": write_refs(tmp_path, 2, "f"), "frame_mode": "firstlast",
              "duration": 10}
    task_ids: list[str] = []
    paths = dispatch_video(prompt="跑", model="v1", alias="vendor", output_dir=tmp_path / "v",
                           params=params, on_task_id=task_ids.append)
    assert Path(paths[0]).read_bytes() == MP4 and task_ids == ["vid-1"]
    body = vendor.calls("POST")[0].json()
    assert body["seconds"] == 10 and body["first"].startswith("data:image/png")
    assert body["last"].startswith("data:image/png")


def test_runner_end_to_end_is_unpriced(vendor, tmp_path):
    from character_workflow.lib.job_runner import run_job
    from viewer_server.routes import _create_user_job, _StudioJobCreate

    configure(vendor, SYNC)
    vendor.on("POST", "/v1/images/generations", {"data": [{"url": vendor.url + "/files/a.png"}]})
    job = _create_user_job(_StudioJobCreate(prompt="cat", model="m1", alias="vendor",
                                            params={"n": 1, "ratio": "16:9"}), namespace="studio")
    result = run_job(job.job_id)
    assert result.status.value == "done", result.error
    assert result.params.estimated_cost_cny is None and result.params.actual_cost_cny is None
    assert Path(result.output_paths[0]).exists()


def test_runner_video_keeps_declarative_task_protocol(vendor, tmp_path):
    from character_workflow.lib.job_runner import run_job
    from character_workflow.lib.jobs import save_job
    from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus

    configure(vendor, VIDEO, model="v1")
    vendor.on("POST", "/v1/videos", {"id": "vid-9"})
    vendor.on("GET", "/v1/videos/vid-9",
              {"status": "completed", "video_url": vendor.url + "/files/v.mp4"})
    save_job(Job(job_id="video-decl-1", character_id="vendor", prompt="跑", submitted_at="2026-11-14T00:00:00+08:00",
                 model="v1", params=JobParams(duration=5), output_paths=[],
                 status=JobStatus.PENDING, error=None, kind=JobKind.VIDEO, namespace="studio",
                 alias="vendor", provider="custom"))
    result = run_job("video-decl-1")
    assert result.status.value == "done", result.error
    assert result.params.provider_task_protocol == "declarative"
    assert result.params.provider_task_ids == ["vid-9"]


def test_binding_only_routes_for_custom_provider(vendor):
    from character_workflow.lib.callers import _provider_render

    configure(vendor, SYNC, alias="other", provider="openai")
    key = keys.find_by_alias("other")
    assert _provider_render(key, "m1") is not declarative.render_image
    with pytest.raises(declarative.DeclarativeError, match="自定义供应商"):
        declarative.bind("other", "m1", "image")


def test_broken_template_fails_only_that_model(vendor, tmp_path):
    identifier = configure(vendor, SYNC)
    (http_protocols.protocols_dir() / f"{identifier}.json").write_text("{", encoding="utf-8")
    with pytest.raises(declarative.DeclarativeError, match="已损坏"):
        run_image(tmp_path)
    rows = json.loads(json.dumps(keys.keys_for_api()))
    assert rows[0]["models"][0]["declared"] == {
        "available": False, "error": "自定义接口已损坏，请在设置里重新保存", "name": None}


def test_outbound_guard_rules(monkeypatch):
    with pytest.raises(outbound_guard.OutboundError):
        outbound_guard.check_base_url("http://169.254.169.254/latest")
    with pytest.raises(outbound_guard.OutboundError):
        outbound_guard.check_base_url("https://user:pw@api.example.com")
    outbound_guard.check_base_url("http://127.0.0.1:11434/v1")
    (outbound_guard.data_root.runtime_dir() / "server.port").write_text("5174")
    with pytest.raises(outbound_guard.OutboundError, match="Atelier"):
        outbound_guard.check_base_url("http://localhost:5174")
    for url in ("http://localhost/x", "http://2130706433/x", "http://0x7f.1/x",
                "http://10.1.2.3/x", "http://printer.local/x", "ftp://example.com/x"):
        with pytest.raises(outbound_guard.OutboundError):
            outbound_guard.fetch(url, max_bytes=10)
    monkeypatch.setattr(outbound_guard.requests.utils, "get_environ_proxies", lambda _u: {})
    monkeypatch.setattr(outbound_guard.socket, "getaddrinfo",
                        lambda *_a, **_k: [(2, 1, 6, "", ("192.168.1.5", 443))])
    with pytest.raises(outbound_guard.OutboundError, match="私有网络"):
        outbound_guard.fetch("https://rebind.example/x.png", max_bytes=10)


def test_redirect_into_private_network_is_refused(vendor):
    vendor.on("GET", "/hop", (302, b"", {"Location": "http://127.0.0.1:9/secret"}))
    trusted = outbound_guard.origin(requests.utils.urlparse(vendor.url))
    with pytest.raises(outbound_guard.OutboundError, match="私有网络"):
        outbound_guard.fetch(vendor.url + "/hop", max_bytes=1024, trusted=trusted)


def test_poll_redirect_is_not_followed(vendor, tmp_path):
    configure(vendor, ASYNC)
    vendor.on("POST", "/v1/tasks", {"data": {"id": "t-r"}})
    vendor.on("GET", "/v1/tasks/t-r", (302, b"", {"Location": vendor.url + "/elsewhere"}))
    vendor.on("GET", "/elsewhere", {"data": {"status": "SUCCESS", "images": []}})
    with pytest.raises(declarative.DeclarativeError, match="重定向.*task_id=t-r"):
        run_image(tmp_path)
    assert vendor.calls("GET", "/elsewhere") == []


class _StallingServer:
    """回 200 响应头 + 8 字节后不再发送：复现「头到体停」，统计收到几次提交。"""

    def __init__(self):
        import socket
        import threading

        self.connections = 0
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.url = f"http://127.0.0.1:{self.sock.getsockname()[1]}"
        self.open: list = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.connections += 1
            self.open.append(conn)
            conn.recv(65536)
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                         b"Content-Length: 100\r\n\r\n{\"data\":")

    def close(self):
        for conn in self.open:
            conn.close()
        self.sock.close()


def test_body_read_timeout_after_headers_is_never_retried(tmp_path, monkeypatch):
    stalling = _StallingServer()
    try:
        stored = http_protocols.save_protocol(copy.deepcopy(SYNC))
        keys.add_key(keys.KeySpec(
            alias="vendor", provider="custom", base_url=stalling.url, access_key=SECRET,
            models=[keys.ModelSpec(id="m1", name="m1", modality="image", protocol="declarative",
                                   declarative_id=stored.id)],
            created_at="2026-11-14T00:00:00Z"))
        monkeypatch.setattr(declarative.net_env, "DEFAULT_TIMEOUT", (1.0, 1.0))
        with pytest.raises(declarative.DeclarativeError, match="可能已经执行"):
            run_image(tmp_path)
        assert stalling.connections == 1
    finally:
        stalling.close()


def _chain_text(error: BaseException) -> str:
    import traceback
    return "".join(traceback.format_exception(error))


def test_query_secret_never_reaches_error_text_or_traceback(tmp_path):
    stored = http_protocols.save_protocol({**copy.deepcopy(SYNC), "auth": {"type": "query", "name": "key"}})
    keys.add_key(keys.KeySpec(
        alias="vendor", provider="custom", base_url="http://127.0.0.1:1", access_key=SECRET,
        models=[keys.ModelSpec(id="m1", name="m1", modality="image", protocol="declarative",
                               declarative_id=stored.id)],
        created_at="2026-11-14T00:00:00Z"))
    with pytest.raises(declarative.DeclarativeError) as error:
        run_image(tmp_path)
    assert "127.0.0.1:1/v1/images/generations" in str(error.value)
    assert SECRET not in _chain_text(error.value)


def test_poll_abandon_drops_the_secret_bearing_cause(vendor, tmp_path, monkeypatch):
    configure(vendor, {**copy.deepcopy(ASYNC), "auth": {"type": "query", "name": "key"}})
    vendor.on("POST", "/v1/tasks", {"data": {"id": "t-q"}})

    original = requests.request

    def refuse(method, url, **kw):
        if method != "GET":
            return original(method, url, **kw)
        raise requests.ConnectionError(f"Max retries exceeded with url: {url}")

    monkeypatch.setattr(video_poll.requests, "request", refuse)
    with pytest.raises(declarative.DeclarativePendingError, match="task_id=t-q") as error:
        run_image(tmp_path)
    assert SECRET not in _chain_text(error.value)


def test_poll_response_size_is_capped_while_streaming(vendor, tmp_path, monkeypatch):
    configure(vendor, ASYNC)
    monkeypatch.setattr(declarative, "POLL_RESPONSE_LIMIT", 64)
    vendor.on("POST", "/v1/tasks", {"data": {"id": "t-big"}})
    vendor.on("GET", "/v1/tasks/t-big", {"data": {"status": "RUNNING", "pad": "x" * 500}})
    with pytest.raises(declarative.DeclarativeError, match="超过 2 MB 上限.*task_id=t-big"):
        run_image(tmp_path)


def test_poll_404_keeps_waiting(vendor, tmp_path):
    configure(vendor, ASYNC)
    vendor.on("POST", "/v1/tasks", {"data": {"id": "t-404"}})
    vendor.on("GET", "/v1/tasks/t-404", (404, {"error": "not found"}),
              {"data": {"status": "SUCCESS", "images": [vendor.url + "/files/a.png"]}})
    assert run_image(tmp_path)


def test_too_many_results_is_an_error_not_a_silent_cut(vendor, tmp_path):
    configure(vendor, SYNC)
    vendor.on("POST", "/v1/images/generations",
              {"data": [{"url": f"{vendor.url}/files/a.png?i={i}"} for i in range(9)]})
    with pytest.raises(declarative.DeclarativeError, match="9 个结果"):
        run_image(tmp_path)


def test_base_url_rejects_mapped_link_local_and_gateway_port(monkeypatch):
    with pytest.raises(outbound_guard.OutboundError):
        outbound_guard.check_base_url("http://[::ffff:169.254.169.254]/")
    monkeypatch.setattr(outbound_guard, "_gateway_port", lambda: 5180)
    with pytest.raises(outbound_guard.OutboundError, match="网关"):
        outbound_guard.check_base_url("http://192.168.1.5:5180")
    outbound_guard.check_base_url("http://192.168.1.5:8080")


def test_proxy_branch_reads_no_env_credentials(monkeypatch):
    seen = {}

    class Stop(Exception):
        pass

    def fake_get(self, url, **kwargs):
        seen.update(trust_env=self.trust_env, proxies=kwargs.get("proxies"))
        raise Stop

    monkeypatch.setattr(outbound_guard.requests.utils, "get_environ_proxies",
                        lambda _u: {"https": "http://127.0.0.1:7890"})
    monkeypatch.setattr(outbound_guard.requests.Session, "get", fake_get)
    with pytest.raises(Stop):
        outbound_guard.fetch("https://cdn.example.com/a.png", max_bytes=10)
    assert seen == {"trust_env": False, "proxies": {"https": "http://127.0.0.1:7890"}}


def test_image_edit_is_refused_for_declarative_models(vendor):
    from character_workflow.lib.job_runner import JobRunnerError, run_job
    from character_workflow.lib.jobs import read_job, save_job
    from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus

    configure(vendor, SYNC)
    save_job(Job(job_id="edit-decl-1", character_id="vendor", prompt="改",
                 submitted_at="2026-11-14T00:00:00+08:00", model="m1",
                 params=JobParams(image_edit={"mode": "inpaint"}), output_paths=[],
                 status=JobStatus.PENDING, error=None, kind=JobKind.IMAGE, namespace="studio",
                 alias="vendor", provider="custom"))
    with pytest.raises(JobRunnerError, match="不支持局部编辑"):
        run_job("edit-decl-1")
    assert read_job("edit-decl-1").status.value == "failed"
    assert vendor.received == []
