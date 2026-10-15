import base64
import copy
import io
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests
from PIL import Image, ImageOps

from character_workflow.lib.callers import evolink
from character_workflow.lib.schemas import JobParams


def image_bytes(size=(8, 6), *, format="PNG"):
    stream = io.BytesIO()
    Image.new("RGB", size, "red").save(stream, format=format)
    return stream.getvalue()


class Response:
    def __init__(self, payload=None, *, status=200, content=None, headers=None):
        self.payload = payload
        self.status_code = status
        self.ok = 200 <= status < 300
        self.content = content if content is not None else image_bytes()
        self.headers = headers or {}

    def json(self):
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload

    def iter_content(self, chunk_size):
        yield self.content

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("Every EvoLink HTTP call must be mocked")
    monkeypatch.setattr(evolink.requests, "get", forbidden)
    monkeypatch.setattr(evolink.requests, "post", forbidden)
    monkeypatch.setattr(evolink.time, "sleep", lambda _seconds: None)


@pytest.fixture
def key(monkeypatch):
    key = SimpleNamespace(alias="evo", provider="evolink", base_url="https://api.evolink.ai/v1",
                          access_key="fake-test-secret")
    monkeypatch.setattr(evolink.keys, "find_by_alias", lambda _alias: key)
    return key


def success(n=4, **extra):
    return {"id": "task-1", "status": "completed",
            "results": [f"https://cdn.example.com/{index}.png" for index in range(n)], **extra}


def wire(monkeypatch, *, submit=None, polls=None, downloads=None, observer=None):
    posted, fetched = [], []
    polls = iter(polls if polls is not None else [Response(success())])
    downloads = iter(downloads) if downloads is not None else None

    def post(url, **kwargs):
        posted.append((url, kwargs))
        if observer:
            observer(url, kwargs)
        if url == evolink.UPLOAD_URL:
            return Response({"success": True, "data": {"file_url": "https://files.evolink.ai/a.png"}})
        result = submit if submit is not None else Response({"id": "task-1", "status": "processing"})
        if isinstance(result, Exception):
            raise result
        return result

    def get(url, **kwargs):
        fetched.append((url, kwargs))
        result = next(polls) if "/v1/tasks/" in url else (
            next(downloads) if downloads is not None else Response())
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(evolink.requests, "post", post)
    monkeypatch.setattr(evolink.requests, "get", get)
    return posted, fetched


def render(tmp_path, **kwargs):
    return evolink.render(prompt=kwargs.pop("prompt", "a red flower"), model="mj-v8.2",
                          alias="evo", output_dir=tmp_path / "outputs", poll_interval=0,
                          **kwargs)


def edit_params(tmp_path, *, mode="inpaint", canvas=None):
    source = tmp_path / "source.png"
    source.write_bytes(image_bytes())
    mask = Image.new("L", (8, 6), 255)
    mask.putpixel((2, 3), 0)
    mask.putpixel((3, 3), 200)
    mask.save(tmp_path / "mask.png")
    return {"reference_images": [str(source)], "mask_image": str(tmp_path / "mask.png"),
            "image_edit": {"mode": mode, **(canvas or {"width": 8, "height": 6, "x": 0, "y": 0})}}


def test_one_submission_persists_before_post_and_all_outputs(key, monkeypatch, tmp_path):
    params, snapshots, phases, costs = {}, [], [], []

    def observe(url, _kwargs):
        assert params["evolink_state"]["uncertain"] is True
        assert snapshots[-1]["evolink_state"]["uncertain"] is True

    posted, fetched = wire(monkeypatch, observer=observe, polls=[Response(success(
        usage={"cost": {"usd": 0.08}}))])
    paths = render(tmp_path, params=params, n=1, on_phase=phases.append,
                   on_cost_usd=costs.append,
                   on_params_changed=lambda: snapshots.append(copy.deepcopy(params)))

    assert len(posted) == 1
    assert posted[0][0] == "https://api.evolink.ai/v1/images/generations"
    assert posted[0][1]["json"] == {"model": "mj-v8.2", "prompt": "a red flower",
                                    "quality": "standard", "model_params": {"speed": "fast"}}
    assert posted[0][1]["allow_redirects"] is False
    assert snapshots[1]["provider_task_ids"] == ["task-1"]
    assert snapshots[1]["provider_task_protocol"] == "evolink"
    assert snapshots[1]["evolink_state"]["uncertain"] is False
    assert params["n"] == params["actual_n"] == 4
    assert params["evolink_state"]["terminal"] == "completed"
    assert all(Path(path).read_bytes() == image_bytes() for path in paths)
    assert phases == ["sent", "downloading"]
    assert costs == [0.08]
    assert "Authorization" in fetched[0][1]["headers"]
    assert all("Authorization" not in request[1]["headers"] for request in fetched[1:])


