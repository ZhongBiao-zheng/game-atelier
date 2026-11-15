"""模型菜单里的音频单价：语音每千字、音乐每首。"""
from character_workflow.lib import keys, tokendance_prices
from tests.local_client import LocalTestClient as TestClient

MINIMAX_PRICING = {"items": [
    {"id": "minimax:t2a_v2:characters", "plans": [{"unit": "kCharacters", "rate": "0.16"}]},
    {"id": "minimax:t2a_v2_ws:characters", "plans": [{"unit": "kCharacters", "rate": "0.16"}]},
]}


def test_model_menu_gets_audio_unit_prices(isolated_data_root):
    from viewer_server.server_app import build_app

    song = {"items": [{"id": "yinchao:song:songs", "plans": [{"unit": "songs", "rate": "0.22"}]},
                      {"id": "yinchao:lyric-generate:lyrics",
                       "plans": [{"unit": "songs", "rate": "0.07"}]}]}
    tokendance_prices._write({"minimax-speech-2.8-turbo": MINIMAX_PRICING, "yc-song-4.0": song})
    keys.add_key(keys.KeySpec(
        alias="td", provider="tokendance", access_key="sk-test",
        models=[keys.ModelSpec(name="Speech", id="minimax-speech-2.8-turbo", modality="audio",
                               protocol="minimax-t2a"),
                keys.ModelSpec(name="Song", id="yc-song-4.0", modality="audio",
                               protocol="yinchao-song")],
        created_at="2026-11-15T00:00:00Z",
    ))
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    response = client.post("/api/pricing/estimate-batch", json={"kind": "audio", "items": [
        {"alias": "td", "model": "minimax-speech-2.8-turbo"}, {"alias": "td", "model": "yc-song-4.0"},
    ]})
    # 语音按每千字、音乐按每首；歌词生成是另一项计费，不算进单价。
    assert response.json() == {"td:minimax-speech-2.8-turbo": 0.16, "td:yc-song-4.0": 0.22}
