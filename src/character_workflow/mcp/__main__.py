"""Run with a protected credential file; never starts or bootstraps viewer-server."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from character_workflow.mcp.client import AdapterError, WorkshopClient, load_credentials
from character_workflow.mcp.server import create_server


def main() -> int:
    parser = argparse.ArgumentParser(description="Atelier Workshop stdio MCP adapter")
    parser.add_argument("--credentials", type=Path, required=True)
    args = parser.parse_args()
    try:
        credentials = load_credentials(args.credentials)
    except AdapterError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 2
    client = WorkshopClient(credentials)
    # 不在启动时连 viewer-server：Agent 宿主常先于工坊启动，启动即退出会让整个会话工具不可见。
    # 会话按需建立（call 内部），服务未起时每次调用返回 LOCAL_SERVICE_UNAVAILABLE 与启动指引。
    try:
        create_server(client).run(transport="stdio")
    except AdapterError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 2
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