@pytest.mark.parametrize("editing", [False, True])
def test_real_job_params_dump_with_none_fields_submits_and_finishes(
    key, monkeypatch, tmp_path, editing,
):
    params = JobParams(**(edit_params(tmp_path) if editing else {})).model_dump()
    assert params["evolink_state"] is None
    assert params["mode"] is None
    assert params["mj_stylize"] is None
    posted, _ = wire(monkeypatch)
    paths = render(tmp_path, params=params)
    assert len(paths) == 4
    assert params["evolink_state"]["terminal"] == "completed"
    assert params["provider_task_ids"] == ["task-1"]
    assert params["n"] == params["actual_n"] == 4
    assert len(posted) == (2 if editing else 1)


@pytest.mark.parametrize("invalid_state", [False, [], "invalid", 7])
def test_non_dictionary_non_null_recovery_state_is_still_rejected(key, tmp_path, invalid_state):
    params = JobParams().model_dump()
    params["evolink_state"] = invalid_state
    with pytest.raises(evolink.EvoLinkError, match="任务恢复信息无效"):
        render(tmp_path, params=params)


def test_upload_paint_inverts_mask_without_alpha_and_preserves_source(key, monkeypatch, tmp_path):
    params = edit_params(tmp_path)
    before = Path(params["reference_images"][0]).read_bytes()
    posted, _ = wire(monkeypatch)
    render(tmp_path, params=params)

    assert posted[0][0] == evolink.UPLOAD_URL
    assert posted[0][1]["json"]["base64_data"].startswith("data:image/png;base64,")
    assert base64.b64decode(posted[0][1]["json"]["base64_data"].split(",")[1]) == before
    assert Path(params["reference_images"][0]).read_bytes() == before
    body = posted[1][1]["json"]
    assert body["model"] == "mj-v8.2-upload-paint"
    assert body["image_urls"] == ["https://files.evolink.ai/a.png"]
    assert body["model_params"]["img_pos"] == {"width": 8, "height": 6, "x": 0, "y": 0}
    mask_uri = body["model_params"]["mask"]["url"]
    with Image.open(io.BytesIO(base64.b64decode(mask_uri.split(",")[1]))) as mask:
        assert mask.mode == "L"
        assert mask.getpixel((0, 0)) == 0
        assert mask.getpixel((2, 3)) == 255
        assert mask.getpixel((3, 3)) == 0
        assert set(mask.tobytes()) == {0, 255}


def test_outpaint_canvas_can_change_ratio_without_stretching_image(key, monkeypatch, tmp_path):
    params = edit_params(tmp_path, mode="outpaint",
                         canvas={"width": 16, "height": 10, "x": 3, "y": 2})
    Image.new("L", (8, 6), 255).save(params["mask_image"])
    posted, _ = wire(monkeypatch)
    render(tmp_path, params=params)
    model_params = posted[1][1]["json"]["model_params"]
    assert model_params["canvas"] == {"width": 16, "height": 10}
    assert model_params["img_pos"] == {"width": 8, "height": 6, "x": 3, "y": 2}
    with Image.open(io.BytesIO(base64.b64decode(model_params["mask"]["url"].split(",")[1]))) as mask:
        assert mask.getextrema() == (0, 0)


