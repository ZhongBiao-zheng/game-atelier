"""无认证 SOCKS5 CONNECT，只允许转到本用例的回环假上游。"""
import select
import socket
import socketserver
import threading

import pytest

from tests.fake_http_vendor import FakeVendor
from tests.test_direct_text_retry import ANTHROPIC, CHAT, chat, client_for


@pytest.fixture
def socks_network(request, monkeypatch):
    with FakeVendor() as vendor:
        destinations = []

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                version, count = self.rfile.read(2)
                assert version == 5 and 0 in self.rfile.read(count)
                self.wfile.write(b"\x05\x00")
                version, command, _, kind = self.rfile.read(4)
                assert (version, command) == (5, 1)
                if kind == 1:
                    host = socket.inet_ntoa(self.rfile.read(4))
                else:
                    assert kind == 3
                    host = self.rfile.read(self.rfile.read(1)[0]).decode()
                port = int.from_bytes(self.rfile.read(2), "big")
                assert host == "127.0.0.1" and port == vendor.server_port
                destinations.append((host, port))
                with socket.create_connection((host, port), timeout=3) as remote:
                    self.wfile.write(b"\x05\x00\x00\x01" + b"\x00" * 6)
                    peers = {self.connection: remote, remote: self.connection}
                    while ready := select.select(list(peers), [], [], 3)[0]:
                        for source in ready:
                            data = source.recv(65536)
                            if not data:
                                return
                            peers[source].sendall(data)

        with socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler) as proxy:
            thread = threading.Thread(target=proxy.serve_forever, kwargs={"poll_interval": 0.02})
            thread.start()
            for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
                monkeypatch.delenv(var, raising=False)
                monkeypatch.delenv(var.lower(), raising=False)
            monkeypatch.setenv("all_proxy", f"{request.param}://127.0.0.1:{proxy.server_address[1]}")
            try:
                yield vendor, destinations
            finally:
                proxy.shutdown()
                thread.join()


@pytest.mark.parametrize("socks_network", ["socks5", "socks5h"], indirect=True)
@pytest.mark.parametrize("protocol,path,body", [
    ("openai-chat", "/v1/chat/completions", CHAT),
    ("openai-responses", "/v1/responses", {"id": "r", "output": []}),
    ("anthropic-messages", "/v1/messages", ANTHROPIC),
    ("gemini-generate-content", "/v1beta/models/m:generateContent",
     {"candidates": [{"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP"}]}),
])
async def test_agent_through_socks(socks_network, protocol, path, body):
    vendor, tunnels = socks_network
    vendor.on("POST", path, body)
    async with client_for(vendor.url, protocol) as client:
        if protocol == "openai-responses":
            assert (await client.responses.create(model="m", input="q")).id == "r"
        else:
            assert (await chat(client)).choices[0].message.content == "ok"
    assert len(tunnels) == len(vendor.calls("POST", path)) == 1


@pytest.mark.parametrize("socks_network", ["socks5h"], indirect=True)
async def test_gateway_agent_skips_socks(socks_network):
    vendor, tunnels = socks_network
    vendor.on("POST", "/gateway/v1/openai/chat/completions", CHAT)
    async with client_for(vendor.url, provider="atelier") as client:
        assert (await chat(client)).choices[0].message.content == "ok"
    assert len(vendor.received) == 1 and not tunnels


@pytest.mark.parametrize("socks_network", ["socks5", "socks5h"], indirect=True)
def test_requests_image_and_text_use_socks(socks_network):
    from character_workflow.lib.callers import openai_image, openai_text

    vendor, tunnels = socks_network
    vendor.on("POST", "/images", {"data": []})
    vendor.on("POST", "/chat", CHAT)
    assert openai_image._post_json(vendor.url + "/images", "test", {}, timeout=2) == {"data": []}
    assert openai_text._post_json(url=vendor.url + "/chat", access_key="test",
                                  payload={}, timeout=2) == CHAT
    assert len(tunnels) == len(vendor.received) == 2


@pytest.mark.parametrize("socks_network", ["socks5h"], indirect=True)
def test_requests_gateway_and_domestic_vendor_bypass_socks(socks_network, monkeypatch):
    import socket
    from character_workflow.lib import net_env
    from character_workflow.lib.callers import openai_text

    vendor, tunnels = socks_network
    vendor.on("POST", "/chat", CHAT)
    net_env.configure_proxy_bypass()
    resolve = socket.getaddrinfo

    def local_dns(host, *args):
        assert host in {"api.volces.com", "127.0.0.1"}
        return resolve("127.0.0.1", *args)

    monkeypatch.setattr(socket, "getaddrinfo", local_dns)
    for url, alias in [(vendor.url, "hub"), (f"http://api.volces.com:{vendor.server_port}", None)]:
        assert openai_text._post_json(url=url + "/chat", access_key="test", payload={},
                                      gateway_alias=alias, timeout=1) == CHAT
    assert len(vendor.received) == 2 and not tunnels


@pytest.mark.parametrize("socks_network", ["socks", "socks4", "socks4a"], indirect=True)
def test_sync_text_explains_unsupported_socks(socks_network):
    from character_workflow.lib import net_env, structured_text_call
    from character_workflow.lib.callers import openai_text

    vendor, tunnels = socks_network
    with pytest.raises(openai_text.OpenAITextError) as error:
        openai_text._post_json(url=vendor.url, access_key="test", payload={}, timeout=1)
    assert structured_text_call.failure_reason(str(error.value)) == net_env.SOCKS_PROXY_MESSAGE
    assert not tunnels and not vendor.received
