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
    try:
        client.connect()
        create_server(client).run(transport="stdio")
    except AdapterError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 2
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
