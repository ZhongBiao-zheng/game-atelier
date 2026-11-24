"""Parse evaluation commands and run them on the selected checkout."""

import argparse
import hashlib
import math
import re
import subprocess
import sys
from contextlib import nullcontext
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import yaml

from .cases_io import inspect_cases, load_cases
from .driver import run_case
from .fake import FakeProvider
from .host import StartupError, serve
from .preflight import preflight
from .report import compare, write_report

HERE = Path(__file__).resolve().parent


def run(args):
    real = args.keys_from is not None
    providers = [p.strip() for p in (args.providers or "").split(",") if p.strip()]
    if real != bool(providers):
        raise ValueError("--keys-from 和 --providers 必须同时提供")
    if real and args.budget_cny is None:
        raise ValueError("真实运行必须提供 --budget-cny")
    if args.budget_cny is not None and (not math.isfinite(args.budget_cny) or args.budget_cny <= 0):
        raise ValueError("--budget-cny 必须为有限正数")
    models = list(dict.fromkeys(args.chat_model or ([] if real else ["eval/chat"])))
    if not models or any(not re.fullmatch(r"[^/\s]+/[^\s]+", m) for m in models):
        raise ValueError("对话模型须使用 --chat-model 别名/模型")
    if real and any(m.split("/", 1)[0] not in providers for m in models):
        raise ValueError("对话模型必须属于 --providers 指定的供应商")
    checking = real or args.command == "preflight"
    if checking:
        cases, manifest_issues = inspect_cases(args.cases, args.only, args.fixtures)
    else:
        cases = load_cases(args.cases, args.only, args.fixtures)
    rev = subprocess.run(
        ["git", "-C", str(args.server_root), "rev-parse", "--short", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    out = args.out or Path(".scratch/agent-eval") / f"{stamp}-{rev}"
    if args.command == "run" and out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise ValueError("--out 需要新目录或空目录")
    budget = Decimal(str(args.budget_cny)) if args.budget_cny is not None else None
    spent = Decimal(0)
    rows = []
    stop_reason = ""
    with nullcontext(None) if real else FakeProvider(models) as vendor:
        with serve(
            args.server_root,
            keys_from=args.keys_from,
            providers=providers,
            fake_keys=None if real else vendor.keys,
            preflight=checking,
        ) as api:
            if checking:
                if not preflight(api, cases, models, budget, manifest_issues):
                    return 2
                if args.command == "preflight":
                    return 0
                api.finish_preflight()
            out.mkdir(parents=True, exist_ok=True)
            try:
                for case in cases:
                    for model in models:
                        if budget is not None and spent >= budget * Decimal("0.9"):
                            stop_reason = "累计花费达到预算的 90%"
                        if stop_reason:
                            break
                        suffix = hashlib.sha256(model.encode()).hexdigest()[:12]
                        folder = f"{case['id']}-{suffix}"
                        row = run_case(
                            api,
                            case,
                            model,
                            args.fixtures,
                            out / folder,
                            float(budget - spent) if budget is not None else None,
                        )
                        row.update(
                            directory=folder,
                            server_commit=rev,
                            provider_mode="real" if real else "fake",
                        )
                        usage = row["usage"]
                        spent += Decimal(str(usage.get("total_cost_cny") or 0))
                        rows.append(api.scrub(row))
                        if row.get("reason") == "interrupted":
                            stop_reason = "评测被中断，已保存当前需求的部分结果"
                        elif budget is not None:
                            if spent > budget or row.get("reason") == "budget_exceeded":
                                stop_reason = "已超过预算"
                            elif not usage.get("cost_complete"):
                                stop_reason = "本次花费缺少可核对的账单或估价"
                        if stop_reason:
                            break
                    if stop_reason:
                        break
            finally:
                if rows:
                    rows[-1]["matrix_stop_reason"] = stop_reason or None
                write_report(out, rows)
    print(
        f"已记录 {len(rows)} / {len(cases) * len(models)} 项，报告在 {out.resolve() / 'index.html'}"
    )
    if stop_reason:
        print(stop_reason)
    return 130 if rows and rows[-1].get("reason") == "interrupted" else 0


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    cli = argparse.ArgumentParser(description="Atelier 内置 Agent 回归评测")
    commands = cli.add_subparsers(dest="command", required=True)
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("--server-root", type=Path, default=HERE.parents[1])
    p.add_argument("--cases", type=Path, default=HERE / "examples.yaml")
    p.add_argument("--fixtures", type=Path, default=HERE / "fixtures")
    p.add_argument("--only")
    p.add_argument("--keys-from", type=Path)
    p.add_argument("--providers")
    p.add_argument("--chat-model", action="append")
    p.add_argument("--budget-cny", type=float)
    p.add_argument("--out", type=Path)
    commands.add_parser("run", parents=[p], help="运行需求 × 对话模型")
    commands.add_parser("preflight", parents=[p], help="离线检查清单、模型登记与预算")
    c = commands.add_parser("compare", help="比对两次运行的指标与人工评分")
    c.add_argument("before", type=Path)
    c.add_argument("after", type=Path)
    c.add_argument("--out", type=Path)
    if not args or args[0] not in ("run", "preflight", "compare", "-h", "--help"):
        args.insert(0, "run")
    options = cli.parse_args(args)
    try:
        if options.command == "compare":
            output = options.out or options.after / "compare.html"
            print(compare(options.before, options.after, output))
            return 0
        return run(options)
    except KeyboardInterrupt:
        return 130
    except StartupError as exc:
        cli.exit(2, f"{exc}\n")
    except (ValueError, OSError, yaml.YAMLError, subprocess.CalledProcessError) as exc:
        # Parser/OS exceptions may echo arbitrary YAML, keys-file contents or URLs.
        message = str(exc) if type(exc) is ValueError else type(exc).__name__
        cli.exit(2, f"评测未能运行。{message}\n")
