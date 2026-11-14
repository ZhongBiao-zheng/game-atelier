"""出站请求的目标检查：自定义接口的 base_url，以及按厂商响应去下载的结果地址。

结果地址来自第三方响应，不可信：只允许 http(s)、公网地址；按已校验的 IP 建连防 DNS 重绑定；
重定向逐跳重查；不带任何鉴权头。例外两种：
- 与供应商 base_url 同源（本机推理服务 / 自建网关会把结果放在自己身上）；
- 走用户配置的代理，或 Clash 等 TUN 模式的 Fake-IP（198.18.0.0/15，仅 https）——这两种情况
  本机拿不到真实 IP，只能交给代理 / TUN，否则开着代理的用户所有境外结果都下不来。
"""
from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from urllib.parse import SplitResult, urljoin, urlsplit, urlunsplit

import requests

from character_workflow.lib import data_root

FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")
_LINK_LOCAL = (ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("fe80::/10"))
_LOCAL_NAMES = ("localhost",)
_LOCAL_SUFFIXES = (".localhost", ".local", ".internal")
_MAX_REDIRECTS = 3
_HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "*/*"}

Origin = tuple[str, str, int]


class OutboundError(RuntimeError):
    pass


def _ip_literal(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        try:
            # libc 还接受 2130706433、0x7f.1 这类缩写 / 十进制 / 十六进制 IPv4 写法。
            ip = ipaddress.ip_address(socket.inet_aton(host))
        except OSError:
            return None
    # ::ffff:169.254.169.254 这类 IPv4 映射地址按它映射的 IPv4 判。
    mapped = getattr(ip, "ipv4_mapped", None)
    return mapped or ip


def _gateway_port() -> int | None:
    try:
        from character_workflow.lib.gateway_keys import read_config
        return read_config().port
    except Exception:  # noqa: BLE001 —— 网关配置读不出时不影响普通供应商
        return None


def origin(parts: SplitResult) -> Origin:
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return (parts.scheme, (parts.hostname or "").lower().rstrip("."), port)


def _split(url: str) -> SplitResult:
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 —— 非法端口在这里抛 ValueError
    except ValueError:
        raise OutboundError("地址无效") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise OutboundError("只支持 http / https 地址")
    if parts.username or parts.password or "%" in parts.hostname:
        raise OutboundError("地址里不能带账号密码")
    return parts


def _viewer_port() -> int | None:
    try:
        text = (data_root.runtime_dir() / "server.port").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return int(text) if text.isdigit() else None


def check_base_url(url: str | None) -> SplitResult:
    """自定义接口的服务地址：允许本机 / 局域网（自建服务是正当用法），拒绝链路本地与本服务自身。"""
    parts = _split((url or "").strip())
    if parts.query or parts.fragment:
        raise OutboundError("服务地址不能带查询参数")
    host = parts.hostname.lower().rstrip(".")
    ip = _ip_literal(host)
    if ip is not None and (ip.is_unspecified or ip.is_multicast
                           or any(ip in net for net in _LINK_LOCAL)):
        raise OutboundError("服务地址不能指向链路本地或广播地址")
    loopback = (host in _LOCAL_NAMES or host.endswith(".localhost")
                or (ip is not None and ip.is_loopback))
    port = origin(parts)[2]
    if loopback and port == _viewer_port():
        raise OutboundError("服务地址不能指向 Atelier 自己")
    # 局域网网关只挂在本机的局域网地址上：本机 / 私有地址 + 网关端口一律拒绝。
    local_or_private = loopback or (ip is not None and ip.is_private)
    if local_or_private and port == _gateway_port():
        raise OutboundError("服务地址不能指向 Atelier 的局域网网关")
    return parts


def _public_hostname(parts: SplitResult) -> str:
    host = parts.hostname.lower().rstrip(".")
    ip = _ip_literal(host)
    if host in _LOCAL_NAMES or host.endswith(_LOCAL_SUFFIXES):
        raise OutboundError("结果地址不能指向本机或私有网络")
    if ip is not None and (not ip.is_global or ip.is_multicast):
        raise OutboundError("结果地址不能指向本机或私有网络")
    return host.encode("idna").decode("ascii")


class _PinnedTLSAdapter(requests.adapters.HTTPAdapter):
    """连到校验过的 IP，同时按原域名做证书校验与 SNI。"""

    def __init__(self, hostname: str):
        self.hostname = hostname
        super().__init__(max_retries=0)

    def init_poolmanager(self, connections, maxsize, block=False, **pool_kwargs):
        super().init_poolmanager(connections, maxsize, block, server_hostname=self.hostname,
                                 assert_hostname=self.hostname, **pool_kwargs)


@contextmanager
def _open_public(url: str, parts: SplitResult, timeout) -> Iterator[requests.Response]:
    hostname = _public_hostname(parts)
    proxies = requests.utils.get_environ_proxies(url)
    with requests.Session() as session:
        # 一律不读环境凭据：trust_env 会把 ~/.netrc 里的账号密码附到结果地址上。
        session.trust_env = False
        if proxies.get(parts.scheme) or proxies.get("all"):
            # 走用户配置的代理：域名由代理解析，本机拿不到真实 IP，不做 IP 固定（ADR-0036）。
            # 代理显式传入，仍不读 netrc；字面量私网 IP 与本机域名在上面已拦下。
            with session.get(url, headers=_HEADERS, timeout=timeout, stream=True,
                             allow_redirects=False, proxies=proxies) as response:
                yield response
            return
        port = origin(parts)[2]
        try:
            answers = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        except OSError:
            raise requests.ConnectionError(f"结果地址域名无法解析：{hostname}") from None
        addresses = list(dict.fromkeys(ipaddress.ip_address(a[4][0]) for a in answers))
        public = all(ip.is_global and not ip.is_multicast for ip in addresses)
        fake = parts.scheme == "https" and all(
            (ip.is_global and not ip.is_multicast) or ip in FAKE_IP_NETWORK for ip in addresses)
        if not addresses or not (public or fake):
            raise OutboundError("结果地址不能指向本机或私有网络")
        if not public:
            # Fake-IP 由 TUN 接管，本机看不到真实目标；只放行 https（证书仍按域名校验）。
            with session.get(url, headers=_HEADERS, timeout=timeout, stream=True,
                             allow_redirects=False) as response:
                yield response
            return
        address = str(addresses[0])
        netloc = f"[{address}]:{port}" if ":" in address else f"{address}:{port}"
        pinned = urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))
        if parts.scheme == "https":
            session.mount("https://", _PinnedTLSAdapter(hostname))
        with session.get(pinned, headers={**_HEADERS, "Host": parts.netloc}, timeout=timeout,
                         stream=True, allow_redirects=False) as response:
            yield response


