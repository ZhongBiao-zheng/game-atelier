"""Run with python -m scripts.agent_eval [run|preflight|compare] --help."""

import sys


def main(argv=None):
    if sys.platform not in {"darwin", "linux"}:
        print("评测脚本只支持 macOS 与 Linux", file=sys.stderr)
        return 2

    from . import cli

    return cli.main(argv)


if __name__ == "__main__":
    sys.exit(main())
