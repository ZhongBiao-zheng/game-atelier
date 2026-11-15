"""音乐生成：音潮 caller、按首计价、画布参数、多首落盘与续查。"""
import json
from pathlib import Path

import pytest
import requests

from character_workflow.lib import generation_pricing, keys, outbound_guard, tokendance_prices
from character_workflow.lib.callers import yinchao_music

SONG_PRICING = {"items": [
    {"id": "yinchao:song:songs", "plans": [{"unit": "songs", "rate": "0.22"}]},
    {"id": "yinchao:lyric-generate:lyrics", "plans": [{"unit": "songs", "rate": "0.07"}]},
]}
MP3 = b"ID3\x04\x00song"


class _Response:
    def __init__(self, status_code=200, body=None, text=""):
        self.status_code = status_code
        self._body = body
        self.text = text or json.dumps(body or {})

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


def _choice(status, index=0, **extra):
    return {"id": f"song-{index}", "status": status, "error": "", "title": f"歌{index}",
            "lyric": f"[VERSE]\n第{index}首", "audio_url": "", **extra}


def _add_key(model="yc-song-4.0"):
    keys.add_key(keys.KeySpec(
        alias="td", provider="tokendance", base_url="https://tokendance.space/gateway/v1",
        access_key="sk-test",
        models=[keys.ModelSpec(name="Song", id=model, modality="audio", protocol="yinchao-song")],
        created_at="2026-11-14T00:00:00Z",
    ))


@pytest.fixture
def song_api(monkeypatch):
    """假音潮：记录提交，查询依次返回预设的 choices，下载返回 MP3 字节。"""
    state = {"posts": [], "polls": [], "replies": [], "downloads": [], "params_at_first_poll": None}

    def fake_post(url, **kwargs):
        state["posts"].append({"url": url, "json": kwargs["json"], "headers": kwargs["headers"]})
        return _Response(body={"id": "task-123", "task_type": "normal", "choices": []})

    def fake_get(url, **kwargs):
        state["polls"].append(url)
        if state["params_at_first_poll"] is None and "params" in state:
            state["params_at_first_poll"] = dict(state["params"])
        return _Response(body={"id": "task-123", "choices": state["replies"].pop(0)})

    def fake_fetch(url, *, max_bytes, trusted=None, **kwargs):
        state["downloads"].append((url, trusted))
        return MP3

    monkeypatch.setattr(yinchao_music.requests, "post", fake_post)
    monkeypatch.setattr("character_workflow.lib.callers.video_poll.requests.get", fake_get)
    monkeypatch.setattr(yinchao_music, "POLL_INTERVAL", 0)
    monkeypatch.setattr(outbound_guard, "fetch", fake_fetch)
    monkeypatch.setattr(tokendance_prices, "model_pricing", {"yc-song-4.0": SONG_PRICING}.get)
    return state


def _render(tmp_path, params, prompt="轻快的原声吉他 BGM", model="yc-song-4.0", **kwargs):
    return yinchao_music.render(prompt=prompt, model=model, alias="td", output_dir=tmp_path,
                                params=params, **kwargs)


def test_generates_songs_persisting_task_id_before_polling(tmp_path, song_api):
    _add_key()
    params = {"lyrics": "  [VERSE]\n海风  ", "n": 2}
    song_api["params"] = params
    song_api["replies"] = [
        [_choice("running", 0), _choice("pending", 1)],
        [_choice("done", 0, audio_url="https://cdn.example.com/a.mp3"),
         _choice("stream", 1, pipe_url="https://cdn.example.com/p")],
        [_choice("done", 0, audio_url="https://cdn.example.com/a.mp3"),
         _choice("done", 1, audio_url="https://cdn.example.com/b.mp3?x=1")],
    ]
    changed = []
    paths = _render(tmp_path, params, on_params_changed=lambda: changed.append(True))

    assert song_api["posts"] == [{
        "url": "https://tokendance.space/gateway/yinchao/v1/song/generate",
        "json": {"model": "yc-song-4.0", "task_type": "normal", "prompt": "轻快的原声吉他 BGM",
                 "n": 2, "lyric": "[VERSE]\n海风"},
        "headers": {"Authorization": "Bearer sk-test", "Content-Type": "application/json"},
    }]
    # 任务号在第一次查询前已落盘：服务重启后能凭它续查而不重新提交。
    assert song_api["params_at_first_poll"]["provider_task_ids"] == ["task-123"]
    assert song_api["polls"][0] == "https://tokendance.space/gateway/yinchao/v1/task/query?task_id=task-123"
    assert len(song_api["polls"]) == 3
    assert [Path(path).name for path in paths] == ["song-0.mp3", "song-1.mp3"]
    assert all(Path(path).read_bytes() == MP3 for path in paths)
    assert song_api["downloads"][0][1] == ("https", "tokendance.space", 443)
    assert params["music_tracks"] == [
        {"title": "歌0", "lyric": "[VERSE]\n第0首"}, {"title": "歌1", "lyric": "[VERSE]\n第1首"}]
    assert params["actual_cost_cny"] == 0.44
    assert params["provider_task_protocol"] == "yinchao"
    assert len(changed) == 2


