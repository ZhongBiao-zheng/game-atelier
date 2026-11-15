"""运行中新加到 TokenDance 供应商的模型：不重启服务也要有预计与实际费用。

2026-11-15 实测：服务 13:31 启动时同步了价格快照，16:28 在供应商里「重新获取」加了语音与音乐模型，
之后的语音任务预计费用与实际费用都是 None。原因是快照只在启动时与每 6 小时全量同步，新模型不在快照里。
这里用真实的快照文件（不 monkeypatch model_pricing）复现：快照先写好、模型后加。
"""
import json
from pathlib import Path

import pytest

from character_workflow.lib import keys, tokendance_prices
from character_workflow.lib.callers import minimax_speech
from tests.local_client import LocalTestClient as TestClient

MINIMAX_PRICING = {"items": [
    {"id": "minimax:t2a_v2:characters", "plans": [{"unit": "kCharacters", "rate": "0.16"}]},
    {"id": "minimax:t2a_v2_ws:characters", "plans": [{"unit": "kCharacters", "rate": "0.16"}]},
    {"id": "minimax:voice_clone:counts", "plans": [{"unit": "counts", "rate": "7.92"}]},
    {"id": "minimax:voice_clone:characters", "plans": [{"unit": "kCharacters", "rate": "0.28"}]},
]}
SEEDREAM_PRICING = {"items": [{"id": "ark:generated_images", "plans": [{"unit": "images", "rate": "0.22"}]}]}
TEXT = "今天天气真好，我们去公园散步"  # 13 个汉字 + 1 个逗号 = 14 字


class _Response:
    status_code = 200

    def __init__(self, body):
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body


def _startup_snapshot():
    """服务启动时的快照：那时供应商里只有图片模型。"""
    tokendance_prices._write({"seedream-5.0-lite": SEEDREAM_PRICING})


def _add_speech_model():
    keys.add_key(keys.KeySpec(
        alias="td", provider="tokendance", base_url="https://tokendance.space/gateway/v1",
        access_key="sk-test",
        models=[keys.ModelSpec(name="Seedream", id="seedream-5.0-lite", modality="image"),
                keys.ModelSpec(name="Speech", id="minimax-speech-2.8-turbo",
                               modality="audio", protocol="minimax-t2a")],
        created_at="2026-11-15T00:00:00Z",
    ))


@pytest.fixture
def price_server(monkeypatch):
    calls = []

    def fetch(origin, model_id):
        calls.append((origin, model_id))
        prices = {"minimax-speech-2.8-turbo": MINIMAX_PRICING, "seedream-5.0-lite": SEEDREAM_PRICING}
        if model_id not in prices:
            raise tokendance_prices.requests.HTTPError("404")
        return prices[model_id]

    monkeypatch.setattr(tokendance_prices, "_fetch_pricing", fetch)
    return calls


def test_speech_job_on_model_added_after_startup_sync_is_priced(monkeypatch, price_server):
    from character_workflow.lib import job_runner
    from character_workflow.lib.jobs import read_job, save_job
    from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus

    _startup_snapshot()
    _add_speech_model()
    assert tokendance_prices.model_pricing("minimax-speech-2.8-turbo") is None

    def fake_post(url, **kwargs):
        return _Response({
            "data": {"audio": b"ID3\x04audio".hex(), "status": 2},
            # 上游按自己的口径回报计费字符数，这里假设它与朗读文本字数不同。
            "extra_info": {"usage_characters": 27, "audio_format": "mp3"},
            "base_resp": {"status_code": 0, "status_msg": "success"},
        })

    monkeypatch.setattr(minimax_speech.requests, "post", fake_post)
    save_job(Job(job_id="speech-1", character_id="td", prompt=TEXT,
                 model="minimax-speech-2.8-turbo", alias="td", provider="tokendance",
                 kind=JobKind.AUDIO, namespace="studio", params=JobParams(),
                 output_paths=[], status=JobStatus.PENDING, error=None,
                 submitted_at="2026-11-15T16:29:52+08:00"))

    job = job_runner.run_job("speech-1")

    assert job.status == JobStatus.DONE
    params = read_job("speech-1").params
    # 预计：14 字 × 0.16 元 / 千字；实付：上游回报 27 个计费字符 × 0.16 元 / 千字。
    assert params.estimated_cost_cny == 0.00224
    assert params.billed_characters == 27
    assert params.actual_cost_cny == 0.00432
    # 只补拉了缺的那个模型，启动时已有的价格原样保留。
    assert price_server == [("https://tokendance.space", "minimax-speech-2.8-turbo")]
    models = json.loads(Path(tokendance_prices.snapshot_path()).read_text())["models"]
    assert models == {"seedream-5.0-lite": SEEDREAM_PRICING,
                      "minimax-speech-2.8-turbo": MINIMAX_PRICING}


def test_failed_backfill_waits_before_retrying(monkeypatch, price_server):
    _startup_snapshot()
    keys.add_key(keys.KeySpec(
        alias="td", provider="tokendance", access_key="sk-test",
        models=[keys.ModelSpec(name="Gone", id="not-on-tokendance", modality="audio",
                               protocol="minimax-t2a")],
        created_at="2026-11-15T00:00:00Z",
    ))
    assert tokendance_prices.ensure_priced("not-on-tokendance") is None
    assert tokendance_prices.ensure_priced("not-on-tokendance") is None
    # 失败后冷却期内，后续任务不再为同一模型等一次网络超时。
    assert price_server == [("https://tokendance.space", "not-on-tokendance")]
    # 保存供应商时的补拉不受冷却限制。
    tokendance_prices.sync_missing()
    assert len(price_server) == 2


def test_saving_tokendance_models_starts_backfill(monkeypatch, isolated_data_root):
    from viewer_server.server_app import build_app

    started = []
    monkeypatch.setattr(tokendance_prices, "start_missing_sync", lambda: started.append(True))
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    model = {"name": "Speech", "id": "minimax-speech-2.8-turbo", "modality": "audio",
             "protocol": "minimax-t2a"}
    assert client.post("/api/keys", json={
        "alias": "td", "provider": "tokendance", "access_key": "sk-test", "models": [],
    }).status_code == 201
    assert client.patch("/api/keys/td", json={"models": [model]}).status_code == 200
    assert client.post("/api/keys", json={
        "alias": "other", "provider": "custom", "access_key": "sk-test",
        "base_url": "https://example.com/v1", "models": [],
    }).status_code == 201
    assert started == [True, True]
