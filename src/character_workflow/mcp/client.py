"""Bounded, loopback-only HTTP transport; business rules stay in viewer-server."""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import requests
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


MAX_RESPONSE_BYTES = 1024 * 1024
_WORKSHOP_OPERATIONS = (
    "list-projects", "list-targets", "get-context", "list-models", "create-target", "read-document",
    "write-document", "acknowledge-feedback", "list-media", "read-media",
    "prepare-generation", "get-generation", "withdraw-generation", "approve-generation",
    "read-lessons", "append-lesson",
)
_CANVAS_OPERATIONS = (
    "list-projects", "get-document", "list-models", "apply-changes", "import-media", "run",
    "get-run", "read-media",
)
# 操作名 → 本机 HTTP 路径。画布操作以 "canvas-" 前缀区分，工具名相应为 canvas_*。
OPERATIONS: dict[str, str] = {
    **{name: f"/api/workshop/{name}" for name in _WORKSHOP_OPERATIONS},
    **{f"canvas-{name}": f"/api/canvas-agent/{name}" for name in _CANVAS_OPERATIONS},
}
_ERROR_MESSAGES = {
    "CONNECTION_REQUIRED": "请在本机 Atelier 管理页重新授权 Agent。",
    "SESSION_REQUIRED": "请在本机 Atelier 管理页重新授权 Agent。",
    "SESSION_EXPIRED": "工坊连接已过期，请重新授权后连接。",
    "SESSION_REVOKED": "工坊授权已撤销，请在本机管理页重新授权。",
    "CAPABILITY_DENIED": "当前 Agent 没有此操作的授权。",
    "TARGET_NOT_AUTHORIZED": "目标不在此 Agent 的授权项目范围内。",
    "DOCUMENT_CONFLICT": "文档已更新，请重新读取完整内容后再修改。",
    "REFERENCE_NOT_ALLOWED": "参考素材不属于已授权目标。",
    "MODEL_UNAVAILABLE": "模型不可用，请重新读取工坊模型列表。",
    "INVALID_PARAMETERS": "生成参数不符合模型能力，请检查数量、质量、时长和参考素材。",
    "INVALID_TARGET": "目标信息无效，请使用已授权项目和工具返回的完整目标。",
    "DOCUMENT_NOT_ALLOWED": "当前目标不支持此文档类型，请核对文档与目标归属。",
    "CONTENT_TOO_LARGE": "内容超过本次操作的大小限制，请缩小范围。",
    "QUEUE_FULL": "执行队列已满，请在本机页面核对已保存请求，不要重新创建付费任务。",
    "APPROVAL_REQUIRED": "请在 Atelier 页面人工批准本次生成。",
    "REQUEST_EXPIRED": "生成请求已过期，需要重新准备并批准。",
    "IDEMPOTENCY_CONFLICT": "幂等键已用于不同内容，请检查本次操作。",
    "EXECUTION_NEEDS_REVIEW": "生成执行状态不明，请在 Atelier 人工核对，不要自动重试。",
    "INSTANCE_CHANGED": "本机服务实例已变化，请重新连接。",
    "PROTOCOL_MISMATCH": "本机服务协议不匹配，请更新 Atelier 后连接。",
    "CONNECTION_RATE_LIMITED": "调用过于频繁，请稍后重试。",
    "REVISION_CONFLICT": "内容修订已变化，请重新读取后再操作。",
}
_PRIVATE_KEYS = frozenset({
    "access_key", "secret_key", "api_key", "grant_token", "session_token", "authorization",
    "data_root", "output_paths", "source_image", "absolute_path", "credential_path",
})


class AdapterError(Exception):
    def __init__(self, code: str, message: str, request_id: str | None = None):
        self.code = code
        self.message = message
        self.request_id = request_id
        super().__init__(message)

    def payload(self) -> dict:
        result = {"code": self.code, "message": self.message}
        if self.request_id:
            result["request_id"] = self.request_id
        return {"error": result}


