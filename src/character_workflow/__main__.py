"""game-atelier CLI — v4 turn-start：file system stage + 画师意图推断。

用法：
  python -m skill.character_workflow turn-start [--kind portrait|promo|turnaround] [--message "..."]
  python -m skill.character_workflow set-active <id>
  python -m skill.character_workflow append-lesson --kind portrait --line "...经验..."
  python -m skill.character_workflow import-reference --character <id> --slot portrait --path <image>
  python -m skill.character_workflow import-output --character <id> --slot portrait --path <image>
  python -m skill.character_workflow submit --kind portrait --prompt-file <path> [--character <id>]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from character_workflow.lib import data_root, keys
from character_workflow.lib.active_character import read_active, write_active
from character_workflow.lib.jobs import clone_job_for_retry, new_job_id, write_job
from character_workflow.lib.job_runner import run_job, run_latest
from character_workflow.lib.lessons import append_lesson
from character_workflow.lib.schemas import AssetSlot, Job, JobKind, JobStatus
from character_workflow.lib.turn_start import turn_start


def _force_utf8_stdio() -> None:
    """Windows 控制台默认 GBK；强制 stdout/stderr UTF-8，防大块中文 JSON mojibake / WinError 87。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


def _submit(args: argparse.Namespace) -> int:
    """落盘一条 PENDING_CONFIRM job，stdout 输出纯 job_id。

    集中默认值（model / n / size / status / job_id 格式），
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

    job_id = new_job_id()

    source_image = (
        str(Path(args.source_image).expanduser().resolve())
        if args.source_image else None
    )
    reference_images = [source_image] if source_image else []
    for raw in args.reference_image or []:
        resolved = str(Path(raw).expanduser().resolve())
        if resolved not in reference_images:
            reference_images.append(resolved)
    alias = args.alias or keys.preferred_alias_for_kind(args.kind)
    key = keys.find_by_alias(alias) if alias else None
    if key is None:
        if args.alias:
            print(f"submit: alias={args.alias!r} 不存在，去 Web 确认 Key 列表", file=sys.stderr)
        else:
            print(f"submit: 当前 kind={args.kind} 没有可用默认 Key，去 Web 加一个", file=sys.stderr)
        return 2
    model = args.model
    if model is None:
        if not key.models:
            print(
                f"submit: Key {key.alias!r} 没有配置模型，去 Web 补一个 model id",
                file=sys.stderr,
            )
            return 2
        model = key.models[0].id
    # 注：--model 允许自由传任意 id（models 列表只是建议，端点支持即可），不强校验。

    params: dict = {
        "vendor": f"{key.alias} ({key.provider})",
        "size": args.size,
        "requested_size": args.size,
        "n": args.n,
        "reference_images": reference_images,
    }

    job = write_job(
        job_id=job_id,
        character_id=char_id,
        prompt=prompt,
        model=model,
        params=params,
        status=JobStatus.PENDING_CONFIRM,
        asset_slot=AssetSlot(args.kind),
        source_image=source_image,
        alias=alias,
    )
    print(_confirmation_card(job), file=sys.stderr)
    print(job_id)
    return 0


def _submit_screen(args: argparse.Namespace) -> int:
    """B2: 落盘一条 UI 页面 job（namespace='ui'），stdout 输出纯 job_id。

    输出归项目方案不归角色：run-job 后产物落 ui/<scheme>/screens/<screen-id>/vN.png。
    """
    from character_workflow.lib import ui_jobs

    try:
        from character_workflow.lib.ui_schemes import resolve_scheme

        project, scheme = resolve_scheme(args.project, args.scheme)
        ui_jobs.validate_screen_id(args.screen)
    except (KeyError, ValueError) as e:
        print(f"submit-screen: {e}", file=sys.stderr)
        return 1

    prompt_path = Path(args.prompt_file)
    if not prompt_path.exists():
        print(f"submit-screen: --prompt-file {args.prompt_file} 不存在", file=sys.stderr)
        return 1
    prompt = prompt_path.read_text(encoding="utf-8")

    reference_images: list[str] = []
    for raw in args.reference_image or []:
        resolved = str(Path(raw).expanduser().resolve())
        if resolved not in reference_images:
            reference_images.append(resolved)
    # UI 页面出的是图 —— 沿用图片能力（portrait capability）的默认 Key。
    alias = args.alias or keys.preferred_alias_for_kind("portrait")
    key = keys.find_by_alias(alias) if alias else None
    if key is None:
        if args.alias:
            print(f"submit-screen: alias={args.alias!r} 不存在，去 Web 确认 Key 列表", file=sys.stderr)
        else:
            print("submit-screen: 没有可用的图片默认 Key，去 Web 加一个", file=sys.stderr)
        return 2
    model = args.model
    if model is None:
        if not key.models:
            print(f"submit-screen: Key {key.alias!r} 没有配置模型，去 Web 补一个 model id", file=sys.stderr)
            return 2
        model = key.models[0].id

    params: dict = {
        "vendor": f"{key.alias} ({key.provider})",
        "size": args.size,
        "requested_size": args.size,
        "n": args.n,
        "reference_images": reference_images,
    }
    # B3 风格切换：结构锁定、只换风格时记来源关系，供 Web 并排对比与定稿溯源。
    if args.style_variant:
        params["style_variant"] = args.style_variant
    if args.base_version:
        params["base_version"] = args.base_version

    job = write_job(
        job_id=new_job_id(),
        character_id="",  # namespace="ui" 时无角色归属；runner 按 project_id/screen_id 落盘
        prompt=prompt,
        model=model,
        params=params,
        status=JobStatus.PENDING_CONFIRM,
        alias=alias,
        namespace="ui",
        project_id=project.id,
        ui_scheme_id=scheme.id,
        screen_id=args.screen,
    )
    print(_confirmation_card(job), file=sys.stderr)
    print(job.job_id)
    return 0


def _create_video_production(args: argparse.Namespace) -> int:
    from character_workflow.lib.video_jobs import create_production
    try:
        root = create_production(args.project, args.production, args.title, args.type)
    except (KeyError, ValueError) as e:
        print(f"create-video-production: {e}", file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, "path": str(root)}, ensure_ascii=False))
    return 0


def _video_key(alias: str | None, model: str | None):
    db = keys.read_keys_db()

    def is_video_model(key, item) -> bool:
        return item.modality == "video" or (
            item.modality is None
            and "video" in key.modalities
            and "image" not in key.modalities
        )

    candidates = [key for key in db.keys if any(is_video_model(key, item) for item in key.models)]
    if alias:
        key = next((item for item in db.keys if item.alias == alias), None)
        if key is None:
            raise ValueError(f"alias={alias!r} 不存在")
    else:
        key = next((item for item in candidates if item.alias == db.default_alias), None)
        key = key or (candidates[0] if candidates else None)
    if key is None:
        raise ValueError("没有配置可用的视频 Key / 模型")
    if model:
        requested = next((item for item in key.models if item.id == model), None)
        if requested is None or not is_video_model(key, requested):
            raise ValueError(f"Key {key.alias!r} 下没有视频模型 {model!r}")
        return key, requested.id
    video_model = next((item for item in key.models if is_video_model(key, item)), None)
    if video_model is None:
        raise ValueError(f"Key {key.alias!r} 没有视频模型")
    return key, video_model.id


def _resolved_paths(values: list[str] | None) -> list[str]:
    resolved: list[str] = []
    for raw in values or []:
        path = Path(raw).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"参考素材不存在或不是文件: {raw}")
        resolved.append(str(path))
    return resolved


def _merge_paths(*groups: list[str]) -> list[str]:
    return list(dict.fromkeys(path for group in groups for path in group))


def _submit_video_production(args: argparse.Namespace) -> int:
    from character_workflow.lib import video_jobs
    try:
        project = video_jobs.resolve_project(args.project)
        root = video_jobs.production_dir(project.id, args.production)
        video_jobs.require_production(root, args.production)
        key, model = _video_key(args.alias, args.model)
    except (KeyError, FileNotFoundError, ValueError) as e:
        print(f"submit-video-production: {e}", file=sys.stderr)
        return 1
    prompt_path = Path(args.prompt_file) if args.prompt_file else root / "prompt.md"
    if not prompt_path.is_file():
        print(f"submit-video-production: prompt 文件 {prompt_path} 不存在", file=sys.stderr)
        return 1
    if not 1 <= args.duration <= 60:
        print("submit-video-production: --duration 必须在 1–60 秒之间", file=sys.stderr)
        return 1
    prompt = prompt_path.read_text(encoding="utf-8").strip()
    if not prompt:
        print("submit-video-production: prompt 不能为空", file=sys.stderr)
        return 1
    try:
        saved_references = _resolved_paths([
            str(data_root.resolve_data_root() / path)
            for path in video_jobs.read_references(project.id, args.production)
        ])
        params = {
            "vendor": f"{key.alias} ({key.provider})",
            "duration": args.duration,
            "resolution": args.resolution,
            "ratio": args.ratio,
            "reference_images": _merge_paths(
                saved_references,
                _resolved_paths(args.reference_image),
            ),
            "reference_videos": _resolved_paths(args.reference_video),
            "reference_audios": _resolved_paths(args.reference_audio),
        }
        from character_workflow.lib.video_caps import validate_seedance_request
        validate_seedance_request(model, params, prompt)
    except (FileNotFoundError, ValueError) as e:
        print(f"submit-video-production: {e}", file=sys.stderr)
        return 1
    job = write_job(
        job_id=new_job_id(),
        character_id="",
        prompt=prompt,
        model=model,
        params=params,
        status=JobStatus.PENDING_CONFIRM,
        alias=key.alias,
        namespace="video",
        project_id=project.id,
        production_id=args.production,
        kind=JobKind.VIDEO,
    )
    print(_confirmation_card(job), file=sys.stderr)
    print(job.job_id)
    return 0


def _set_video_selected(args: argparse.Namespace) -> int:
    from character_workflow.lib.video_jobs import resolve_project, set_selected
    if not args.clear and not args.path:
        print("set-video-selected: --path 与 --clear 必须二选一", file=sys.stderr)
        return 1
    try:
        project = resolve_project(args.project)
        selected = set_selected(
            project.id,
            args.production,
            None if args.clear else args.path,
        )
    except (KeyError, FileNotFoundError, ValueError) as e:
        print(f"set-video-selected: {e}", file=sys.stderr)
        return 1
    print(json.dumps({"path": selected}, ensure_ascii=False))
    return 0


def _confirmation_card(job: Job) -> str:
    """出图确认卡 —— CLI 统一生成（打到 stderr），Skill 原样转发给画师，
    杜绝 Agent 手写漏字段。stdout 仍是纯 job_id，不破 $() 捕获契约。"""
    refs = job.params.reference_images or []
    lines = [
        "─── 出图确认卡 ───",
        f"job_id : {job.job_id}",
        f"Key    : {job.alias} ({job.provider})",
        f"model  : {job.model}",
    ]
    if job.kind is JobKind.VIDEO:
        lines.append(
            f"参数   : {job.params.duration}s · {job.params.resolution} · {job.params.ratio}"
        )
    else:
        lines.append(f"size   : {job.params.size}  n: {job.params.n}")
    if job.screen_id:
        label = f"screen : {job.screen_id}（UI 页面 job，产物归项目）"
        if job.params.style_variant:
            base = f" ← {job.params.base_version}" if job.params.base_version else ""
            label += f"\n风格   : {job.params.style_variant}{base}"
        lines.insert(2, label)
    if job.production_id:
        lines.insert(2, f"企划   : {job.production_id}（项目完整视频 job）")
    if job.retry_of:
        lines.append(f"retry_of: {job.retry_of}（原 job 错误记录已保留）")
    lines.append(f"参考图 : {len(refs)} 张")
    lines.extend(f"  {i}. {p}" for i, p in enumerate(refs, 1))
    if job.kind is JobKind.VIDEO:
        video_refs = job.params.reference_videos or []
        audio_refs = job.params.reference_audios or []
        lines.append(f"参考视频: {len(video_refs)} 个")
        lines.extend(f"  {i}. {p}" for i, p in enumerate(video_refs, 1))
        lines.append(f"参考音频: {len(audio_refs)} 个")
        lines.extend(f"  {i}. {p}" for i, p in enumerate(audio_refs, 1))
    lines.append("prompt :")
    lines.append(job.prompt.rstrip("\n"))
    lines.append("─── 画师确认后 run-job ───")
    return "\n".join(lines)


def _retry_job(args: argparse.Namespace) -> int:
    """克隆 failed job 重试：新 job PENDING_CONFIRM + retry_of，原 job 错误记录保留。"""
    try:
        job = clone_job_for_retry(args.job_id)
    except FileNotFoundError:
        print(f"retry-job: job {args.job_id} 不存在", file=sys.stderr)
        return 2
    except ValueError as e:
        print(f"retry-job: {e}", file=sys.stderr)
        return 2
    print(_confirmation_card(job), file=sys.stderr)
    print(job.job_id)
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


def _import_reference(args: argparse.Namespace) -> int:
    from character_workflow.lib.asset_import import import_reference

    try:
        result = import_reference(
            character_id=args.character,
            source_path=args.path,
            slot=AssetSlot(args.slot),
        )
    except (FileNotFoundError, ValueError) as e:
        print(f"import-reference: {e}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


def _import_output(args: argparse.Namespace) -> int:
    from character_workflow.lib.asset_import import import_output

    try:
        prompt = (
            Path(args.prompt_file).read_text(encoding="utf-8")
            if args.prompt_file
            else "外部生成图片导入"
        )
        result = import_output(
            character_id=args.character,
            source_path=args.path,
            slot=AssetSlot(args.slot),
            model=args.model,
            prompt=prompt,
            reference_images=args.reference_image,
        )
    except (FileNotFoundError, OSError, ValueError) as e:
        print(f"import-output: {e}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
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
    """append-memory --scope {project|workspace}。

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


