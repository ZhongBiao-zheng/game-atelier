"""Loopback-only ComfyUI HTTP transport."""
from __future__ import annotations

import requests

from character_workflow.lib.comfyui_schema import local_base_url


class ComfyUIUnavailableError(RuntimeError):
    pass


class ComfyUIClient:
    def __init__(self, base_url: str | None):
        self.base_url = local_base_url(base_url)
        self.session = requests.Session()
        self.session.trust_env = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.session.close()

    def request(self, method: str, path: str, **kwargs):
        try:
            response = self.session.request(method, self.base_url + path, timeout=(3, 30),
                                            allow_redirects=False, **kwargs)
        except requests.ConnectionError as error:
            raise ComfyUIUnavailableError("主机的 ComfyUI 未启动") from error
        if response.status_code >= 300:
            raise ValueError(f"ComfyUI 请求失败（HTTP {response.status_code}）："
                             f"{response.text[:1000]}")
        return response

    def get(self, path: str, **kwargs):
        return self.request("GET", path, **kwargs).json()

    def post(self, path: str, **kwargs):
        return self.request("POST", path, **kwargs).json()
