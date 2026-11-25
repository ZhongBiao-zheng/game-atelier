"""Loopback TLS upstream for paid image POSTs. Count connections and received bodies."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.client import parse_headers
import ipaddress
import socket
import socketserver
import ssl
import threading

import pytest
import requests
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from character_workflow.lib.callers import openai_image


@pytest.fixture
def server_tls(tmp_path, monkeypatch):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
                           critical=False).sign(key, hashes.SHA256()))
    cert_path, key_path = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                          serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert_path, key_path)
    monkeypatch.setenv("REQUESTS_CA_BUNDLE", str(cert_path))
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    return ctx


@contextmanager
def upstream(ctx, actions):
    connections, bodies = [], []

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            index = len(connections)
            connections.append(index)
            action = actions[index] if index < len(actions) else "success"
            if action == "handshake":
                self.request.recv(16384)  # consume ClientHello before closing the socket
                self.request.shutdown(socket.SHUT_WR)
                return
            with ctx.wrap_socket(self.request, server_side=True) as conn, conn.makefile("rb") as stream:
                stream.readline()
                headers = parse_headers(stream)
                bodies.append(stream.read(int(headers["Content-Length"])))
                if action == "success":
                    conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                elif action == "redirect":
                    conn.sendall(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                # For "sent", close immediately after the full POST body.

    with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        try:
            yield f"https://127.0.0.1:{server.server_address[1]}/images", connections, bodies
        finally:
            server.shutdown()
            thread.join()


@pytest.mark.parametrize("multipart", [False, True])
@pytest.mark.parametrize(("actions", "expected_connections", "expected_posts"), [
    (["handshake", "success"], 2, 1), (["handshake", "handshake"], 2, 0),
    (["sent"], 1, 1), (["redirect", "handshake"], 2, 1),
])
def test_paid_post_handshake_retry(server_tls, multipart, actions, expected_connections, expected_posts):
    with upstream(server_tls, actions) as (url, connections, bodies):
        def submit():
            if multipart:
                return openai_image._post_multipart(url, "test", fields={"model": "nano-banana-2"},
                                                    files=[("image", ("test.png", b"image"))], timeout=3)
            return openai_image._post_json(url, "test", {"model": "nano-banana-2"}, timeout=3)

        if actions[-1] == "success":
            assert submit() == {}
        else:
            with pytest.raises((requests.RequestException, openai_image.OpenAIImageError)):
                submit()
        assert len(connections) == expected_connections
        assert len(bodies) == expected_posts


@pytest.mark.parametrize(("actions", "results"), [
    (["handshake", "success"], ["retry=1 result=pending", "retry=1 result=HTTP_200"]),
    (["handshake", "handshake"], ["retry=1 result=pending",
                                  "retry=1 result=SSLError retry_stage=handshake"]),
    (["redirect", "handshake"], ["retry=0 result=not_retried"]),
])
def test_image_tls_diagnostics_keep_credentials_and_body_private(server_tls, caplog, actions, results):
    warnings = []
    with upstream(server_tls, actions) as (url, _, _):
        def post():
            return openai_image._post_json(url + "?signature=hidden-query", "hidden-key",
                                           {"prompt": "hidden-prompt"}, timeout=3,
                                           on_tls_event=warnings.append)
        if actions[-1] == "success":
            assert post() == {}
        else:
            with pytest.raises(openai_image.OpenAIImageError):
                post()

    assert len(warnings) == len(results)
    for message, expected in zip(warnings, results, strict=True):
        assert "stage=handshake tls=unknown" in message
        assert expected in message and message in caplog.messages
    assert "hidden-" not in caplog.text


def test_failed_image_render_persists_tls_warnings_before_raising(server_tls, tmp_path, monkeypatch):
    from character_workflow.lib import keys

    params = {"warnings": ["原有提示"]}
    saved = []
    with upstream(server_tls, ["handshake", "handshake"]) as (url, connections, bodies):
        key = keys.KeySpec(alias="local", provider="custom", base_url=url,
                           access_key="testing", created_at="test")
        monkeypatch.setattr(keys, "find_by_alias", lambda _: key)
        with pytest.raises(openai_image.OpenAIImageError):
            openai_image.render(prompt="probe", model="nano-banana-2", alias="local",
                                output_dir=tmp_path, params=params, timeout=3,
                                on_params_changed=lambda: saved.append(params["warnings"].copy()))
    assert len(connections) == 2 and not bodies
    assert saved[0][0] == "原有提示" and "result=pending" in saved[0][-1]
    assert saved[-1] == params["warnings"] and "result=SSLError" in saved[-1][-1]


def test_response_status_tls_eof_with_received_body_is_not_replayed(server_tls, monkeypatch):
    from http.client import HTTPResponse

    def read_status(_self):
        raise ssl.SSLEOFError(8, "test peer closed TLS")

    monkeypatch.setattr(HTTPResponse, "_read_status", read_status)
    warnings = []
    with upstream(server_tls, ["sent"]) as (url, connections, bodies):
        with pytest.raises(openai_image.OpenAIImageError):
            openai_image._post_json(url, "fake", {"prompt": "test"}, timeout=3, on_tls_event=warnings.append)
    assert len(connections) == len(bodies) == len(warnings) == 1
    assert "stage=read_status" in warnings[0] and "retry=0 result=not_retried" in warnings[0]
