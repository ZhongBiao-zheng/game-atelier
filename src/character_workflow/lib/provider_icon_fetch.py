"""按网址获取供应商图标（PLAN §8.3，I1 6/n）。

所有请求都走 outbound_guard.fetch_bounded：只 http(s)；不带鉴权头与 Cookie；重定向逐跳重查；
整个过程（含读响应体）受 15 秒总时限约束。地址检查分两种情况：
- 没有配代理：按 DNS 解析结果只连公网地址，并按校验过的 IP 建连（防 DNS 重绑定）。
- 配了代理：本机拿不到真实 IP，交给代理解析；字面量私网 IP 与本机域名仍然拒绝。用户亲手填的
  首个地址按 ADR-0036 的既有规则，重定向目标与页面里解析出的候选只放行 https。
先读页面里的 <link rel=icon / apple-touch-icon>，再试 /favicon.ico；取到的内容走与上传同一个
normalize。不用第三方 favicon 服务。
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
_TOUCH_RELS = {"apple-touch-icon", "apple-touch-icon-precomposed"}
_ICON_RELS = {"icon"} | _TOUCH_RELS

NOT_FOUND = "没有找到图标"
BLOCKED = "不能使用本机或内网地址"
CONNECT_FAILED = "连接失败"


class IconNotFound(ValueError):
    """取不到能用的图标；消息只有一句原因，直接给用户看。"""


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
        # SVG 反正会被 normalize 拒绝，不占候选名额。只按字符串判，畸形 href 不能在这里抛错打断解析。
        path = href.split("#", 1)[0].split("?", 1)[0].lower()
        if values.get("type", "").lower() == "image/svg+xml" or path.endswith(".svg"):
            return
        self.links.append((_declared_size(rel, values.get("sizes", "")), href))


def _http_url(base: str, href: str) -> str | None:
    """按 base 解析 href；畸形（如非法 IPv6 字面量）或不是 http(s) 时返回 None，只跳过这一个。"""
    try:
        url = urljoin(base, href)
        return url if urlsplit(url).scheme in ("http", "https") else None
    except ValueError:
        return None


def candidates(page_url: str, html: str) -> list[str]:
    """页面声明的图标按尺寸从大到小，最后补 /favicon.ico；去重后最多 4 个，只留 http(s)。

    page_url 是跟完重定向后的最终地址：相对路径与 <base> 都按它解析。"""
    parser = _IconLinks()
    try:
        parser.feed(html)
    except Exception:  # noqa: BLE001 —— 坏 HTML 只是少几个候选
        pass
    base = (_http_url(page_url, parser.base) if parser.base else None) or page_url
    hrefs = [href for _, href in sorted(parser.links, key=lambda item: -item[0])]
    out: list[str] = []
    for url in [_http_url(base, href) for href in hrefs] + [_http_url(page_url, "/favicon.ico")]:
        if url is not None and url not in out:
            out.append(url)
    return out[:MAX_CANDIDATES]


def _reason(error: Exception) -> str:
    if isinstance(error, outbound_guard.OutboundBlocked):
        return BLOCKED
    if isinstance(error, outbound_guard.OutboundTooLarge):
        return provider_icons.TOO_LARGE
    if isinstance(error, provider_icons.IconRejected):
        return str(error)
    return CONNECT_FAILED


def fetch_site_icon(url: str) -> str:
    """取网址对应站点的图标，落盘后返回 `file:<sha256>`；取不到抛 IconNotFound（一句原因）。"""
    deadline = time.monotonic() + TOTAL_SECONDS
    html, page_url = "", url
    try:
        # 首个地址按上传的体积上限读（地址本身可能就是图片）；超过上限时读到上限为止，页面只要 head。
        page = outbound_guard.fetch_bounded(url, max_bytes=provider_icons.MAX_BYTES, deadline=deadline,
                                            truncate=True)
    except (outbound_guard.OutboundBlocked, outbound_guard.OutboundTimeout) as error:
        raise IconNotFound(_reason(error)) from None
    except (outbound_guard.OutboundError, requests.RequestException, ValueError) as error:
        page_error: Exception | None = error
    else:
        page_error, page_url = None, page.url
        if provider_icons.is_image(page.content):
            if page.truncated:
                raise IconNotFound(provider_icons.TOO_LARGE)
            try:
                return provider_icons.store(page.content)
            except provider_icons.IconRejected as error:
                raise IconNotFound(str(error)) from None
        if "html" in page.content_type.lower() or page.content.lstrip()[:1] == b"<":
            html = page.content[:PAGE_MAX_BYTES].decode("utf-8", "replace")
    for candidate in candidates(page_url, html):
        if time.monotonic() >= deadline:
            break
        try:
            raw = outbound_guard.fetch_bounded(candidate, max_bytes=provider_icons.MAX_BYTES,
                                               deadline=deadline, third_party=True).content
            return provider_icons.store(raw)
        except (outbound_guard.OutboundError, requests.RequestException, ValueError):
            # 地址不可用（含畸形主机名）、非图片响应、超限：换下一个候选。
            continue
    raise IconNotFound(_reason(page_error) if page_error is not None else NOT_FOUND)