@pytest.mark.parametrize("mode", ["inpaint", "outpaint"])
@pytest.mark.parametrize("remote_source", [False, True])
def test_edit_upload_normalizes_exif_orientation_before_mask_and_geometry(
    key, monkeypatch, tmp_path, mode, remote_source,
):
    source = tmp_path / "rotated.jpg"
    original = Image.new("RGB", (8, 6), "red")
    original.paste("blue", (0, 0, 4, 6))
    exif = Image.Exif()
    exif[274] = 6
    original.save(source, exif=exif)
    original_bytes = source.read_bytes()
    with Image.open(source) as opened:
        expected = ImageOps.exif_transpose(opened).convert("RGB")
    mask_path = tmp_path / "display-mask.png"
    mask = Image.new("L", (6, 8), 255)
    mask.putpixel((1, 2), 0)
    mask.save(mask_path)
    params = {
        "reference_images": ["https://cdn.example.com/rotated.jpg" if remote_source else str(source)],
        "mask_image": str(mask_path),
        "image_edit": {"mode": mode, **(
            {"width": 12, "height": 12, "x": 3, "y": 2} if mode == "outpaint" else
            {"width": 6, "height": 8, "x": 0, "y": 0})},
    }
    posted, _ = wire(monkeypatch, downloads=(
        [Response(content=original_bytes), *[Response()] * 4] if remote_source else None))
    render(tmp_path, params=params)
    assert source.read_bytes() == original_bytes
    assert posted[0][0] == evolink.UPLOAD_URL
    data_uri = posted[0][1]["json"]["base64_data"]
    assert data_uri.startswith("data:image/png;base64,")
    with Image.open(io.BytesIO(base64.b64decode(data_uri.split(",")[1]))) as uploaded:
        assert uploaded.size == expected.size == (6, 8)
        assert uploaded.tobytes() == expected.tobytes()
        assert uploaded.getexif().get(274) is None
    body = posted[1][1]["json"]
    assert body["image_urls"] == ["https://files.evolink.ai/a.png"]
    assert body["model_params"]["img_pos"] == {
        "width": 6, "height": 8, "x": 3 if mode == "outpaint" else 0,
        "y": 2 if mode == "outpaint" else 0,
    }
    with Image.open(io.BytesIO(base64.b64decode(
        body["model_params"]["mask"]["url"].split(",")[1]
    ))) as uploaded_mask:
        assert uploaded_mask.size == (6, 8)
        assert uploaded_mask.getpixel((1, 2)) == 255


@pytest.mark.parametrize("base_url", ["https://direct.evolink.ai", "https://other.example.com/v1",
    "http://api.evolink.ai", "https://api.evolink.ai:444", "https://api.evolink.ai/not-v1",
    "https://api.evolink.ai@other.example.com", "https://api.evolink.ai:invalid"])
def test_unofficial_api_origin_rejected_before_upload_or_submission(key, tmp_path, base_url):
    key.base_url = base_url
    with pytest.raises(evolink.EvoLinkError, match="https://api.evolink.ai"):
        render(tmp_path, params=edit_params(tmp_path))


@pytest.mark.parametrize("base_url", [None, "https://api.evolink.ai", "https://api.evolink.ai/",
                                    "https://api.evolink.ai/v1/", "https://api.evolink.ai:443"])
def test_official_api_root_normalizes_documented_v1_suffix(key, base_url):
    key.base_url = base_url
    assert evolink._api_root(key) == "https://api.evolink.ai"


def test_reference_and_sref_use_evolink_upload_and_native_prompt(key, monkeypatch, tmp_path):
    source = tmp_path / "reference.jpg"
    source.write_bytes(image_bytes(format="JPEG"))
    params = {"reference_images": [str(source)], "mj_sref": [str(source)], "ratio": "16:9",
              "mj_stylize": 600, "mj_chaos": 20, "mj_seed": 23, "mj_no": "text",
              "mj_tile": True, "mj_sw": 500, "mj_iw": 1.5}
    posted, _ = wire(monkeypatch)
    render(tmp_path, params=params)
    assert len(posted) == 3
    body = posted[-1][1]["json"]
    assert body["prompt"].startswith("https://files.evolink.ai/a.png a red flower")
    for flag in ("--ar 16:9", "--stylize 600", "--chaos 20", "--seed 23", "--no text",
                 "--tile", "--sw 500", "--iw 1.5", "--sref https://files.evolink.ai/a.png"):
        assert flag in body["prompt"]
    assert "base64Array" not in body
    assert "accountFilter" not in body