def _pending_distill(args: argparse.Namespace) -> int:
    from character_workflow.lib import distill
    from character_workflow.lib.active_character import read_active

    character_id = args.character
    if not character_id:
        character_id = read_active().active_id
    pending = distill.pending_for_character(character_id) if character_id else []
    print(json.dumps({"pending": pending}, ensure_ascii=False))
    return 0


def _mark_distilled(args: argparse.Namespace) -> int:
    from character_workflow.lib import distill
    distill.mark_distilled(args.path)
    print(json.dumps({"ok": True, "path": args.path}, ensure_ascii=False))
    return 0


def _set_canonical(args: argparse.Namespace) -> int:
    from character_workflow.lib import canonical
    from character_workflow.lib.schemas import AssetSlot

    character_id = args.character or read_active().active_id
    if not character_id:
        print(json.dumps({"error": "no active character"}, ensure_ascii=False))
        return 1
    slot = AssetSlot(args.kind)
    if args.clear:
        file = canonical.clear_canonical(character_id, slot)
    else:
        if not args.path:
            print(json.dumps({"error": "--path required unless --clear"}, ensure_ascii=False))
            return 1
        try:
            file = canonical.set_canonical(character_id, slot, args.path)
        except (FileNotFoundError, ValueError) as e:
            print(json.dumps({"error": str(e)}, ensure_ascii=False))
            return 1
    print(json.dumps(
        {"character_id": character_id, **file.model_dump()}, ensure_ascii=False, indent=2,
    ))
    return 0


