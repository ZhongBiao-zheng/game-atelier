"""Public input declarations shared by workflow storage and model discovery."""
from __future__ import annotations

from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator

Scalar = str | int | float | bool


def local_base_url(value: str | None) -> str:
    value = value or "http://127.0.0.1:8188"
    url = urlsplit(value)
    if (url.scheme not in {"http", "https"} or url.hostname not in {"localhost", "127.0.0.1"}
            or url.username or url.password or url.query or url.fragment
            or url.path not in {"", "/"}):
        raise ValueError("ComfyUI 只支持本机地址（127.0.0.1 / localhost）")
    port = url.port or (443 if url.scheme == "https" else 80)
    # Pin localhost to loopback; never use proxies or follow redirects in the client.
    return f"{url.scheme}://127.0.0.1:{port}"


class WorkflowOption(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    value: Scalar
    label: str = Field(min_length=1, max_length=160)


class WorkflowInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    id: str = Field(pattern=r"^[\w-]{1,80}$")
    label: str = Field(min_length=1, max_length=160)
    type: Literal["prompt", "text", "int", "float", "boolean", "select", "seed", "image", "mask"]
    node_id: str = Field(min_length=1, max_length=80)
    class_type: str = Field(min_length=1, max_length=160)
    field: str = Field(min_length=1, max_length=160)
    default: Scalar | None = None
    min: float | None = None
    max: float | None = None
    step: float | None = Field(default=None, gt=0)
    options: list[WorkflowOption] = Field(default_factory=list, max_length=10000)
    required: bool = True

    @model_validator(mode="after")
    def bounds(self):
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("最小值不能大于最大值")
        if self.type == "select" and not self.options:
            raise ValueError("下拉输入需要选项")
        return self
