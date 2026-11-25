import json

from scripts import probe_tuzi_tls as probe
from tests.fake_http_vendor import FakeVendor
from tests.test_image_tls_retry import server_tls, upstream  # noqa: F401


def test_probe_uses_one_get_and_never_follows_redirects(monkeypatch):
    with FakeVendor() as vendor:
        monkeypatch.setattr(probe, "URL", vendor.url + "/v1/models")
        vendor.on("GET", "/v1/models", (307, {"private": "response"}, {"Location": "/other"}))
        assert probe.probe("fake-key") == {"result": "HTTP_307"}
        assert [(call.method, call.path) for call in vendor.calls()] == [("GET", "/v1/models")]
        assert vendor.received[0].headers["Authorization"] == "Bearer fake-key"
    assert probe.proxy_ports({"https": "http://name:password@localhost:1082"}) == {"https": 1082}


def test_probe_sanitizes_failure_trace(server_tls, monkeypatch):  # noqa: F811
    with upstream(server_tls, ["handshake"]) as (url, connections, bodies):
        monkeypatch.setattr(probe, "URL", url + "?private-query=token")
        row = probe.probe("private-key")
    assert len(connections) == 1 and not bodies
    assert row["ssl_eof"] and row["initial_handshake_eof"] and row["stage"] == "handshake"
    assert any("ssl.do_handshake:" in frame for cause in row["trace"] for frame in cause["frames"])
    output = json.dumps(row)
    assert "private-" not in output and "Bearer" not in output and "/" not in output
