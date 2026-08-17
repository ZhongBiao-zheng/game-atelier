"""Midjourney 任务代理协议 caller 契约测试（mock HTTP，不真打 API）。

契约来源是 2026-08-17 对 Tuzi MJ 分组的实测：提交回 {code, description, result}，
轮询 /mj/task/{id}/fetch 看 status，SUCCESS 后 imageUrls 是 4 张独立单图。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from character_workflow.lib import keys as _keys
from character_workflow.lib.callers import mj_image as mj


class _FakeResp:
    def __init__(self, status_code: int, payload: dict, content: bytes = b"PNG"):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)
        self.content = content

    @property
    def ok(self) -> bool:
        return self.status_code < 400

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(f"HTTP {self.status_code}")


def _success(n: int = 4) -> dict:
    return {
        "id": "1786973745670123",
        "status": "SUCCESS",
        "progress": "100%",
        "imageUrl": "https://cdn.mj/grid.png",
        "imageUrls": [{"url": f"https://cdn.mj/out{i}.png"} for i in range(1, n + 1)],
        "properties": {"finalPrompt": "p --ar 1:1 --v 7 --stylize 100 --fast"},
    }


@pytest.fixture
def mj_key(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    _keys.add_key(_keys.KeySpec(
        alias="mj",
        provider="midjourney",
        base_url="https://api.tu-zi.com",
        access_key="sk-fake",
        created_at="2026-08-17T00:00:00+00:00",
    ))
    return tmp_path


def _wire(monkeypatch, *, submit: dict, submit_status: int = 200, fetch: dict | None = None):
    """把 submit / 轮询 / 下载三条 HTTP 都接上。返回收集到的提交 body 列表。

    轮询与下载都走 requests.get —— mj_image.requests 与 video_poll.requests 是同一个模块
    对象，patch 一处即覆盖两条路径，按 URL 分流。
    """
    posted: list[dict] = []

    def fake_post(url, headers=None, json=None, timeout=None):
        posted.append({"url": url, "body": json})
        return _FakeResp(submit_status, submit)

    def fake_get(url, headers=None, timeout=None):
        if "/fetch" in url:
            return _FakeResp(200, fetch if fetch is not None else _success())
        return _FakeResp(200, {}, content=b"PNG")

    monkeypatch.setattr(mj.requests, "post", fake_post)
    monkeypatch.setattr(mj.requests, "get", fake_get)
    return posted


def _render(tmp_path, **kw):
    kw.setdefault("params", {})
    return mj.render(
        prompt=kw.pop("prompt", "a knight"),
        model="mj_fast_imagine",
        alias="mj",
        output_dir=tmp_path / "o",
        poll_interval=0,
        **kw,
    )


def test_submits_polls_and_downloads_four_images(mj_key, tmp_path, monkeypatch):
    posted = _wire(monkeypatch, submit={"code": 1, "description": "Submit Success", "result": "t-1"})

    out = _render(tmp_path, n=4)

    assert posted[0]["url"] == "https://api.tu-zi.com/mj/submit/imagine"
    assert len(out) == 4, "imageUrls 的 4 张单图都要落盘"
    assert all(Path(p).read_bytes() == b"PNG" for p in out)


def test_grid_image_is_not_saved(mj_key, tmp_path, monkeypatch):
    """imageUrl 是 2048² 四宫格，与 4 张单图内容重复 —— 不该多落一张。"""
    _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-1"})
    assert len(_render(tmp_path, n=4)) == 4


@pytest.mark.parametrize("code", [1, 21, 22])
def test_accepted_submit_codes(mj_key, tmp_path, monkeypatch, code):
    """1=成功 21=任务已存在 22=排队中，都算受理。"""
    _wire(monkeypatch, submit={"code": code, "description": "d", "result": "t-1"})
    assert len(_render(tmp_path, n=4)) == 4


def test_insert_failed_is_translated_not_taken_as_param_error(mj_key, tmp_path, monkeypatch):
    """insert_midjourney_task_failed 字面像参数错，实际是渠道接不下任务 —— 文案必须说清。"""
    _wire(monkeypatch, submit_status=400,
          submit={"code": 4, "description": "insert_midjourney_task_failed ", "type": "upstream_error"})

    with pytest.raises(mj.MidjourneyError) as e:
        _render(tmp_path, n=4)
    msg = str(e.value)
    assert "渠道正忙或暂时不可用" in msg
    assert "与 prompt 内容和参数无关" in msg


def test_failure_status_raises_with_task_id(mj_key, tmp_path, monkeypatch):
    """任务已提交即已计费，失败消息必须带 task_id 供人工找回。"""
    _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-42"},
          fetch={"status": "FAILURE", "failReason": "banned prompt"})

    with pytest.raises(mj.MidjourneyError) as e:
        _render(tmp_path, n=4)
    assert "banned prompt" in str(e.value)
    assert "t-42" in str(e.value)


def test_success_without_urls_raises_with_task_id(mj_key, tmp_path, monkeypatch):
    _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-9"},
          fetch={"status": "SUCCESS", "imageUrls": []})

    with pytest.raises(mj.MidjourneyError) as e:
        _render(tmp_path, n=4)
    assert "t-9" in str(e.value)


def test_flags_appended_from_structured_params(mj_key, tmp_path, monkeypatch):
    """MJ 没有 size/quality 字段，一切控制拼进 prompt 尾部。"""
    posted = _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-1"})

    _render(tmp_path, n=4, params={
        "ratio": "16:9", "mj_version": "7", "mj_stylize": 250, "mj_chaos": 10,
        "mj_weird": 500, "mj_seed": 12345, "mj_no": "text, watermark",
        "mj_tile": True, "mj_iw": 1.5,
    })

    sent = posted[0]["body"]["prompt"]
    for fragment in ("--ar 16:9", "--v 7", "--stylize 250", "--chaos 10",
                     "--weird 500", "--seed 12345", "--no text, watermark",
                     "--iw 1.5", "--tile"):
        assert fragment in sent, f"{fragment} 没拼进 prompt：{sent}"
    assert sent.startswith("a knight"), "画师原文必须在前"


def test_version_flag_follows_bot_type(mj_key, tmp_path, monkeypatch):
    """niji 与 Midjourney 是两套版本体系：--v 7 vs --niji 6，flag 名不能混。"""
    posted = _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-1"})

    _render(tmp_path, n=4, params={"mj_version": "7"})
    assert "--v 7" in posted[-1]["body"]["prompt"]
    assert "--niji" not in posted[-1]["body"]["prompt"]

    _render(tmp_path, n=4, params={"mj_version": "6", "bot_type": "NIJI_JOURNEY"})
    assert "--niji 6" in posted[-1]["body"]["prompt"]
    assert "--v 6" not in posted[-1]["body"]["prompt"]


def test_no_version_flag_when_unset(mj_key, tmp_path, monkeypatch):
    posted = _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-1"})
    _render(tmp_path, n=4, params={"bot_type": "NIJI_JOURNEY"})
    prompt = posted[0]["body"]["prompt"]
    assert "--v" not in prompt and "--niji" not in prompt


def test_absent_params_send_no_flags(mj_key, tmp_path, monkeypatch):
    posted = _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-1"})
    _render(tmp_path, n=4)
    assert posted[0]["body"]["prompt"] == "a knight"
    # botType / accountFilter 没给就不发 —— 不传等于走上游默认预设（实测可用）。
    assert "botType" not in posted[0]["body"]
    assert "accountFilter" not in posted[0]["body"]


def test_bot_type_and_mode_are_body_fields(mj_key, tmp_path, monkeypatch):
    """niji 与速度档走 body（botType / accountFilter.modes），不是 prompt flag。"""
    posted = _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-1"})

    _render(tmp_path, n=4, params={"bot_type": "NIJI_JOURNEY", "mode": "RELAX"})

    body = posted[0]["body"]
    assert body["botType"] == "NIJI_JOURNEY"
    assert body["accountFilter"] == {"modes": ["RELAX"]}
    assert "--niji" not in body["prompt"]


def test_actual_count_written_back_with_warning(mj_key, tmp_path, monkeypatch):
    """skill 侧默认 n=1；不回写实际张数，job_runner 会按 n 裁掉 3 张已计费的图。"""
    _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-1"})
    params: dict = {"n": 1}

    out = _render(tmp_path, n=1, params=params)

    assert len(out) == 4
    assert params["n"] == 4
    assert any("4 张" in w for w in params["warnings"])


def test_no_warning_when_count_matches(mj_key, tmp_path, monkeypatch):
    _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-1"})
    params: dict = {"n": 4}
    _render(tmp_path, n=4, params=params)
    assert params["n"] == 4
    assert "warnings" not in params


def test_more_than_four_wanted_submits_twice(mj_key, tmp_path, monkeypatch):
    """一次 imagine 回 4 张，要 8 张就提交两次（ceil），不是提交 8 次。"""
    posted = _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-1"})
    out = _render(tmp_path, n=8)
    assert len(posted) == 2
    assert len(out) == 8


def test_empty_prompt_rejected_before_any_request(mj_key, tmp_path, monkeypatch):
    posted = _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-1"})
    with pytest.raises(mj.MidjourneyError, match="非空 prompt"):
        _render(tmp_path, prompt="   ", n=4)
    assert posted == [], "prompt 都没有就别打上游"


def test_missing_task_id_raises(mj_key, tmp_path, monkeypatch):
    _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": ""})
    with pytest.raises(mj.MidjourneyError, match="未返回任务 ID"):
        _render(tmp_path, n=4)


def test_unknown_alias_raises(mj_key, tmp_path, monkeypatch):
    _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-1"})
    with pytest.raises(mj.MidjourneyError, match="未找到 Key"):
        mj.render(prompt="p", model="mj_fast_imagine", alias="nope",
                  output_dir=tmp_path / "o", n=4, params={}, poll_interval=0)


def test_on_phase_reports_sent_then_downloading(mj_key, tmp_path, monkeypatch):
    """MJ 是唯一异步图片协议，出图期间前端靠 progress_phase 显示卡点。"""
    _wire(monkeypatch, submit={"code": 1, "description": "ok", "result": "t-1"})
    phases: list[str] = []
    _render(tmp_path, n=4, on_phase=phases.append)
    assert phases == ["sent", "downloading"]
