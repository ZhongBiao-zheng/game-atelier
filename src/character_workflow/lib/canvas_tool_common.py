"""Shared Canvas tool authorization errors and strict input types."""
from typing import Annotated, Any
from pydantic import BaseModel, ConfigDict, StringConstraints

Identifier = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$")]

class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

class CanvasToolError(ValueError):
    def __init__(self, code: str, message: str, status: int = 409):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def actor_id(principal: Any) -> str:
    if principal is None or principal.kind not in {"local", "agent"}:
        raise CanvasToolError("SESSION_REQUIRED", "请先连接本机工作区", 401)
    return "local" if principal.kind == "local" else principal.grant_id
