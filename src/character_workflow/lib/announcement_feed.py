"""模型公告源：随安装包打包一份，启动后再从 main 分支拉最新的同一个文件，只发公告不用发版。

数据文件 `character_workflow/data/announcements.json`（新的在前）。每条的 `version` 是能看到这条公告
所需的最低版本：模型要改代码才能用，就随那一版发，填那一版；只发公告不改代码，填当时已发布的最新版本。
本机版本低于 `version` 的公告不返回 —— 老客户端还没有那份能力登记，「快速添加」加进去也用不对。

远程源只认仓库自己的两个 raw 地址（先 CNB 后 GitHub），校验通过才写缓存；拉取失败用上次缓存，
没有缓存用打包的那份。远程内容只当数据：文本由前端转义渲染，图片只收 https 外链。
"""
from __future__ import annotations

import logging
import threading
import time
from importlib.resources import files
from pathlib import Path
from typing import Any

import requests
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json

SYNC_INTERVAL_SECONDS = 6 * 3600
_PATH = "src/character_workflow/data/announcements.json"
REMOTE_URLS = (
    f"https://cnb.cool/ZhongBiao-zheng/game-atelier/-/git/raw/main/{_PATH}",
    f"https://raw.githubusercontent.com/ZhongBiao-zheng/game-atelier/main/{_PATH}",
)
_TIMEOUT = 15
_log = logging.getLogger(__name__)
_worker_started = False
_worker_lock = threading.Lock()


class AnnouncedModel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    ids: list[str] = Field(min_length=1, max_length=20)


class Announcement(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    id: str = Field(min_length=1, max_length=120)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    title: str = Field(min_length=1, max_length=120)
    summary: str = Field(max_length=2000)
    image_url: str = Field(alias="imageUrl", max_length=1000)
    models: list[AnnouncedModel] = Field(default_factory=list, max_length=20)

    @field_validator("image_url")
    @classmethod
    def _https_image(cls, value: str) -> str:
        if value and not value.startswith("https://"):
            raise ValueError("公告图片只接受 https 外链")
        return value


class AnnouncementFeed(BaseModel):
    model_config = ConfigDict(extra="forbid")
    announcements: list[Announcement] = Field(max_length=200)


def _cache_path() -> Path:
    return data_root.runtime_dir() / "announcements.json"


def bundled() -> AnnouncementFeed:
    text = files("character_workflow").joinpath("data/announcements.json").read_text(encoding="utf-8")
    return AnnouncementFeed.model_validate_json(text)


def _cached() -> AnnouncementFeed | None:
    try:
        return AnnouncementFeed.model_validate_json(_cache_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def sync() -> AnnouncementFeed | None:
    """依次拉远程源，第一份校验通过的写缓存；全部失败保留旧缓存。"""
    for url in REMOTE_URLS:
        try:
            response = requests.get(url, timeout=_TIMEOUT)
            response.raise_for_status()
            feed = AnnouncementFeed.model_validate(response.json())
        except (requests.RequestException, ValueError, ValidationError) as error:
            _log.warning("公告源拉取失败（%s）：%s", url, error)
            continue
        atomic_write_json(_cache_path(), feed.model_dump(mode="json", by_alias=True))
        return feed
    return None


def _version_key(version: str) -> tuple[int, ...]:
    """与 scripts/bootstrap.version_key 同规则（ADR-0032）：主版本 5 是永久退役的旧号段。"""
    parts = tuple(int(part) for part in version.split("."))
    return (0 if parts[0] == 5 else 1, *parts)


def visible(app_version: str) -> list[dict[str, Any]]:
    """本机能看到的公告：远程缓存优先，其次打包的那份；只留 version 不高于本机版本的。"""
    feed = _cached() or bundled()
    current = _version_key(app_version)
    return [item.model_dump(mode="json", by_alias=True) for item in feed.announcements
            if _version_key(item.version) <= current]


def start_background_sync() -> None:
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True

    def loop() -> None:
        while True:
            try:
                sync()
            except Exception:  # noqa: BLE001 — 公告刷新失败不能影响服务
                _log.exception("公告源同步失败")
            time.sleep(SYNC_INTERVAL_SECONDS)

    threading.Thread(target=loop, name="announcement-sync", daemon=True).start()
