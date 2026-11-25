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
