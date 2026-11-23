import json
from urllib.parse import quote

import pytest

from scripts.agent_eval import _server, host


def test_only_named_providers_are_copied_to_the_disposable_db(tmp_path):
    private = tmp_path / ".config"
    private.mkdir()
    db = {
        "keys": [
            {"alias": "a", "access_key": "synthetic-a"},
            {"alias": "b", "access_key": "synthetic-b"},
        ],
        "default_alias": "b",
        "oss": {"access_key_secret": "synthetic-oss"},
    }
    path = private / "keys.json"
    path.write_text(json.dumps(db), encoding="utf-8")
    assert host.selected_keys(tmp_path, ["a"]) == {"version": 1, "keys": [db["keys"][0]]}
    assert json.loads(path.read_text(encoding="utf-8")) == db
    with pytest.raises(ValueError, match="不存在"):
        host.selected_keys(tmp_path, ["missing"])


def test_report_scrubber_removes_credentials_urls_and_nested_request_headers(tmp_path):
    token = "synthetic / token+123"
    with host.LocalAPI(31313, tmp_path / "data", {"keys": [{"access_key": token}]}) as api:
        row = api.scrub(
            {
                "prompt": "Draw a tree",
                "trace": [
                    {"nested": {"request_headers": {"X-Vendor-Proof": "private-header"}}},
                    "POST https://user:pw@host.invalid/generate?token=abc",
                    "Authorization: Bearer a-different-secret",
                    quote(token, safe=""),
                    {"parameter": token},
                    str(tmp_path / "data" / "job.png"),
                ],
            }
        )
    text = json.dumps(row)
    assert row["prompt"] == "Draw a tree"
    for private in (
        token,
        quote(token, safe=""),
        "host.invalid",
        "private-header",
        "a-different-secret",
        str(tmp_path),
    ):
        assert private not in text


def test_fake_transport_denies_external_dns_and_all_unselected_loopback_ports(monkeypatch):
    import socket

    with pytest.raises(ValueError, match="回环"):
        host._fake_ports({"keys": [{"base_url": "https://unselected.invalid/v1"}]})
    filters = []
    monkeypatch.setattr(_server.sys, "addaudithook", filters.append)
    _server.restrict_fake_network({31314})
    (audit,) = filters
    with pytest.raises(PermissionError, match="DNS"):
        audit("socket.getaddrinfo", ("unselected.invalid", 443))
    with socket.socket() as client:
        for address in [("127.0.0.1", 31315), ("192.0.2.1", 31314)]:
            with pytest.raises(PermissionError, match="假上游"):
                audit("socket.connect", (client, address))
        audit("socket.connect", (client, ("127.0.0.1", 31314)))