@contextmanager
def _open(url: str, trusted: Origin | None, timeout) -> Iterator[requests.Response]:
    parts = _split(url)
    if trusted is not None and origin(parts) == trusted:
        with requests.get(url, headers=_HEADERS, timeout=timeout, stream=True,
                          allow_redirects=False) as response:
            yield response
        return
    with _open_public(url, parts, timeout) as response:
        yield response


def read_limited(response: requests.Response, max_bytes: int,
                 sink: Callable[[bytes], None] | None = None) -> bytes:
    declared = response.headers.get("Content-Length", "")
    if declared.isdigit() and int(declared) > max_bytes:
        raise OutboundError(f"响应超过 {max_bytes // (1024 * 1024)} MB 上限")
    total = 0
    chunks: list[bytes] = []
    for chunk in response.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        total += len(chunk)
        if total > max_bytes:
            raise OutboundError(f"响应超过 {max_bytes // (1024 * 1024)} MB 上限")
        if sink is not None:
            sink(chunk)
        else:
            chunks.append(chunk)
    return b"".join(chunks)


def fetch(url: str, *, max_bytes: int, trusted: Origin | None = None,
          timeout: tuple[float, float] = (30.0, 180.0),
          sink: Callable[[bytes], None] | None = None) -> bytes:
    """下载一个结果地址。sink 给定时流式写出（视频），否则返回内容。"""
    current = url
    for _ in range(_MAX_REDIRECTS + 1):
        with _open(current, trusted, timeout) as response:
            if 300 <= response.status_code < 400 and response.headers.get("Location"):
                current = urljoin(current, response.headers["Location"])
                continue
            if response.status_code >= 400:
                raise OutboundError(f"下载结果失败：HTTP {response.status_code}")
            return read_limited(response, max_bytes, sink)
    raise OutboundError("下载结果时重定向次数过多")
