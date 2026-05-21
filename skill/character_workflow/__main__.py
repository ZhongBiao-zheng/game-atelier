"""character-workflow CLI — v4 turn-start：file system stage + 画师意图推断。

用法：
  python -m skill.character_workflow turn-start [--kind portrait|promo|turnaround] [--message "..."]
  python -m skill.character_workflow set-active <id>
  python -m skill.character_workflow append-lesson --kind portrait --line "...经验..."
  python -m skill.character_workflow submit --kind portrait --prompt-file <path> [--character <id>]
"""
from __future__ import annotations

import argparse
import json
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

from skill.character_workflow.lib.active_character import read_active, write_active
from skill.character_workflow.lib.jobs import write_job
from skill.character_workflow.lib.job_runner import run_job, run_latest
from skill.character_workflow.lib.lessons import append_lesson
from skill.character_workflow.lib.schemas import JobKind, JobStatus
from skill.character_workflow.lib.turn_start import turn_start


def _submit(args: argparse.Namespace) -> int:
    """落盘一条 PENDING_CONFIRM job，stdout 输出纯 job_id。

    集中默认值（model / n / size / seed / status / job_id 格式），
    SKILL.md 调用方不应该再次决定这些值。
    """
    char_id = args.character
    if not char_id:
        active = read_active()
        char_id = active.active_id if active else None
        if not char_id:
            print(
                "submit: --character 未指定且 .runtime/active-character.json 不存在或为空",
                file=sys.stderr,
            )
            return 1

    prompt_path = Path(args.prompt_file)
    if not prompt_path.exists():
        print(f"submit: --prompt-file {args.prompt_file} 不存在", file=sys.stderr)
        return 1
    prompt = prompt_path.read_text(encoding="utf-8")

    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    job_id = f"job-{ts}{secrets.token_hex(4)}"

    source_image = (
        str(Path(args.source_image).expanduser().resolve())
        if args.source_image else None
    )
    reference_images = [source_image] if source_image else []

    params: dict = {
        "vendor": "OpenAI (via Lovart)",
        "size": args.size,
        "requested_size": args.size,
        "n": args.n,
        "reference_images": reference_images,
    }

    write_job(
        job_id=job_id,
        character_id=char_id,
        prompt=prompt,
        model=args.model,
        params=params,
        seed=None,
        status=JobStatus.PENDING_CONFIRM,
        kind=JobKind(args.kind),
        source_image=source_image,
    )
    print(job_id)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="character-workflow")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_turn = sub.add_parser("turn-start", help="v4: 探 stage + 推 intent + 拉上下文")
    p_turn.add_argument("--kind", default="portrait", choices=("portrait", "promo", "turnaround"))
    p_turn.add_argument(
        "--message",
        default=None,
        help="画师本轮最近一条消息原文，用于 stage D intent 推断",
    )

    p_set = sub.add_parser("set-active", help="切换活跃角色")
    p_set.add_argument("character_id", nargs="?", default=None)

    p_lesson = sub.add_parser("append-lesson", help="原子追加一条历代经验到 lessons/<kind>.md")
    p_lesson.add_argument("--kind", required=True, choices=("portrait", "promo", "turnaround"))
    p_lesson.add_argument("--line", required=True, help="完整一行 markdown，不带换行")

    p_submit = sub.add_parser(
        "submit",
        help="落盘 PENDING_CONFIRM job —— 默认值集中点，stdout 输出纯 job_id",
    )
    p_submit.add_argument(
        "--kind", required=True, choices=("portrait", "promo", "turnaround"),
    )
    p_submit.add_argument("--prompt-file", required=True, help="中文 8 段式 prompt 文件路径")
    p_submit.add_argument(
        "--character", default=None,
        help="角色 id；缺省读 .runtime/active-character.json",
    )
    p_submit.add_argument("--n", type=int, default=1, help="出图数量，默认 1")
    p_submit.add_argument("--size", default="1024x1536", help="出图尺寸，默认 1024x1536")
    p_submit.add_argument(
        "--model", default="generate_image_gpt_image_2",
        help="模型 id，默认 generate_image_gpt_image_2",
    )
    p_submit.add_argument(
        "--source-image", default=None,
        help="参考源图绝对路径（promo / turnaround 用）",
    )

    p_run_job = sub.add_parser("run-job", help="确认并执行一个 PENDING_CONFIRM job")
    p_run_job.add_argument("job_id")

    p_run_latest = sub.add_parser(
        "run-latest",
        help="执行当前角色最近一个 PENDING_CONFIRM job",
    )
    p_run_latest.add_argument("--kind", choices=("portrait", "promo", "turnaround"))
    p_run_latest.add_argument("--character", default=None)

    args = parser.parse_args(argv)
    if args.cmd == "turn-start":
        print(json.dumps(turn_start(args.kind, args.message), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "set-active":
        result = write_active(args.character_id or None)
        print(json.dumps(
            {"active_id": result.active_id, "updated_at": result.updated_at},
            ensure_ascii=False,
        ))
        return 0
    if args.cmd == "append-lesson":
        path = append_lesson(args.kind, args.line)
        print(json.dumps({"ok": True, "path": str(path)}, ensure_ascii=False))
        return 0
    if args.cmd == "submit":
        return _submit(args)
    if args.cmd == "run-job":
        try:
            job = run_job(args.job_id)
        except Exception as e:
            print(f"run-job: {e}", file=sys.stderr)
            return 1
        print(json.dumps(job.model_dump(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "run-latest":
        try:
            job = run_latest(
                kind=JobKind(args.kind) if args.kind else None,
                character_id=args.character,
            )
        except Exception as e:
            print(f"run-latest: {e}", file=sys.stderr)
            return 1
        print(json.dumps(job.model_dump(), ensure_ascii=False, indent=2))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