def test_instrumental_uses_its_own_endpoint_and_drops_lyrics(tmp_path, song_api):
    _add_key()
    song_api["replies"] = [[_choice("done", 0, audio_url="https://cdn.example.com/a.mp3")]]
    _render(tmp_path, {"instrumental": True, "lyrics": "不该发出去"})
    assert song_api["posts"][0]["url"].endswith("/song/instrumental")
    assert song_api["posts"][0]["json"] == {"model": "yc-song-4.0", "prompt": "轻快的原声吉他 BGM", "n": 1}


def test_older_model_without_instrumental_falls_back_to_songs(tmp_path, song_api):
    _add_key("yc-song-3.5")
    song_api["replies"] = [[_choice("done", 0, audio_url="https://cdn.example.com/a.mp3")]]
    _render(tmp_path, {"instrumental": True}, model="yc-song-3.5")
    assert song_api["posts"][0]["url"].endswith("/song/generate")


def test_gateway_count_argument_wins(tmp_path, song_api):
    _add_key()
    song_api["replies"] = [[_choice("done", 0, audio_url="https://cdn.example.com/a.mp3"),
                            _choice("done", 1, audio_url="https://cdn.example.com/b.mp3")]]
    _render(tmp_path, {}, n=2)
    assert song_api["posts"][0]["json"]["n"] == 2


def test_resume_only_polls_the_known_task(tmp_path, song_api):
    _add_key()
    song_api["replies"] = [[_choice("done", 0, audio_url="https://cdn.example.com/a.mp3")]]
    params = {"provider_task_protocol": "yinchao", "provider_task_ids": ["task-old"]}
    paths = _render(tmp_path, params)
    assert song_api["posts"] == []
    assert song_api["polls"] == ["https://tokendance.space/gateway/yinchao/v1/task/query?task_id=task-old"]
    assert len(paths) == 1


def test_keeps_successful_songs_and_reports_all_failed(tmp_path, song_api):
    _add_key()
    params = {"n": 2}
    song_api["replies"] = [[_choice("done", 0, audio_url="https://cdn.example.com/a.mp3"),
                            _choice("fail", 1, error="内容审核未通过")]]
    assert len(_render(tmp_path, params)) == 1
    assert params["actual_cost_cny"] == 0.22

    song_api["replies"] = [[_choice("fail", 0, error="内容审核未通过")]]
    with pytest.raises(yinchao_music.YinchaoMusicError, match=r"内容审核未通过.*task-123"):
        _render(tmp_path, {})


@pytest.mark.parametrize("reply,match", [
    (_Response(400, text="bad prompt"), "music api 400"),
    (_Response(502, text="gateway"), "未确认"),
    (_Response(body={"choices": []}), "没有任务号"),
])
def test_submit_failures(tmp_path, monkeypatch, reply, match):
    _add_key()
    monkeypatch.setattr(yinchao_music.requests, "post", lambda *a, **k: reply)
    with pytest.raises(yinchao_music.YinchaoMusicError, match=match):
        _render(tmp_path, {})


def test_submit_network_failure_is_never_retried(tmp_path, monkeypatch):
    _add_key()
    calls = []

    def boom(*args, **kwargs):
        calls.append(1)
        raise requests.ReadTimeout("slow")

    monkeypatch.setattr(yinchao_music.requests, "post", boom)
    with pytest.raises(yinchao_music.YinchaoMusicError, match="未确认"):
        _render(tmp_path, {})
    assert calls == [1]


def test_rejects_bad_input_without_calling(tmp_path, monkeypatch):
    _add_key()
    monkeypatch.setattr(yinchao_music.requests, "post", lambda *a, **k: pytest.fail("called"))
    with pytest.raises(yinchao_music.YinchaoMusicError, match="请描述"):
        _render(tmp_path, {}, prompt="  ")
    with pytest.raises(yinchao_music.YinchaoMusicError, match="1000"):
        _render(tmp_path, {}, prompt="曲" * 1001)
    with pytest.raises(yinchao_music.YinchaoMusicError, match="歌词不能超过 3000"):
        _render(tmp_path, {"lyrics": "词" * 3001})


