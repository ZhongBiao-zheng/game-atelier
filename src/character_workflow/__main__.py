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

from character_workflow.lib.active_character import read_active, write_active
from character_workflow.lib.jobs import write_job
from character_workflow.lib.job_runner import run_job, run_latest
from character_workflow.lib.lessons import append_lesson
from character_workflow.lib.schemas import AssetSlot, JobStatus
from character_workflow.lib.turn_start import turn_start


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
        asset_slot=AssetSlot(args.kind),
        source_image=source_image,
    )
    print(job_id)
    return 0


def _create_project(args: argparse.Namespace) -> int:
    from character_workflow.lib.projects import create_project
    try:
        p = create_project(name=args.name, slug=args.slug)
    except ValueError as e:
        print(f"create-project: {e}", file=sys.stderr)
        return 2
    print(json.dumps(p.model_dump(), ensure_ascii=False))
    return 0


def _assign_character(args: argparse.Namespace) -> int:
    from character_workflow.lib.projects import assign_character
    try:
        assign_character(args.character_id, args.project)
    except KeyError as e:
        print(f"assign-character: 项目不存在: {e}", file=sys.stderr)
        return 2
    print(json.dumps(
        {"character_id": args.character_id, "project_id": args.project, "ok": True},
        ensure_ascii=False,
    ))
    return 0


def _rename_character_id(args: argparse.Namespace) -> int:
    from character_workflow.lib.identity import rename_character_id

    try:
        result = rename_character_id(args.old_id, args.new_id)
    except (ValueError, FileNotFoundError, FileExistsError) as e:
        print(f"rename-character-id: {e}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


def _append_memory(args: argparse.Namespace) -> int:
    """append-memory --scope {project|workspace|global}。

    project scope 自动解析 active → assignments → slug。
    未归属 → 返回码 2 + stderr 明确错误。
    """
    from character_workflow.lib.lessons import append_memory
    from character_workflow.lib.active_character import read_active
    from character_workflow.lib.projects import read_projects

    project_slug: str | None = None
    if args.scope == "project":
        active = read_active()
        if not active.active_id:
            print("append-memory: 无 active 角色,无法解析项目;改用 --scope workspace 或先 set-active",
                  file=sys.stderr)
            return 2
        pf = read_projects()
        project_id = pf.assignments.get(active.active_id)
        if not project_id:
            print(
                f"append-memory: 角色 {active.active_id!r} 未归属任何项目;"
                "先走 Stage E(assign-character)或显式 --scope workspace",
                file=sys.stderr,
            )
            return 2
        proj = next((p for p in pf.projects if p.id == project_id), None)
        if not proj:
            print(f"append-memory: project {project_id!r} 不存在(projects.json 损坏)",
                  file=sys.stderr)
            return 2
        project_slug = proj.slug

    try:
        path = append_memory(kind=args.kind, line=args.line, scope=args.scope, project_slug=project_slug)
    except ValueError as e:
        print(f"append-memory: {e}", file=sys.stderr)
        return 2

    print(json.dumps({"ok": True, "path": str(path), "scope": args.scope}, ensure_ascii=False))
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

    p_cp = sub.add_parser("create-project", help="新建项目目录骨架 + 写 projects.json")
    p_cp.add_argument("--name", required=True)
    p_cp.add_argument("--slug", default=None, help="手动指定 slug,缺省自动生成")

    p_ac = sub.add_parser("assign-character", help="把角色归属到项目;省略 --project 等于取消归属")
    p_ac.add_argument("character_id")
    p_ac.add_argument("--project", default=None)

    p_rename = sub.add_parser(
        "rename-character-id",
        help="安全迁移角色目录 ID 并更新 active/projects/jobs 引用",
    )
    p_rename.add_argument("old_id")
    p_rename.add_argument("new_id")

    p_memory = sub.add_parser("append-memory", help="原子追加一条经验到三层 MEMORY.md")
    p_memory.add_argument("--kind", required=True, choices=("portrait", "promo", "turnaround"))
    p_memory.add_argument("--line", required=True, help="完整一行 markdown,不带换行")
    p_memory.add_argument(
        "--scope", default="project", choices=("global", "workspace", "project"),
        help="写入层级,默认 project(需要 active 角色已归属)",
    )

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
    if args.cmd == "create-project":
        return _create_project(args)
    if args.cmd == "assign-character":
        return _assign_character(args)
    if args.cmd == "rename-character-id":
        return _rename_character_id(args)
    if args.cmd == "append-memory":
        return _append_memory(args)
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
                kind=AssetSlot(args.kind) if args.kind else None,
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
