"""按网址获取供应商图标（PLAN §8.3，I1 6/n）。

所有请求都走 outbound_guard（trusted=None）：只 http(s)、只公网地址、按校验过的 IP 建连、
重定向逐跳重查、不带鉴权头与 Cookie。先读页面里的 <link rel=icon / apple-touch-icon>，
再试 /favicon.ico；取到的内容走与上传同一个 normalize。不用第三方 favicon 服务。
"""
from __future__ import annotations

import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import requests

from character_workflow.lib import outbound_guard, provider_icons

PAGE_MAX_BYTES = 512 * 1024
MAX_CANDIDATES = 4
TOTAL_SECONDS = 15.0
_TIMEOUT = (5.0, 5.0)
_TOUCH_RELS = {"apple-touch-icon", "apple-touch-icon-precomposed"}
_ICON_RELS = {"icon"} | _TOUCH_RELS
NOT_FOUND = "没有找到图标"
_now = time.monotonic


class IconNotFound(ValueError):
    """页面与候选都取不到能用的图标；消息直接给用户看。"""


def _declared_size(rel: set[str], sizes: str) -> int:
    best = 0
    for token in sizes.lower().split():
        width, _, height = token.partition("x")
        if width.isdigit() and height.isdigit():
            best = max(best, int(width), int(height))
    # apple-touch-icon 不写 sizes 时按惯例是 180。
    return best or (180 if rel & _TOUCH_RELS else 0)


class _IconLinks(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.base: str | None = None
        self.links: list[tuple[int, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): (value or "") for name, value in attrs}
        href = values.get("href", "").strip()
        if tag == "base" and self.base is None and href:
            self.base = href
        if tag != "link" or not href or href.lower().startswith("data:"):
            return
        rel = set(values.get("rel", "").lower().split())
        if not rel & _ICON_RELS:
            return
        # SVG 反正会被 normalize 拒绝，不占候选名额。
        if values.get("type", "").lower() == "image/svg+xml" or urlsplit(href).path.lower().endswith(".svg"):
            return
        self.links.append((_declared_size(rel, values.get("sizes", "")), href))


def candidates(page_url: str, html: str) -> list[str]:
    """页面声明的图标按尺寸从大到小，最后补 /favicon.ico；去重后最多 4 个，只留 http(s)。"""
    parser = _IconLinks()
    try:
        parser.feed(html)
    except Exception:  # noqa: BLE001 —— 坏 HTML 只是少几个候选
        pass
    base = urljoin(page_url, parser.base) if parser.base else page_url
    ordered = [urljoin(base, href) for _, href in sorted(parser.links, key=lambda item: -item[0])]
    ordered.append(urljoin(page_url, "/favicon.ico"))
    out: list[str] = []
    for url in ordered:
        if urlsplit(url).scheme in ("http", "https") and url not in out:
            out.append(url)
    return out[:MAX_CANDIDATES]


def fetch_site_icon(url: str) -> str:
    """取网址对应站点的图标，落盘后返回 `file:<sha256>`；取不到抛 IconNotFound。"""
    deadline = _now() + TOTAL_SECONDS
    page_error: Exception | None = None
    html = ""
    try:
        body, content_type = outbound_guard.fetch_document(url, max_bytes=PAGE_MAX_BYTES, timeout=_TIMEOUT)
        if provider_icons.is_image(body):
            # 用户直接填了图片地址。
            try:
                return provider_icons.store(body)
            except provider_icons.IconRejected as error:
                page_error = error
        elif "html" in content_type.lower() or body.lstrip()[:1] == b"<":
            html = body.decode("utf-8", "replace")
    except (outbound_guard.OutboundError, requests.RequestException) as error:
        page_error = error
    for candidate in candidates(url, html):
        if _now() > deadline:
            break
        try:
            raw = outbound_guard.fetch(candidate, max_bytes=provider_icons.MAX_BYTES, timeout=_TIMEOUT)
            return provider_icons.store(raw)
        except (outbound_guard.OutboundError, requests.RequestException, provider_icons.IconRejected):
            continue
    if isinstance(page_error, outbound_guard.OutboundError):
        raise IconNotFound(f"{NOT_FOUND}：{page_error}")
    raise IconNotFound(NOT_FOUND)
