"""Project-local Lovart entrypoint.

The upstream lovart-api skill is still the API surface. This wrapper only patches
the HTTP transport to use requests with proxy env ignored, then delegates to the
skill CLI.
"""
from __future__ import annotations

import json
import sys
import urllib.parse
from pathlib import Path

import requests


LOVART_SKILL_ROOT = Path.home() / ".claude" / "skills" / "lovart-api"
sys.path.insert(0, str(LOVART_SKILL_ROOT))

import agent_skill  # noqa: E402


_SESSION = requests.Session()
_SESSION.trust_env = False


def _patched_request(self, method, path, body=None, params=None, retries=10):
    url = f"{self.base_url}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body) if body is not None else None
    last_err = None
    result = None

    for attempt in range(retries):
        headers = self._sign(method, path)
        headers["Content-Type"] = "application/json"
        headers["User-Agent"] = (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "LovartAgentSkill/1.0"
        )
        headers["Connection"] = "close"
        try:
            resp = _SESSION.request(
                method,
                url,
                data=data,
                headers=headers,
                timeout=self.timeout,
            )
        except requests.exceptions.RequestException as e:
            last_err = e
            if attempt < retries - 1:
                continue
            raise agent_skill.AgentSkillError(
                f"Connection failed after {retries} attempts: {e}"
            ) from e

        if resp.status_code >= 400:
            try:
                d = resp.json()
                msg = d.get("message", d.get("error", f"HTTP {resp.status_code}"))
                details = d.get("details", "")
                if details:
                    msg = f"{msg}: {details}"
                raise agent_skill.AgentSkillError(msg, resp.status_code)
            except json.JSONDecodeError:
                raise agent_skill.AgentSkillError(
                    f"HTTP {resp.status_code}: {resp.text}",
                    resp.status_code,
                ) from None

        try:
            result = resp.json()
            break
        except json.JSONDecodeError as e:
            last_err = ValueError(f"Bad JSON body: {resp.text[:200]}")
            if attempt < retries - 1:
                continue
            raise agent_skill.AgentSkillError(str(last_err)) from e

    if result is None:
        raise agent_skill.AgentSkillError(f"Connection failed: {last_err}")
    if isinstance(result, dict) and result.get("code", 0) != 0:
        raise agent_skill.AgentSkillError(
            result.get("message", "Unknown error"),
            result.get("code", -1),
        )
    return result.get("data", result) if isinstance(result, dict) else result


def _patched_upload_file(self, local_path: str) -> str:
    import os
    import subprocess
    path = f"{self.prefix}/file/upload"
    url = f"{self.base_url}{path}"
    headers = self._sign("POST", path)
    headers["User-Agent"] = "LovartAgentSkill/1.0"
    cmd = ["curl", "-sS", "--max-time", str(int(self.timeout)),
           "-X", "POST", url]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    cmd += ["-F", f"file=@{local_path};type=application/octet-stream"]
    try:
        raw = subprocess.check_output(cmd, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as e:
        raise agent_skill.AgentSkillError(f"Upload curl failed: {e.stderr.decode()[:200]}") from e
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as e:
        raise agent_skill.AgentSkillError(f"Upload response not JSON: {raw[:200]}") from e
    if result.get("code") != 0:
        raise agent_skill.AgentSkillError(f"Upload failed: {result.get('message', 'unknown error')}")
    return result["data"]["url"]


agent_skill.AgentSkill._request = _patched_request
agent_skill.AgentSkill.upload_file = _patched_upload_file
agent_skill.main()