def test_poll_timeout_keeps_task_reference(tmp_path, song_api, monkeypatch):
    _add_key()
    monkeypatch.setattr(yinchao_music, "MAX_POLLS", 2)
    song_api["replies"] = [[_choice("running")], [_choice("running")]]
    with pytest.raises(yinchao_music.YinchaoMusicError, match="超时.*task-123"):
        _render(tmp_path, {})


# ---- 计价 -----------------------------------------------------------------------------------


def test_music_estimate_counts_songs(monkeypatch):
    monkeypatch.setattr(tokendance_prices, "model_pricing", {"yc-song-4.0": SONG_PRICING}.get)
    request = {"kind": "audio", "provider": "tokendance", "model_id": "yc-song-4.0",
               "protocol": "yinchao-song"}
    estimate = generation_pricing.estimate_cost_cny
    assert estimate(**request, n=1) == 0.22
    assert estimate(**request, n=2) == 0.44
    assert estimate(**request, n=5) == 0.44  # 上限 2 首
    assert estimate(**{**request, "provider": "custom"}, n=1) is None
    assert estimate(**{**request, "model_id": "yc-song-3.5"}, n=1) is None  # 快照里没有


# ---- 画布提交 -------------------------------------------------------------------------------


def _freeze(count=1, model_id="yc-song-4.0", **params):
    from character_workflow.lib.canvas_runs import _normalized_params
    from character_workflow.lib.schemas import CanvasGenerationDraft, JobParams

    model = keys.ModelSpec(name="Song", id=model_id, modality="audio", protocol="yinchao-song")
    key = keys.KeySpec(alias="td", provider="tokendance", access_key="sk", models=[model],
                       created_at="2026-11-14T00:00:00Z")
    draft = CanvasGenerationDraft(mode="audio", prompt="BGM", model=model.id, alias="td",
                                  params=JobParams(**params), updated_at="2026-11-14T00:00:00Z")
    return _normalized_params(draft, count, key, model)


def test_canvas_freezes_music_params_and_count():
    normalized, job_params, count = _freeze(2, lyrics=" 词 ", voice="alloy", speed=2)
    assert normalized == {"instrumental": False, "n": 2, "lyrics": "词"}
    assert count == 2 and job_params.n == 2
    assert _freeze(1, instrumental=True, lyrics="词")[0] == {"instrumental": True, "n": 1}
    assert _freeze(1, "yc-song-3.5", instrumental=True)[0] == {"instrumental": False, "n": 1}
    with pytest.raises(ValueError, match="最多生成 2 首"):
        _freeze(3)
    with pytest.raises(ValueError, match="歌词不能超过"):
        _freeze(1, lyrics="词" * 3001)


# ---- 落盘与续查 -----------------------------------------------------------------------------


def test_music_job_stores_every_requested_song_and_freezes_estimate(tmp_path, monkeypatch):
    from character_workflow.lib import job_runner
    from character_workflow.lib.jobs import read_job, save_job
    from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus

    _add_key()
    monkeypatch.setattr(tokendance_prices, "model_pricing", {"yc-song-4.0": SONG_PRICING}.get)
    seen = {}

    def fake_render(*, output_dir, params, n, **kwargs):
        seen["estimate"] = params.get("estimated_cost_cny")
        seen["n"] = n
        paths = []
        for index in range(3):  # 多给一首：只收请求的首数
            path = Path(output_dir) / f"song-{index}.mp3"
            path.write_bytes(MP3)
            paths.append(str(path))
        return paths

    monkeypatch.setattr(yinchao_music, "render", fake_render)
    save_job(Job(job_id="music-1", character_id="td", prompt="BGM", model="yc-song-4.0",
                 alias="td", provider="tokendance", kind=JobKind.AUDIO, namespace="studio",
                 params=JobParams(n=2, instrumental=True), output_paths=[], status=JobStatus.PENDING,
                 error=None, submitted_at="2026-11-14T00:00:00+08:00"))
    job = job_runner.run_job("music-1")
    assert job.status == JobStatus.DONE
    assert len(job.output_paths) == 2
    assert seen == {"estimate": 0.44, "n": 2}
    assert read_job("music-1").params.estimated_cost_cny == 0.44


def test_music_task_with_known_order_is_resumable():
    from character_workflow.lib.jobs import has_resumable_music_task
    from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus

    def job(**params):
        return Job(job_id="m", character_id="td", prompt="BGM", model="yc-song-4.0", alias="td",
                   kind=JobKind.AUDIO, namespace="studio", params=JobParams(**params),
                   output_paths=[], status=JobStatus.PENDING, error=None,
                   submitted_at="2026-11-14T00:00:00+08:00")

    assert has_resumable_music_task(job(provider_task_protocol="yinchao", provider_task_ids=["t"]))
    assert not has_resumable_music_task(job())
    assert not has_resumable_music_task(job(provider_task_protocol="seedance", provider_task_ids=["t"]))
