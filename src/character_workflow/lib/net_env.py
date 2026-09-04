"""厂商 HTTP 调用的代理策略：国内聚合商直连，境外保留走代理。

国内聚合商（openai-hk / 火山 volces / 词元跳动 tokendance / 阿里 aliyuncs）都有国内入口，
不需要翻墙代理。可一旦本机挂着坏代理（VPN / Clash 等），requests / urllib / curl 默认会吃
HTTP_PROXY / 系统代理，把这些请求拖死——表现为「卡住」（代理接住连接却不转发，读超时）或
`ProxyError`（代理掐断连接），且供应商侧不计费（请求根本没到上游）。

做法：进程启动时把这些国内 host 追加进 NO_PROXY —— requests / urllib / curl 都认这个标准
环境变量，会对命中的 host 绕过代理直连，而其它 host（如 api.openai.com，国内访问常依赖代理）
照常走代理。无需改任何调用点，因此也不影响测试对 `requests` 的 monkeypatch。
"""
from __future__ import annotations

import os

# 强制直连的国内 host 后缀（这些厂商有国内入口，套代理只会坏事）。
# 末两个是 OpenAI-HK 出图后图片落地的国产 CDN：generations 回 b64+url（url 在 addmao.com，
# 用 b64 时根本不下载）；但 /images/edits（图生图）只回 url、host 在 aiproxy.vip，后端必须
# 去下载那张图。这两个 host 早先不在白名单 —— 坏代理下「上游已出图并计费、图却下不回来」
# （download image failed）正是这么来的：第一版 NO_PROXY 只放行了 API host，漏了图片 CDN。
DIRECT_HOST_SUFFIXES: tuple[str, ...] = (
    "openai-hk.com",
    "volces.com",
    "tokendance.space",
    "aliyuncs.com",
    "addmao.com",
    "aiproxy.vip",
    "tu-zi.com",
    "hf-mirror.com",  # 抠图模型下载（国内 Hugging Face 镜像）  # 兔子 API（国内聚合商）；实测：未放行时小火箭代理 1082 隧道不通 → ProxyError。
)

# 厂商 API 调用统一超时：(连接, 读取)。
# 连接分量放到 30s 不只为握手：urllib3 用 connect 超时兜住「请求体上传」阶段（read 超时只管
# 收响应），图生图要把 1.6MB+ 参考图（gpt-image multipart / seedream base64）传上去，10s 传不完
# 会在上传阶段抛 "write operation timed out"（实测）。
# 读取 300s：同步生成端点在出图完成前不吐字节，read 超时即「等首字节最长时间」= 整个生成耗时。
# 复杂生成（gpt-image 精灵图/精细图）真实可达 ~180s+；读超时若 ≈ 生成耗时（旧 180s）会在响应到达前
# 假超时 → _post_json 捕获 RequestException 重试 → 再跑一次完整生成 → 墙钟翻倍(实测 180s→350s)且
# 厂商双计费。300s 给足余量避免假超时重跑，同时挂死的上游仍 5min 内 fail（不回到旧的 600s）。
DEFAULT_TIMEOUT: tuple[float, float] = (30.0, 300.0)


def configure_proxy_bypass() -> None:
    """把国内厂商 host 追加进 NO_PROXY / no_proxy（幂等，保留用户已有条目）。

    requests / urllib / curl 都认 NO_PROXY：命中的 host 绕过系统/环境代理直连，
    其它 host 照常走代理。在出图 / 出视频进程入口调用即可，无需改调用点。
    """
    for var in ("NO_PROXY", "no_proxy"):
        existing = [p.strip() for p in os.environ.get(var, "").split(",") if p.strip()]
        for suffix in DIRECT_HOST_SUFFIXES:
            if suffix not in existing:
                existing.append(suffix)
        os.environ[var] = ",".join(existing)
