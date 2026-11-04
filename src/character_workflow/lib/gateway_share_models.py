"""共享中转的公开清单与本机发布状态；路径、配方不属于传输模型。"""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from character_workflow.lib.schemas import TEAM_ASSET_ID_PATTERN

SHARE_ID_PATTERN = r'^sh_[a-z0-9]{12}$'
SHA_PATTERN = r'^[a-f0-9]{64}$'
MEMBER_LIBRARY_PATTERN = r'^ms_[a-f0-9]{12}_sh_[a-z0-9]{12}$'
MAX_FILE_BYTES = 500 * 1024 * 1024


class SharedBlob(BaseModel):
    model_config = ConfigDict(extra='forbid')
    sha256: str = Field(pattern=SHA_PATTERN)
    size: int = Field(ge=1, le=MAX_FILE_BYTES)


class SharedFile(SharedBlob):
    filename: str = Field(min_length=1, max_length=255)

    @field_validator('filename')
    @classmethod
    def safe_filename(cls, value):
        if value.startswith('.') or any(c in value for c in '/\\:\r\n\x00'):
            raise ValueError('文件名不合法')
        return value


class SharedManifestEntry(BaseModel):
    model_config = ConfigDict(extra='forbid')
    entry_id: str = Field(pattern=TEAM_ASSET_ID_PATTERN)
    kind: Literal['raw', 'media', 'generation', 'prompt']
    title: str = Field(min_length=1, max_length=1000)
    author: str | None = None
    mime_type: str | None = Field(default=None, pattern=r'^(image/(png|jpeg|webp|gif)|video/(mp4|webm|quicktime)|audio/(mpeg|wav|x-wav|ogg|mp4|flac|aac|webm)|text/plain)$')
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    duration_s: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    tags: list[str] = Field(default_factory=list, max_length=100)
    category: str | None = None
    prompt_text: str | None = Field(default=None, max_length=200000)
    file: SharedFile | None = None
    previews: list[SharedBlob] = Field(default_factory=list, max_length=8)

    @model_validator(mode='after')
    def content_kind(self):
        if self.kind == 'prompt':
            if self.file is not None or self.mime_type not in {None, 'text/plain'}:
                raise ValueError('提示词不能携带媒体原文件')
        elif self.prompt_text is not None or self.previews or self.file is None or not self.mime_type or self.mime_type == 'text/plain':
            raise ValueError('媒体条目需要文件且不能携带提示词快照')
        return self


class SharedLibraryManifest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    share_id: str = Field(pattern=SHARE_ID_PATTERN)
    name: str = Field(min_length=1, max_length=120)
    owner_name: str = Field(default='', max_length=40)
    updated_at: str = Field(min_length=1, max_length=64)
    entries: list[SharedManifestEntry] = Field(max_length=10000)

    @model_validator(mode='after')
    def unique_entries_and_sizes(self):
        if len({e.entry_id for e in self.entries}) != len(self.entries):
            raise ValueError('条目标识重复')
        sizes = {}
        for e in self.entries:
            for blob in [*e.previews, *([e.file] if e.file else [])]:
                if blob.sha256 in sizes and sizes[blob.sha256] != blob.size:
                    raise ValueError('同一文件的大小不一致')
                sizes[blob.sha256] = blob.size
        return self


class GatewayPublishTarget(BaseModel):
    model_config = ConfigDict(extra='forbid')
    synced_at: str | None = None
    error: str | None = None
    status: Literal['pending', 'syncing', 'synced', 'failed', 'stopped'] = 'pending'
    uploaded: int = 0
    total: int = 0
    delete_pending: bool = False


class GatewayLibraryPublish(BaseModel):
    model_config = ConfigDict(extra='forbid')
    share_id: str = Field(pattern=SHARE_ID_PATTERN)
    gateways: dict[str, GatewayPublishTarget] = Field(default_factory=dict)


class TeamLibraryGatewayState(BaseModel):
    model_config = ConfigDict(extra='forbid')
    shared_library_ids: list[str] = Field(default_factory=list)
    publishes: dict[str, GatewayLibraryPublish] = Field(default_factory=dict)
