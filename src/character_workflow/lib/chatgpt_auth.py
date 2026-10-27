"""Read the local Codex ChatGPT login without copying secrets into Atelier keys."""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time

import requests

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import _replace_with_retry
from character_workflow.lib.file_lock import file_lock

LOGIN_REQUIRED = "请先在 Codex 里用 ChatGPT 登录"
LOGIN_EXPIRED = "登录已失效，请在 Codex 里重新登录"


class ChatGPTAuthError(RuntimeError):
    pass


@dataclass(frozen=True)
class Credentials:
    access_token: str = field(repr=False)
    account_id: str


def auth_path() -> Path:
    return (Path(os.environ["CODEX_HOME"]).expanduser() if os.environ.get("CODEX_HOME")
            else Path.home() / ".codex") / "auth.json"


def _read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ChatGPTAuthError(LOGIN_REQUIRED) from None
    if not isinstance(value, dict) or value.get("auth_mode") != "chatgpt":
        raise ChatGPTAuthError(LOGIN_REQUIRED)
    tokens = value.get("tokens")
    if not isinstance(tokens, dict) or not all(
        isinstance(tokens.get(k), str) and tokens[k] for k in ("access_token", "account_id")
    ):
        raise ChatGPTAuthError(LOGIN_REQUIRED)
    return value


def _claims(token: str) -> dict:
    # Claims are display/expiry hints, never a substitute for server authentication.
    if not isinstance(token, str):
        return {}
    try:
        body = token.split(".")[1]
        value = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        return value if isinstance(value, dict) else {}
    except (ValueError, IndexError, TypeError):
        return {}


def get_auth_status() -> dict:
    try:
        tokens = _read(auth_path())["tokens"]
    except ChatGPTAuthError:
        return {"available": False, "email": None, "plan": None}
    claims = _claims(tokens.get("id_token", ""))
    auth = claims.get("https://api.openai.com/auth", {})
    email = claims.get("email")
    plan = auth.get("chatgpt_plan_type") if isinstance(auth, dict) else None
    return {"available": True, "email": email if isinstance(email, str) else None,
            "plan": plan if isinstance(plan, str) else None}


def _credentials(value: dict) -> Credentials:
    return Credentials(value["tokens"]["access_token"], value["tokens"]["account_id"])


def _needs_refresh(value: dict) -> bool:
    expiry = _claims(value["tokens"]["access_token"]).get("exp")
    return not isinstance(expiry, (int, float)) or expiry < time.time() + 180


def _write_private(path: Path, value: dict) -> None:
    # mkstemp starts at 0600; no interval exposes the rotated tokens to other users.
    fd, name = tempfile.mkstemp(prefix=".auth-", suffix=".tmp", dir=path.parent)
    tmp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        from character_workflow.lib.keys import _restrict_permissions
        _restrict_permissions(tmp)
        _replace_with_retry(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def get_credentials(*, rejected_access_token: str | None = None) -> Credentials:
    """Reload credentials; refresh a rejected token only if no other process replaced it."""
    path = auth_path().resolve()
    value = _read(path)
    if not _needs_refresh(value) and value["tokens"]["access_token"] != rejected_access_token:
        return _credentials(value)
    digest = hashlib.sha256(str(path).encode()).hexdigest()[:20]
    # Serializes Atelier processes. Codex CLI does not participate in this lock;
    # re-read before writing so an observed CLI login/rotation is never overwritten.
    with file_lock(data_root.runtime_dir() / f"chatgpt-auth-{digest}.lock"):
        value = _read(path)
        if not _needs_refresh(value) and value["tokens"]["access_token"] != rejected_access_token:
            return _credentials(value)
        refresh = value["tokens"].get("refresh_token")
        if not isinstance(refresh, str) or not refresh:
            raise ChatGPTAuthError(LOGIN_EXPIRED)
        try:
            response = requests.post(
                "https://auth.openai.com/oauth/token",
                json={"client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
                      "grant_type": "refresh_token", "refresh_token": refresh,
                      "scope": "openid profile email"},
                timeout=(10, 30),
                allow_redirects=False,
            )
        except requests.RequestException:
            raise ChatGPTAuthError("无法刷新 Codex 登录，请检查网络后重试") from None
        latest = _read(path)
        if latest["tokens"] != value["tokens"]:
            if _needs_refresh(latest):
                raise ChatGPTAuthError("Codex 登录正在更新，请稍后重试")
            return _credentials(latest)
        if response.status_code != 200:
            raise ChatGPTAuthError(LOGIN_EXPIRED)
        try:
            updated = response.json()
            if not isinstance(updated, dict) or not all(
                isinstance(updated.get(k), str) and updated[k]
                for k in ("access_token", "refresh_token")
            ):
                raise ValueError
        except ValueError:
            raise ChatGPTAuthError("Codex 登录刷新响应无效，请重新登录") from None
        latest["tokens"].update({k: updated[k] for k in (
            "access_token", "refresh_token", "id_token"
        ) if isinstance(updated.get(k), str) and updated[k]})
        latest["last_refresh"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        _write_private(path, latest)
        return _credentials(latest)