def _parse_expiry(value: str) -> datetime:
    try:
        expiry = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("expected an ISO timestamp") from None
    if expiry.tzinfo is None:
        raise ValueError("expected a timezone")
    return expiry


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    service: Literal["game-atelier"]
    base_url: str
    grant_id: str = Field(min_length=1, max_length=128)
    grant_token: str = Field(min_length=20, max_length=512, repr=False)
    expires_at: str = Field(max_length=64)

    @field_validator("base_url")
    @classmethod
    def loopback_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        try:
            port = parsed.port
        except ValueError:
            raise ValueError("expected a loopback port") from None
        if (
            parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not port
            or parsed.netloc != f"127.0.0.1:{port}" or parsed.path or parsed.query
            or parsed.fragment or value != f"http://127.0.0.1:{port}"
        ):
            raise ValueError("expected an exact loopback URL")
        return value

    @field_validator("expires_at")
    @classmethod
    def expiry(cls, value: str) -> str:
        _parse_expiry(value)
        return value


class ServiceStatus(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    service: Literal["game-atelier"]
    instance_id: str = Field(min_length=1, max_length=128)
    app_version: str = Field(max_length=128)
    protocol: Literal["atelier-local/1"]


class ToolSession(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    session_token: str = Field(min_length=20, max_length=512, repr=False)
    session_id: str = Field(min_length=1, max_length=128)
    expires_at: str = Field(max_length=64)
    instance_id: str = Field(min_length=1, max_length=128)
    capabilities: list[str] = Field(max_length=16)
    project_ids: list[str] = Field(max_length=128)
    canvas_project_ids: list[str] = Field(default_factory=list, max_length=128)

    @field_validator("expires_at")
    @classmethod
    def expiry(cls, value: str) -> str:
        _parse_expiry(value)
        return value


def load_credentials(path: Path) -> Credentials:
    # The OS owner/ACL check is shared with the management page's credential writer.
    from character_workflow.lib.private_json import read_private_json

    try:
        result = Credentials.model_validate(read_private_json(path))
    except (OSError, ValueError, ValidationError):
        raise AdapterError(
            "CREDENTIALS_INVALID", "无法读取受保护的 Agent 凭据，请在本机管理页重新授权。",
        ) from None
    if _parse_expiry(result.expires_at) <= datetime.now(timezone.utc):
        raise AdapterError("SESSION_EXPIRED", _ERROR_MESSAGES["SESSION_EXPIRED"])
    return result


def _safe_result(value: object, depth: int = 0) -> bool:
    if depth > 32:
        return False
    if isinstance(value, dict):
        return all(
            key.lower() not in _PRIVATE_KEYS and _safe_result(item, depth + 1)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return all(_safe_result(item, depth + 1) for item in value)
    return True


class WorkshopClient:
    def __init__(self, credentials: Credentials):
        self._credentials = credentials
        self._http = requests.Session()
        self._http.trust_env = False
        self._http.headers.update({"Accept": "application/json"})
        self._session: ToolSession | None = None
        self._lock = threading.Lock()

    def close(self) -> None:
        self._http.close()

    def _request(self, method: str, path: str, payload: dict | None = None) -> dict:
        headers = {}
        if self._session is not None and path.startswith(("/api/workshop/", "/api/canvas-agent/")):
            headers["Authorization"] = f"Bearer {self._session.session_token}"
        try:
            with self._http.request(
                method, self._credentials.base_url + path, json=payload, headers=headers,
                allow_redirects=False, timeout=(3, 30), stream=True,
            ) as response:
                if 300 <= response.status_code < 400:
                    raise AdapterError("RESPONSE_INVALID", "本机服务返回了不允许的重定向。")
                if response.headers.get("content-type", "").split(";", 1)[0] != "application/json":
                    raise AdapterError("RESPONSE_INVALID", "本机服务返回格式不正确。")
                parts = bytearray()
                for chunk in response.iter_content(chunk_size=8192):
                    parts.extend(chunk)
                    if len(parts) > MAX_RESPONSE_BYTES:
                        raise AdapterError("RESPONSE_TOO_LARGE", "结果过大，请缩小分页或读取范围。")
                try:
                    result = json.loads(parts)
                except (ValueError, RecursionError):
                    raise AdapterError("RESPONSE_INVALID", "本机服务返回格式不正确。") from None
                if not isinstance(result, dict):
                    raise AdapterError("RESPONSE_INVALID", "本机服务返回格式不正确。")
                if response.status_code >= 400:
                    error = result.get("error")
                    error = error if isinstance(error, dict) else {}
                    code = error.get("code")
                    code = (
                        code if isinstance(code, str) and code in _ERROR_MESSAGES
                        else "WORKSHOP_REQUEST_FAILED"
                    )
                    request_id = error.get("request_id")
                    if not (
                        isinstance(request_id, str) and len(request_id) <= 128
                        and request_id.replace("-", "").replace("_", "").isalnum()
                    ):
                        request_id = None
                    raise AdapterError(
                        code, _ERROR_MESSAGES.get(code, "工坊操作失败，请在本机页面检查。"), request_id,
                    )
                return result
        except requests.RequestException:
            # No retry after an ambiguous write: the server may already have committed it.
            raise AdapterError(
                "LOCAL_SERVICE_UNAVAILABLE",
                "无法连接本机 Atelier。请先启动本机服务；若操作已提交，请查询状态而非重复生成。",
            ) from None

    def _connect(self, status: ServiceStatus) -> None:
        if _parse_expiry(self._credentials.expires_at) <= datetime.now(timezone.utc):
            raise AdapterError("SESSION_EXPIRED", _ERROR_MESSAGES["SESSION_EXPIRED"])
        result = self._request("POST", "/api/connection/agent-sessions", {
            "grant_id": self._credentials.grant_id,
            "grant_token": self._credentials.grant_token,
            "instance_id": status.instance_id,
        })
        try:
            session = ToolSession.model_validate(result)
        except ValidationError:
            raise AdapterError("RESPONSE_INVALID", "本机服务返回的会话格式不正确。") from None
        if session.instance_id != status.instance_id:
            raise AdapterError("INSTANCE_CHANGED", _ERROR_MESSAGES["INSTANCE_CHANGED"])
        if _parse_expiry(session.expires_at) <= datetime.now(timezone.utc):
            raise AdapterError("SESSION_EXPIRED", _ERROR_MESSAGES["SESSION_EXPIRED"])
        self._session = session

    def _status(self) -> ServiceStatus:
        try:
            return ServiceStatus.model_validate(self._request("GET", "/api/connection/status"))
        except ValidationError:
            raise AdapterError("PROTOCOL_MISMATCH", _ERROR_MESSAGES["PROTOCOL_MISMATCH"]) from None

    def connect(self) -> None:
        with self._lock:
            self._connect(self._status())

    def call(self, operation: str, payload: BaseModel) -> dict:
        if operation not in OPERATIONS:
            raise AdapterError("TOOL_NOT_ALLOWED", "此操作不属于工坊工具。")
        with self._lock:
            status = self._status()
            if (
                self._session is None or self._session.instance_id != status.instance_id
                or _parse_expiry(self._session.expires_at) <= datetime.now(timezone.utc)
            ):
                self._connect(status)
            try:
                result = self._request(
                    "POST", OPERATIONS[operation], payload.model_dump(mode="json"),
                )
            except AdapterError as error:
                if error.code != "SESSION_EXPIRED":
                    raise
                # SESSION_EXPIRED is emitted before the route reads or executes the operation.
                self._session = None
                self._connect(self._status())
                result = self._request(
                    "POST", OPERATIONS[operation], payload.model_dump(mode="json"),
                )
            if not _safe_result(result):
                raise AdapterError("RESPONSE_INVALID", "工坊响应包含不允许通过工具返回的字段。")
            return result
