"""Compare fresh Tuzi GET /v1/models connections in shell and job proxy environments.

Run with uv run python scripts/probe_tuzi_tls.py. Emits JSON lines; only module, function
and line numbers are included in traces. Each matrix cell uses 20 independent GETs.
"""
from __future__ import annotations

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
import os
import ssl
import sys
import traceback
from urllib.parse import urlsplit

import requests

from character_workflow.lib import keys, net_env
from character_workflow.lib.callers.connect_failure import (
    initial_handshake_eof, tls_failure_details, transport_causes,
)

URL = "https://api.tu-zi.com/v1/models"
COUNT = 20


def proxy_ports(proxies):
    return {name: urlsplit(value if "://" in value else "//" + value).port
            for name, value in proxies.items() if name in {"http", "https", "all", "socks"}}


def probe(token):
    try:
        # requests.get creates a fresh Session like the image POST. Consume the response
        # so body read failures are included. Do not follow redirects or display any body.
        with requests.get(URL, headers={"Authorization": "Bearer " + token}, timeout=(8, 12),
                          allow_redirects=False) as response:
            return {"result": f"HTTP_{response.status_code}"}
    except requests.RequestException as error:
        chain = list(transport_causes(error))
        phase, version = tls_failure_details(error) or ("unknown", None)
        return {"result": type(error).__name__, "stage": phase, "tls": version,
                "ssl_eof": any(isinstance(c, ssl.SSLEOFError) for c in chain),
                "initial_handshake_eof": isinstance(error, requests.exceptions.SSLError)
                and initial_handshake_eof(error),
                "trace": [{"type": type(c).__name__, "frames": [
                    f"{frame.f_globals.get('__name__')}.{frame.f_code.co_name}:{line}"
                    for frame, line in traceback.walk_tb(c.__traceback__)]} for c in chain]}


def emit(**row):
    print(json.dumps(row, ensure_ascii=False), flush=True)


def main():
    try:
        configured_keys = keys.read_keys_db().keys
    except (ValueError, OSError, keys.KeysFileCorruptedError):
        raise SystemExit("无法读取本机渠道配置") from None
    token = next((key.access_key for key in configured_keys if key.enabled
                  and key.access_key and urlsplit(key.base_url or "").hostname == "api.tu-zi.com"), None)
    if not token:
        raise SystemExit("找不到 api.tu-zi.com 的启用密钥")
    if sys.platform == "darwin":
        from urllib.request import getproxies_macosx_sysconf
        emit(system_proxy_ports=proxy_ports(getproxies_macosx_sysconf()))
    emit(python=sys.version.split()[0], openssl=ssl.OPENSSL_VERSION, requests=requests.__version__)
    for mode in ("shell", "configured"):
        if mode == "configured":
            net_env.configure_proxy_bypass()
        proxies = requests.utils.get_environ_proxies(URL)
        selected = requests.utils.select_proxy(URL, proxies)
        emit(mode=mode, env_proxy_ports=proxy_ports({k.lower().removesuffix("_proxy"): v
             for k, v in os.environ.items() if k.lower().endswith("_proxy")}),
             selected_proxy=bool(selected),
             selected_ports=proxy_ports({"https": selected}) if selected else {})
        for workers in (1, 3, 10, 20):
            counts, stages = Counter(), Counter()
            with ThreadPoolExecutor(max_workers=workers) as pool:
                for index, row in enumerate(pool.map(probe, [token] * COUNT), 1):
                    counts[row["result"]] += 1
                    if row.get("ssl_eof"):
                        stages[row["stage"]] += 1
                    if "trace" in row:
                        emit(mode=mode, workers=workers, sample=index, **row)
            emit(mode=mode, workers=workers, count=COUNT, results=counts, ssl_eof_stages=stages)


if __name__ == "__main__":
    main()