def test_sref_code_needs_no_upload(key, monkeypatch, tmp_path):
    posted, _ = wire(monkeypatch)
    render(tmp_path, params={"mj_sref_code": "123456", "mj_sw": 100})
    assert len(posted) == 1
    assert "--sref 123456" in posted[0][1]["json"]["prompt"]


@pytest.mark.parametrize("params", [
    {"mj_cref": ["https://cdn.example.com/a.png"]}, {"mj_oref": ["x"]},
    {"mj_profile": "abcd"}, {"mode": "draft"}, {"mode": "relax"}, {"quality": "hd"},
    {"bot_type": "NIJI_JOURNEY"}, {"mj_version": "7"}, {"mj_stylize": 1001},
    {"mj_seed": -1}, {"ratio": "1.5:1"}, {"mj_iw": 1}, {"mj_unknown": "x"},
    {"mj_sw": 40}, {"mj_sref_code": "not-a-code"},
])
def test_unsupported_parameters_rejected_before_any_http(key, tmp_path, params):
    with pytest.raises(evolink.EvoLinkError):
        render(tmp_path, params=params)


@pytest.mark.parametrize("prompt", ["a cat --oref https://example.com/a.png", "a cat --draft",
                                   "a cat --edit", "a cat --profile x", "a cat --stop 80",
                                   "a cat --q 5", "a cat --ar 1.5:1", "a cat --seed -1",
                                   "a cat --p abc --weird 2", "a cat --sv 6",
                                   "a cat --iw nan"])
def test_unsupported_inline_parameters_rejected(key, tmp_path, prompt):
    with pytest.raises(evolink.EvoLinkError):
        render(tmp_path, prompt=prompt)


def test_more_than_four_outputs_never_submits_multiple_tasks(key, tmp_path):
    with pytest.raises(evolink.EvoLinkError, match="1–4"):
        render(tmp_path, n=8)


@pytest.mark.parametrize("submit", [requests.Timeout("Bearer fake-test-secret"),
    Response(ValueError("fake-test-secret")), Response({}), Response({}, status=503)])
def test_uncertain_submission_is_never_repeated(key, monkeypatch, tmp_path, submit):
    params = {}
    posted, _ = wire(monkeypatch, submit=submit)
    with pytest.raises(evolink.EvoLinkError, match="不会重复") as error:
        render(tmp_path, params=params)
    assert "fake-test-secret" not in str(error.value)
    assert params["evolink_state"]["uncertain"] is True
    with pytest.raises(evolink.EvoLinkError, match="不会重复"):
        render(tmp_path, params=params)
    assert len(posted) == 1


def test_rejected_submission_is_terminal_and_error_hides_key(key, monkeypatch, tmp_path):
    params = {}
    posted, _ = wire(monkeypatch, submit=Response({"error": {
        "message": "invalid Bearer fake-test-secret"}}, status=401))
    for _ in range(2):
        with pytest.raises(evolink.EvoLinkError, match="密钥无效") as error:
            render(tmp_path, params=params)
        assert "fake-test-secret" not in str(error.value)
    assert len(posted) == 1
    assert params["evolink_state"]["terminal"] == "rejected"
    assert params["evolink_state"]["uncertain"] is False


def test_persistence_failure_prevents_paid_post(key, tmp_path):
    def failure():
        raise OSError("disk full")
    with pytest.raises(OSError, match="disk full"):
        render(tmp_path, on_params_changed=failure)


