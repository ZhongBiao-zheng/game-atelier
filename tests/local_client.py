"""Business tests enter through the same local session and lease endpoints as Web."""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient


class LocalTestClient(TestClient):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.headers.update({
            "Origin": str(self.base_url).rstrip("/"), "Sec-Fetch-Site": "same-origin",
            "X-Atelier-Client": uuid.uuid4().hex,
        })
        assert self.post("/api/connection/local-session", json={}).status_code == 200
        assert self.post("/api/connection/editor-lease", json={
            "client_id": self.headers["X-Atelier-Client"],
        }).status_code == 200

    def request(self, method, url, **kwargs):
        if method.upper() not in {"GET", "HEAD", "OPTIONS"} and not kwargs.get("files"):
            headers = dict(kwargs.get("headers") or {})
            if not any(key.lower() == "content-type" for key in headers):
                headers["Content-Type"] = "application/json"
            kwargs["headers"] = headers
        return super().request(method, url, **kwargs)
