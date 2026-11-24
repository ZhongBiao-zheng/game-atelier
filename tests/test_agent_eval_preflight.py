import json
import sys

import pytest

from scripts.agent_eval import cli
from scripts.agent_eval.fake import FakeProvider, Handler


pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="隔离评测服务只支持 macOS 与 Linux")


def _source(root, keys):
    config = root / ".config"
    config.mkdir(exist_ok=True)
    (config / "keys.json").write_text(json.dumps(keys), encoding="utf-8")


def test_preflight_without_sync_uses_only_selected_local_prices(tmp_path, monkeypatch, capsys):
    upstream_calls = []

    def unexpected_request(handler):
        upstream_calls.append(handler.path)
        handler.send_error(503)

    monkeypatch.setattr(Handler, "do_GET", unexpected_request)
    monkeypatch.setattr(Handler, "do_POST", unexpected_request)
    with FakeProvider(["eval/chat"]) as vendor:
        key = vendor.keys["keys"][0]
        key["provider"] = "tokendance"
        chat, image, video = key["models"]
        del (
            chat["input_cny_per_m"],
            chat["output_cny_per_m"],
            image["per_call_cny"],
            video["per_call_cny"],
        )
        _source(tmp_path, vendor.keys)
        args = [
            "--keys-from",
            str(tmp_path),
            "--providers",
            "eval",
            "--chat-model",
            "eval/chat",
            "--budget-cny",
            "5",
            "--out",
            str(tmp_path / "results"),
        ]
        assert cli.main(["run", *args]) == 2
        missing = capsys.readouterr().out
        assert "已登记，无可核对价格" in missing and "图片模型 1 个，其中 0 个" in missing
        assert not (tmp_path / "results").exists()

        folder = tmp_path / ".runtime/prices"
        folder.mkdir(parents=True)
        snapshot = {
            "models": {
                "chat": {
                    "items": [
                        {
                            "id": f"openai:chat-completions:{name}",
                            "plans": [{"unit": "millionTokens", "rate": rate}],
                        }
                        for name, rate in [("input_tokens", "2"), ("completion_tokens", "8")]
                    ]
                },
                "kling-v2": {
                    "items": [
                        {
                            "id": "video:seconds",
                            "skus": [
                                {"specs": {"resolution": "720p"}, "unit": "seconds", "rate": 0.24}
                            ],
                        }
                    ]
                },
                "gpt-image-1": {
                    "items": [
                        {"id": "generated_images", "plans": [{"unit": "images", "rate": "0.31"}]}
                    ]
                },
            }
        }
        (folder / "tokendance.json").write_text(json.dumps(snapshot))
        assert cli.main(["preflight", *args]) == 0
        text = capsys.readouterr().out
        assert "已登记，同步或内置价格" in text and "eval/gpt-image-1  ¥0.31" in text
        assert "eval/kling-v2  ¥1.2" in text and "¥4.5，预算 ¥5" in text
        assert not (tmp_path / "results").exists()
        assert upstream_calls == []


def test_unknown_fields_missing_files_budget_and_model_errors_reported_together(tmp_path, capsys):
    with FakeProvider(["eval/chat"]) as vendor:
        _source(tmp_path, vendor.keys)
        base = {"surface": "studio", "title": "评测", "turns": [{"say": "test"}]}
        cases = [
            base | {"id": "ok", "limits": {"max_cost_cny": 3}},
            base
            | {
                "id": "typo",
                "turns": [
                    {"say": "test", "attachments": ["missing.png"], "expect": {"ratioo": "4:3"}}
                ],
            },
        ]
        manifest = tmp_path / "cases.yaml"
        manifest.write_text(json.dumps(cases))
        result = cli.main(
            [
                "preflight",
                "--cases",
                str(manifest),
                "--fixtures",
                str(tmp_path),
                "--keys-from",
                str(tmp_path),
                "--providers",
                "eval",
                "--chat-model",
                "eval/chat",
                "--chat-model",
                "eval/missing",
                "--budget-cny",
                "1",
            ]
        )
        assert result == 2
        text = capsys.readouterr().out
        for detail in (
            "typo",
            "turns.0.expect.ratioo",
            "missing.png",
            "eval/missing",
            "未登记",
            "¥6.0",
            "超过预算",
            "手设价格",
        ):
            assert detail in text
        assert vendor.token not in text


def test_successful_real_mode_preflight_enables_only_the_subsequent_run(tmp_path, monkeypatch):
    requests = []
    original = Handler.do_POST

    def observe(handler):
        requests.append(handler.path)
        return original(handler)

    monkeypatch.setattr(Handler, "do_POST", observe)
    with FakeProvider(["eval/chat"]) as vendor:
        _source(tmp_path, vendor.keys)
        args = [
            "--keys-from",
            str(tmp_path),
            "--providers",
            "eval",
            "--chat-model",
            "eval/chat",
            "--budget-cny",
            "0.4",
            "--only",
            "11-underspecified",
            "--out",
            str(tmp_path / "out"),
        ]
        assert cli.main(["preflight", *args]) == 0 and requests == []
        assert cli.main(["run", *args]) == 0
        assert any(path.endswith("/chat/completions") for path in requests)
        row = json.loads((tmp_path / "out/results.jsonl").read_text())
        assert row["status"] == "completed" and row["usage"]["chat_cost_cny"] > 0


def test_missing_required_video_and_gateway_chat_price_fail_together(tmp_path, capsys):
    with FakeProvider(["eval/chat"]) as vendor:
        key = vendor.keys["keys"][0]
        key["provider"] = "atelier"
        key["models"] = [key["models"][0]]
        _source(tmp_path, vendor.keys)
        manifest = tmp_path / "video.yaml"
        manifest.write_text(
            json.dumps(
                {
                    "id": "clip",
                    "title": "视频",
                    "surface": "studio",
                    "turns": [{"say": "做一段视频"}],
                    "expect": {"videos": 1},
                }
            )
        )
        assert (
            cli.main(
                [
                    "preflight",
                    "--cases",
                    str(manifest),
                    "--keys-from",
                    str(tmp_path),
                    "--providers",
                    "eval",
                    "--chat-model",
                    "eval/chat",
                    "--budget-cny",
                    "2",
                ]
            )
            == 2
        )
        text = capsys.readouterr().out
        assert "无可核对价格" in text and "视频模型 0 个" in text and "clip 缺少" in text


def test_preference_requires_a_quote_for_that_specific_model(tmp_path, capsys):
    with FakeProvider(["eval/chat"]) as vendor:
        key = vendor.keys["keys"][0]
        key["models"].append(
            {"id": "unpriced-image", "name": "Unpriced", "modality": "image", "protocol": "openai"}
        )
        _source(tmp_path, vendor.keys)
        manifest = tmp_path / "image.yaml"
        manifest.write_text(
            json.dumps(
                {
                    "id": "portrait",
                    "title": "角色",
                    "surface": "studio",
                    "settings": {"preferred_models": ["eval/unpriced-image"]},
                    "turns": [{"say": "画一个角色"}],
                    "expect": {"images": 1},
                }
            )
        )
        assert (
            cli.main(
                [
                    "preflight",
                    "--cases",
                    str(manifest),
                    "--keys-from",
                    str(tmp_path),
                    "--providers",
                    "eval",
                    "--chat-model",
                    "eval/chat",
                    "--budget-cny",
                    "2",
                ]
            )
            == 2
        )
        text = capsys.readouterr().out
        assert "gpt-image-1  ¥0.25" in text and "portrait 缺少" in text