def test_known_task_resumes_without_reopening_source_or_upload(key, monkeypatch, tmp_path):
    params = {"image_edit": {"mode": "outpaint"}, "evolink_state": {
        "task_id": "task-1", "channel": evolink.channel_fingerprint(key), "poll_paused": True}}
    posted, _ = wire(monkeypatch)
    paths = render(tmp_path, params=params)
    assert posted == []
    assert len(paths) == 4
    assert params["evolink_state"]["poll_paused"] is False


@pytest.mark.parametrize("failures", [
    [requests.Timeout("network")] * 3,
    [Response({}, status=503)] * 3,
    [Response(ValueError("bad json"))] * 3,
    [Response({}, status=401)],
])
def test_poll_errors_pause_known_task_and_resume_without_post(key, monkeypatch, tmp_path, failures):
    params = {}
    posted, _ = wire(monkeypatch, polls=[*failures, Response(success(2))])
    with pytest.raises(evolink.EvoLinkPendingError, match="task_id=task-1"):
        render(tmp_path, params=params)
    assert params["evolink_state"]["poll_paused"] is True
    assert not params["evolink_state"].get("terminal")
    paths = render(tmp_path, params=params)
    assert len(posted) == 1
    assert len(paths) == params["n"] == 2


def test_poll_budget_exhaustion_pauses_and_does_not_claim_failure(key, monkeypatch, tmp_path):
    params = {}
    wire(monkeypatch, polls=[Response({"status": "processing"})])
    with pytest.raises(evolink.EvoLinkPendingError):
        render(tmp_path, params=params, max_polls=1)
    assert params["evolink_state"]["poll_paused"] is True
    assert not params["evolink_state"].get("terminal")


def test_provider_terminal_failure_is_persisted_and_never_retried(key, monkeypatch, tmp_path):
    params, snapshots = {}, []
    posted, fetched = wire(monkeypatch, polls=[Response({"status": "failed", "error": {
        "message": "invalid parameters"}})])
    for _ in range(2):
        with pytest.raises(evolink.EvoLinkError, match="invalid parameters"):
            render(tmp_path, params=params,
                   on_params_changed=lambda: snapshots.append(copy.deepcopy(params)))
    assert len(posted) == len(fetched) == 1
    assert snapshots[-1]["evolink_state"]["terminal"] == "failed"
    assert snapshots[-1]["evolink_state"]["poll_paused"] is False


def test_download_failure_keeps_completed_results_and_resumes_download_only(key, monkeypatch, tmp_path):
    params = {}
    posted, fetched = wire(monkeypatch, downloads=[Response(status=503)] * 3 + [Response()] * 4)
    with pytest.raises(evolink.EvoLinkPendingError, match="已经出图"):
        render(tmp_path, params=params)
    assert params["evolink_state"]["terminal"] == "completed"
    assert params["evolink_state"]["results"] == success()["results"]
    assert params["evolink_state"]["poll_paused"] is True
    paths = render(tmp_path, params=params)
    assert len(paths) == 4
    assert len(posted) == 1
    assert len([url for url, _ in fetched if "/tasks/" in url]) == 1


def test_invalid_download_not_registered_as_image_and_retry_keeps_order(key, monkeypatch, tmp_path):
    params = {}
    wire(monkeypatch, downloads=[Response(content=b"<html>not an image</html>")])
    with pytest.raises(evolink.EvoLinkPendingError):
        render(tmp_path, params=params)
    assert list((tmp_path / "outputs").iterdir()) == []
    assert params["evolink_state"]["results"]


def test_jpeg_download_keeps_real_extension(key, monkeypatch, tmp_path):
    wire(monkeypatch, polls=[Response(success(1))], downloads=[Response(content=image_bytes(format="JPEG"))])
    paths = render(tmp_path)
    assert Path(paths[0]).suffix == ".jpg"


