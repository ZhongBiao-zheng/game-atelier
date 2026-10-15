"""Image downloads connect only to validated public IPs, never ambient credentials/proxies."""
import io
import socket

import pytest
import requests

from character_workflow.lib.callers import evolink


@pytest.mark.parametrize("host", [
    "127.1", "2130706433", "0x7f000001", "127.0.0.1.", "localhost.",
    "example.local.", "[::ffff:127.0.0.1]", "224.0.0.1",
])
def test_noncanonical_loopback_and_private_hosts_rejected(host):
    with pytest.raises(evolink.EvoLinkError):
        evolink._public_url(f"http://{host}/image.png")


@pytest.mark.parametrize("addresses", [
    ["127.0.0.1"], ["10.0.0.1"], ["169.254.169.254"], ["::1"],
    ["93.184.216.34", "192.168.1.1"],
])
def test_dns_private_answers_rejected_before_any_connection(monkeypatch, addresses):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443)) for address in addresses
    ])
    monkeypatch.setattr(requests.Session, "send", lambda *_args, **_kwargs: pytest.fail("SSRF"))
    with pytest.raises(evolink.EvoLinkError, match="私有网络"):
        evolink._download("https://cdn.example.com/image.png")


@pytest.mark.parametrize(("scheme", "address", "authority"), [
    ("https", "93.184.216.34", "93.184.216.34"),
    ("http", "93.184.216.34", "93.184.216.34"),
    ("https", "2606:4700::1111", "[2606:4700::1111]"),
])
def test_download_pins_dns_and_retains_tls_identity_without_ambient_auth(
    monkeypatch, tmp_path, scheme, address, authority,
):
    resolutions, sent = [], []

    def resolve(host, port, **_kwargs):
        resolutions.append((host, port))
        assert len(resolutions) == 1, "Do not resolve again between checking and connecting"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]

    def send(session, request, **kwargs):
        sent.append(request)
        assert not session.trust_env
        assert not kwargs.get("proxies")
        assert kwargs["verify"] is True
        assert "Authorization" not in request.headers
        assert request.headers["Host"] == "cdn.example.com:8443"
        assert request.url == f"{scheme}://{authority}:8443/image.png?token=public"
        adapter = session.get_adapter(request.url)
        pool = adapter.get_connection_with_tls_context(request, verify=True)
        assert pool.host == address
        if scheme == "https":
            assert pool.assert_hostname == "cdn.example.com"
            assert pool.conn_kw["server_hostname"] == "cdn.example.com"
        response = requests.Response()
        response.status_code = 200
        response.raw = io.BytesIO(b"image-content")
        return response

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    monkeypatch.setattr(requests.Session, "send", send)
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1234")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1234")
    assert evolink._download(f"{scheme}://cdn.example.com:8443/image.png?token=public") == b"image-content"
    assert len(sent) == 1


def test_download_tries_another_validated_address_on_connection_failure(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700::1111", 443)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
    ])
    attempts = []

    def send(session, request, **kwargs):
        attempts.append(request.url)
        if "2606:4700::1111" in request.url:
            raise requests.ConnectionError("IPv6 route unavailable")
        response = requests.Response()
        response.status_code = 200
        response.raw = io.BytesIO(b"image-content")
        return response

    monkeypatch.setattr(requests.Session, "send", send)
    monkeypatch.setattr(evolink.time, "sleep", lambda _: None)
    assert evolink._download("https://cdn.example.com/image.png") == b"image-content"
    assert attempts == ["https://[2606:4700::1111]:443/image.png",
                        "https://93.184.216.34:443/image.png"]


@pytest.mark.parametrize(("url", "address", "allowed"), [
    ("https://openapi-youchuan.oss-cn-shanghai.aliyuncs.com/a.png", "198.18.0.9", True),
    ("https://files.evolink.ai/a.png", "198.18.0.9", True),
    ("https://untrusted.example/a.png", "198.18.0.9", False),
    ("http://openapi-youchuan.oss-cn-shanghai.aliyuncs.com/a.png", "198.18.0.9", False),
    ("https://openapi-youchuan.oss-cn-shanghai.aliyuncs.com/a.png", "127.0.0.1", False),
    ("https://openapi-youchuan.oss-cn-shanghai.aliyuncs.com/a.png", "192.168.1.2", False),
    ("https://198.18.0.9/a.png", "198.18.0.9", False),
])
def test_only_authenticated_vendor_https_accepts_fake_ip_dns(monkeypatch, url, address, allowed):
    from urllib.parse import urlsplit

    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443)),
    ])

    def send(session, request, **kwargs):
        assert allowed, "Non-vendor or private network request must not be sent"
        pool = session.get_adapter(request.url).get_connection_with_tls_context(request, True)
        assert pool.assert_hostname == urlsplit(url).hostname
        assert pool.conn_kw["server_hostname"] == urlsplit(url).hostname
        assert kwargs["verify"] is True
        response = requests.Response()
        response.status_code = 200
        response.raw = io.BytesIO(b"image")
        return response

    monkeypatch.setattr(requests.Session, "send", send)
    if allowed:
        assert evolink._download(url) == b"image"
    else:
        with pytest.raises(evolink.EvoLinkError):
            evolink._download(url)
