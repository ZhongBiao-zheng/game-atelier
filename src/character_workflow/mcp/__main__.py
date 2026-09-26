"""Run with the default or a given protected credential file; never starts or bootstraps viewer-server."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from character_workflow.mcp.client import AdapterError, WorkshopClient
from character_workflow.mcp.server import create_server


def main() -> int:
    parser = argparse.ArgumentParser(description="Atelier Workshop stdio MCP adapter")
    # 省略时读默认授权的固定凭据（<data_root>/.config/connections/agent.json），插件自带的配置就这么写。
    parser.add_argument("--credentials", type=Path)
    args = parser.parse_args()
    client = WorkshopClient(args.credentials)
    # 凭据与 viewer-server 都等到调用时才检查：Agent 宿主常先于授权或工坊启动，启动即退出会让整个会话工具不可见。
    # 缺授权 / 服务未起时每次调用返回可操作的错误与指引；授权补上后下一次调用直接可用。
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