def test_download_follows_validated_redirect_without_authorization(key, monkeypatch, tmp_path):
    _, fetched = wire(monkeypatch, polls=[Response(success(1))], downloads=[
        Response(status=302, headers={"Location": "https://cdn2.example.com/output.png"}), Response()])
    paths = render(tmp_path)
    assert len(paths) == 1
    assert fetched[-1][0] == "https://cdn2.example.com/output.png"
    assert fetched[-1][1]["allow_redirects"] is False
    assert "Authorization" not in fetched[-1][1]["headers"]


def test_download_redirect_cannot_reach_loopback(key, monkeypatch, tmp_path):
    _, fetched = wire(monkeypatch, polls=[Response(success(1))], downloads=[
        Response(status=302, headers={"Location": "http://127.0.0.1/private"})])
    with pytest.raises(evolink.EvoLinkPendingError):
        render(tmp_path)
    assert len(fetched) == 2


def test_oversized_download_is_bounded(key, monkeypatch, tmp_path):
    monkeypatch.setattr(evolink.requests, "get", lambda *args, **kwargs: Response(content=b"12345"))
    with pytest.raises(evolink.EvoLinkError, match="文件大小"):
        evolink._download("https://cdn.example.com/large.png", limit=4)


def test_result_data_supported_and_partial_delivery_keeps_actual_count(key, monkeypatch, tmp_path):
    params = {}
    wire(monkeypatch, polls=[Response({"status": "completed", "result_data": [
        {"url": "https://cdn.example.com/a.png"}]})])
    assert len(render(tmp_path, params=params)) == 1
    assert params["n"] == params["actual_n"] == 1


def test_excessive_results_pause_instead_of_silently_dropping_paid_outputs(key, monkeypatch, tmp_path):
    params = {}
    wire(monkeypatch, polls=[Response(success(24))])
    with pytest.raises(evolink.EvoLinkPendingError, match="1–4"):
        render(tmp_path, params=params)
    assert params["evolink_state"]["task_id"] == "task-1"


def test_changed_key_cannot_resume_another_channel(key, tmp_path):
    params = {"evolink_state": {"task_id": "task-1", "channel": evolink.channel_fingerprint(key)}}
    key.access_key = "rotated-test-key"
    with pytest.raises(evolink.EvoLinkError, match="不能跨渠道"):
        render(tmp_path, params=params)


def test_cancel_before_submit_has_no_http(key, tmp_path):
    with pytest.raises(evolink.EvoLinkError, match="尚未提交"):
        render(tmp_path, should_cancel=lambda: True)


def test_cancel_after_submit_preserves_task(key, monkeypatch, tmp_path):
    params = {}
    posted, fetched = wire(monkeypatch)
    with pytest.raises(evolink.EvoLinkPendingError, match="仍可能继续"):
        render(tmp_path, params=params, should_cancel=lambda: bool(params.get("provider_task_ids")))
    assert len(posted) == 1
    assert fetched == []
    assert params["evolink_state"]["poll_paused"] is True


def test_mask_size_error_prevents_upload_and_generation(key, tmp_path):
    params = edit_params(tmp_path)
    Image.new("L", (2, 2), 255).save(params["mask_image"])
    with pytest.raises(evolink.EvoLinkError, match="蒙版尺寸"):
        render(tmp_path, params=params)


def test_upload_failure_does_not_mark_paid_submission_uncertain(key, monkeypatch, tmp_path):
    params = edit_params(tmp_path)
    calls = []
    monkeypatch.setattr(evolink.requests, "post", lambda url, **kwargs: (
        calls.append(url) or Response({"msg": "quota exhausted"}, status=429)))
    with pytest.raises(evolink.EvoLinkError, match="频率受限"):
        render(tmp_path, params=params)
    assert calls == [evolink.UPLOAD_URL]
    assert not params["evolink_state"].get("uncertain")


@pytest.mark.parametrize("url", ["file:///etc/passwd", "http://127.0.0.1/a.png",
                                  "http://10.1.1.1/a.png", "http://localhost/a.png",
                                  "https://user:secret@cdn.example.com/a.png"])
def test_result_urls_reject_local_or_credentialled_locations(key, tmp_path, url):
    with pytest.raises(evolink.EvoLinkError):
        evolink._public_url(url)