def _set_screen_canonical(args: argparse.Namespace) -> int:
    from character_workflow.lib import ui_jobs

    try:
        from character_workflow.lib.ui_schemes import resolve_scheme

        project, scheme = resolve_scheme(args.project, args.scheme)
        ui_jobs.validate_screen_id(args.screen)
        if args.clear:
            file = ui_jobs.clear_screen_canonical(project.id, scheme.id, args.screen)
        else:
            if not args.path:
                print(json.dumps({"error": "--path required unless --clear"}, ensure_ascii=False))
                return 1
            file = ui_jobs.set_screen_canonical(project.id, scheme.id, args.screen, args.path)
    except (KeyError, FileNotFoundError, ValueError) as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 1
    print(json.dumps(
        {"project_id": project.id, "slug": project.slug, "scheme_id": scheme.id, **file.model_dump()},
        ensure_ascii=False, indent=2,
    ))
    return 0


def main(argv: list[str] | None = None) -> int:
    _force_utf8_stdio()
    parser = argparse.ArgumentParser(prog="game-atelier")
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

    p_import = sub.add_parser(
        "import-reference",
        help="把已有参考图备份到 source/ 并登记到 portrait/ 或 turnaround/；不自动定稿",
    )
    p_import.add_argument("--character", required=True, help="目标角色 id")
    p_import.add_argument(
        "--slot", required=True, choices=("portrait", "turnaround"),
        help="按图片实际类型登记：角色立绘或三视图",
    )
    p_import.add_argument("--path", required=True, help="待导入图片路径")

    p_import_output = sub.add_parser(
        "import-output",
        help="把 Lovart 等外部成图登记为可见的 DONE job；不自动定稿",
    )
    p_import_output.add_argument("--character", required=True, help="目标角色 id")
    p_import_output.add_argument(
        "--slot", required=True, choices=("portrait", "promo", "turnaround"),
        help="成图所属资产槽位",
    )
    p_import_output.add_argument("--path", required=True, help="待导入图片路径")
    p_import_output.add_argument("--model", default="external", help="外部生成模型标识")
    p_import_output.add_argument("--prompt-file", default=None, help="本次生成提示词文件")
    p_import_output.add_argument(
        "--reference-image", action="append", default=None,
        help="本次生成使用的参考图；可重复",
    )

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
        "--scope", default="project", choices=("workspace", "project"),
        help="写入层级,默认 project(需要 active 角色已归属);跨项目通用经验用 workspace",
    )

    sub.add_parser("agent-env", help="探测当前 AI 代理运行时(tool/约定文件/家目录),输出 JSON")
    sub.add_parser("doctor", help="环境自诊断:data_root / CWD / venv / 代理,报问题 + 给建议")
    sub.add_parser(
        "validate-data",
        help="数据自检:job JSON 逐条校验 / 资产存在性 / 文档零占位 / canonical / 画廊 sidecar;"
             "有 error 退出码 1",
    )
    sub.add_parser(
        "stale-report",
        help="A3:列出 spec/style.md 变更后过时的定稿(角色 + screen),输出 JSON;"
             "改锚点/style.md 前必跑",
    )

    p_submit = sub.add_parser(
        "submit",
        help="落盘 PENDING_CONFIRM job —— 默认值集中点，"
             "stdout 输出纯 job_id，stderr 输出确认卡；支持多张参考图（--reference-image 可重复）",
    )
    p_submit.add_argument(
        "--kind", required=True, choices=("portrait", "promo", "turnaround"),
    )
    p_submit.add_argument("--prompt-file", required=True, help="中文 prompt 文件路径")
    p_submit.add_argument(
        "--character", default=None,
        help="角色 id；缺省读 .runtime/active-character.json",
    )
    p_submit.add_argument("--n", type=int, default=1, help="出图数量，默认 1")
    p_submit.add_argument("--size", default="1024x1536", help="出图尺寸，默认 1024x1536")
    p_submit.add_argument(
        "--alias", default=None,
        help="指定 Key alias；缺省用当前 kind 的默认 Key（按任务跨 Key 选模型时配合 --model）",
    )
    p_submit.add_argument(
        "--model", default=None,
        help="模型 id；缺省使用所选 Key 的第一个模型",
    )
    p_submit.add_argument(
        "--source-image", default=None,
        help="首张参考图的兼容别名（promo / turnaround 旧用法，同时写 job.source_image）",
    )
    p_submit.add_argument(
        "--reference-image", action="append", default=None,
        help="参考图绝对路径，可重复传多张；与 --source-image 合并去重后"
             "写入 params.reference_images，无需手改 job JSON",
    )

    p_ss = sub.add_parser(
        "submit-screen",
        help="落盘 UI 页面 job（namespace='ui'）——产物归项目的明确 UI 方案；"
             "stdout 输出纯 job_id，stderr 输出确认卡",
    )
    p_ss.add_argument("--project", required=True, help="项目 id 或 slug")
    p_ss.add_argument("--scheme", default=None, help="UI 方案 id；缺省使用项目默认方案")
    p_ss.add_argument("--screen", required=True, help="screen-id（小写字母/数字/连字符）")
    p_ss.add_argument("--prompt-file", required=True, help="中文 prompt 文件路径")
    p_ss.add_argument("--n", type=int, default=1, help="出图数量，默认 1")
    p_ss.add_argument("--size", default="1536x1024", help="出图尺寸，UI 页面默认横幅 1536x1024")
    p_ss.add_argument("--alias", default=None, help="指定 Key alias；缺省用图片默认 Key")
    p_ss.add_argument("--model", default=None, help="模型 id；缺省使用所选 Key 的第一个模型")
    p_ss.add_argument(
        "--reference-image", action="append", default=None,
        help="参考图绝对路径，可重复传多张（如基准页图做风格参照）",
    )
    p_ss.add_argument(
        "--style-variant", default=None,
        help="B3 风格候选标签（如「厚涂写实」）；结构锁定只换风格时传，落 params 供并排对比",
    )
    p_ss.add_argument(
        "--base-version", default=None,
        help="B3 结构所本的基准页文件名（如 v1.png），落 params 记来源关系",
    )

    p_sc = sub.add_parser(
        "set-screen-canonical",
        help="B3: 标记/取消某 screen 的定稿图（画师选定风格后调用；--clear 取消）",
    )
    p_sc.add_argument("--project", required=True, help="项目 id 或 slug")
    p_sc.add_argument("--scheme", default=None, help="UI 方案 id；缺省使用项目默认方案")
    p_sc.add_argument("--screen", required=True, help="screen-id")
    p_sc.add_argument("--path", default=None, help="定稿图路径（绝对或 data-root 相对）")
    p_sc.add_argument("--clear", action="store_true", help="取消该 screen 定稿")

    p_vp = sub.add_parser(
        "create-video-production",
        help="建立项目视频企划（brief.md + prompt.md）",
    )
    p_vp.add_argument("--project", required=True, help="项目 id 或 slug")
    p_vp.add_argument("--production", required=True, help="企划 id（小写字母/数字/连字符）")
    p_vp.add_argument("--title", required=True, help="企划显示名")
    p_vp.add_argument(
        "--type",
        choices=("promo", "character", "gameplay", "cutscene", "social", "custom"),
        default="custom",
        help="视频企划类型",
    )

    p_vs = sub.add_parser(
        "submit-video-production",
        help="提交项目完整视频 job（namespace='video'，产物归企划）",
    )
    p_vs.add_argument("--project", required=True, help="项目 id 或 slug")
    p_vs.add_argument("--production", required=True, help="企划 id")
    p_vs.add_argument("--prompt-file", default=None, help="视频 prompt 文件；缺省读企划 prompt.md")
    p_vs.add_argument("--alias", default=None, help="视频 Key alias；缺省选首个视频 Key")
    p_vs.add_argument("--model", default=None, help="视频模型 id；缺省选 Key 下首个视频模型")
    p_vs.add_argument("--duration", type=int, default=5, help="目标时长（秒）")
    p_vs.add_argument("--resolution", default="720p", help="分辨率档位")
    p_vs.add_argument("--ratio", default="16:9", help="画幅比例")
    p_vs.add_argument("--reference-image", action="append", default=None)
    p_vs.add_argument("--reference-video", action="append", default=None)
    p_vs.add_argument("--reference-audio", action="append", default=None)

    p_vc = sub.add_parser("set-video-selected", help="选定/取消项目完整视频版本")
    p_vc.add_argument("--project", required=True, help="项目 id 或 slug")
    p_vc.add_argument("--production", required=True, help="企划 id")
    p_vc.add_argument("--path", default=None, help="要选定的 mp4 路径")
    p_vc.add_argument("--clear", action="store_true", help="取消选定")

    p_run_job = sub.add_parser("run-job", help="确认并执行一个 PENDING_CONFIRM job")
    p_run_job.add_argument("job_id")

    p_retry = sub.add_parser(
        "retry-job",
        help="克隆一条 failed job 重试：原 job 错误记录保留，新 job 带 retry_of，"
             "stdout 输出新 job_id（确认后 run-job <新id>）",
    )
    p_retry.add_argument("job_id")

    p_run_latest = sub.add_parser(
        "run-latest",
        help="执行当前角色最近一个 PENDING_CONFIRM job",
    )
    p_run_latest.add_argument("--kind", choices=("portrait", "promo", "turnaround"))
    p_run_latest.add_argument("--character", default=None)

    p_pd = sub.add_parser("pending-distill", help="列出活跃(或指定)角色待沉淀的高分图")
    p_pd.add_argument("--character", default=None)

    p_md = sub.add_parser("mark-distilled", help="标记某图已沉淀/忽略,不再提醒")
    p_md.add_argument("path")

    p_canon = sub.add_parser(
        "set-canonical",
        help="标记/取消角色某 slot 的定稿图（画师确认后调用；--clear 取消）",
    )
    p_canon.add_argument("--kind", required=True, choices=("portrait", "promo", "turnaround"))
    p_canon.add_argument("--path", default=None, help="定稿图路径（绝对或 data-root 相对）")
    p_canon.add_argument("--clear", action="store_true", help="取消该 slot 定稿")
    p_canon.add_argument(
        "--character", default=None,
        help="角色 id；缺省读 .runtime/active-character.json",
    )

    args = parser.parse_args(argv)
    if args.cmd == "turn-start":
        print(json.dumps(turn_start(args.kind, args.message), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "set-canonical":
        return _set_canonical(args)
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
    if args.cmd == "import-reference":
        return _import_reference(args)
    if args.cmd == "import-output":
        return _import_output(args)
    if args.cmd == "rename-character-id":
        return _rename_character_id(args)
    if args.cmd == "append-memory":
        return _append_memory(args)
    if args.cmd == "agent-env":
        from character_workflow.lib.agent_env import as_dict
        print(json.dumps(as_dict(), ensure_ascii=False))
        return 0
    if args.cmd == "doctor":
        from character_workflow.lib.doctor import diagnose
        print(json.dumps(diagnose(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "validate-data":
        from character_workflow.lib.validate_data import format_report, validate_data
        report = validate_data()
        print(format_report(report))
        return 1 if report.errors else 0
    if args.cmd == "stale-report":
        from character_workflow.lib.stale import stale_report
        print(json.dumps(stale_report(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "submit":
        return _submit(args)
    if args.cmd == "submit-screen":
        return _submit_screen(args)
    if args.cmd == "set-screen-canonical":
        return _set_screen_canonical(args)
    if args.cmd == "create-video-production":
        return _create_video_production(args)
    if args.cmd == "submit-video-production":
        return _submit_video_production(args)
    if args.cmd == "set-video-selected":
        return _set_video_selected(args)
    if args.cmd == "retry-job":
        return _retry_job(args)
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
    if args.cmd == "pending-distill":
        return _pending_distill(args)
    if args.cmd == "mark-distilled":
        return _mark_distilled(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
