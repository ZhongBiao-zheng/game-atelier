#!/usr/bin/env python3
"""一键把旧工坊内容迁进画布（临时脚本，目标机器迁移确认后删除）。

工坊已随 ADR-0027 删除，迁移脚本只在删除前的代码（92f1bd98）里。本脚本把那一版代码取到临时
工作树，按「预演 → 用户确认 → 停服务 → 备份 → 迁移 → 补迁跳过的角色 → 重跑确认幂等 → 清理 → 启动」
执行。原来的 characters/、projects/ 不删不改。只用标准库，用 `uv run --no-project` 运行。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

import bootstrap

REPO = Path(__file__).resolve().parent.parent
LEGACY_COMMIT = "92f1bd98"
BACKFILL = REPO / "scripts" / "workshop_migration_backfill.py"
PYTHON_INSTALL_MIRROR = "https://registry.npmmirror.com/-/binary/python-build-standalone"


class MigrationStop(Exception):
    pass


def git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def legacy_env(data: Path) -> dict[str, str]:
    env = {**os.environ, "GAME_ATELIER_DATA_ROOT": str(data), "PYTHONUTF8": "1"}
    env.pop("VIRTUAL_ENV", None)
    env.pop("UV_PROJECT_ENVIRONMENT", None)
    env.setdefault("UV_PYTHON_INSTALL_MIRROR", PYTHON_INSTALL_MIRROR)
    return env


def run_legacy(tree: Path, data: Path, script: str, *args: str) -> dict:
    """在旧版工作树里运行脚本，返回它打印的 JSON 报告。"""
    result = subprocess.run(
        ["uv", "run", "--quiet", "--project", str(tree), "python", str(tree / "scripts" / script),
         "--data-root", str(data), *args],
        cwd=tree, env=legacy_env(data), capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise MigrationStop(f"{script} 失败：{(result.stderr or result.stdout).strip()[-800:]}")
    return json.loads(result.stdout)


def save(log_dir: Path, name: str, report: dict) -> None:
    (log_dir / f"{name}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


def show_plan(main: dict, backfill: dict | None) -> None:
    print("\n工坊项目：")
    for project in main["projects"]:
        state = "已迁过，跳过" if project["status"] == "already_migrated" else "迁移"
        print(f"  {project['name']}：{project['nodes']} 个节点，{project['media']} 张图片/视频，"
              f"{project['finalized']} 张定稿（{state}）")
    if backfill:
        for item in backfill["characters"]:
            state = "已补过，跳过" if item["status"] == "already_migrated" else "补迁"
            print(f"  角色 {item['title']} → {item['project']}：{item['media']} 张图片（{state}）")
        for item in backfill["unplaced"]:
            print(f"  角色 {item['character']}：不迁（{item['reason']}），原文件保留在 characters/")


def pending(main: dict, backfill: dict | None) -> bool:
    rows = [*main["projects"], *(backfill["characters"] if backfill else [])]
    return any(row["status"] != "already_migrated" for row in rows)


def stop_server() -> None:
    print("停止 Atelier 服务…", flush=True)
    if bootstrap.run_in_venv(["-m", "viewer_server.server", "stop"]):
        raise MigrationStop("停止服务失败，请关闭 Atelier 后重试")


def migrate(data: Path, tree: Path, log_dir: Path) -> bool:
    """返回是否真的迁移了（只有这时服务被停过，结束后才需要重新启动）。"""
    main = run_legacy(tree, data, "migrate_workshop_to_canvas.py", "--dry-run")
    save(log_dir, "1-dry-run", main)
    skipped = [item["character"] for item in main["skipped_characters"]]
    if not main["projects"] and not skipped:
        print("没有需要迁移的工坊内容。")
        return False
    # 补迁要追加到迁移出的画布里：主迁移还没跑时补迁无法预演，只列出角色，迁移后再补。
    backfill_args = [arg for character in skipped for arg in ("--character", character)]
    backfill = None
    if skipped and not any(p["status"] == "planned" for p in main["projects"]):
        backfill = run_legacy(tree, data, BACKFILL.name, "--dry-run", *backfill_args)
    show_plan(main, backfill)
    if skipped and backfill is None:
        print(f"  另有 {len(skipped)} 个角色归属不明确，迁移后按分配表补到对应画布：{', '.join(skipped)}")
    if not pending(main, backfill) and (backfill is not None or not skipped):
        print("\n全部已迁移过，无需操作。")
        return False

    if input("\n确认迁移？输入 Y 继续，其他键取消：").strip().lower() != "y":
        print("已取消，没有改动任何数据。")
        return False

    stop_server()
    backup = log_dir / "backup" / "creation-assets"
    if (data / "creation-assets").exists():
        shutil.copytree(data / "creation-assets", backup)
        print(f"已备份 creation-assets → {backup}")

    print("正在迁移…", flush=True)
    save(log_dir, "2-run", run_legacy(tree, data, "migrate_workshop_to_canvas.py"))
    if skipped:
        save(log_dir, "3-backfill", run_legacy(tree, data, BACKFILL.name, *backfill_args))

    repeat = run_legacy(tree, data, "migrate_workshop_to_canvas.py")
    save(log_dir, "4-repeat", repeat)
    repeat_backfill = run_legacy(tree, data, BACKFILL.name, *backfill_args) if skipped else None
    if repeat_backfill:
        save(log_dir, "5-repeat-backfill", repeat_backfill)
    if pending(repeat, repeat_backfill):
        raise MigrationStop("重复运行仍有未完成的项目，迁移可能不完整")
    show_plan(repeat, repeat_backfill)
    print("\n迁移完成，重复运行确认没有重复导入。")
    return True


def main() -> int:
    data = bootstrap.resolve_data_root()
    if data is None or not (data / ".runtime" / "projects.json").is_file():
        print("没有找到工坊数据（.runtime/projects.json），无需迁移。")
        return 0
    if shutil.which("uv") is None or git("--version").returncode != 0:
        print("需要 uv 和 git。请先用一键启动器启动一次 Atelier。")
        return 1
    if git("cat-file", "-e", f"{LEGACY_COMMIT}^{{commit}}").returncode != 0:
        git("fetch", "--quiet", "origin")
        if git("cat-file", "-e", f"{LEGACY_COMMIT}^{{commit}}").returncode != 0:
            print(f"本地仓库缺少旧版代码 {LEGACY_COMMIT}，请先用一键启动器更新到最新版。")
            return 1

    log_dir = data / ".runtime" / "workshop-migrations" / f"oneclick-{datetime.now():%Y%m%d-%H%M%S}"
    log_dir.mkdir(parents=True)
    tree = Path(tempfile.mkdtemp(prefix="atelier-workshop-")) / "legacy"
    print(f"数据目录：{data}")
    print("准备旧版迁移代码（首次需要下载依赖，约 1 分钟）…", flush=True)
    added = git("worktree", "add", "--detach", "--force", str(tree), LEGACY_COMMIT)
    if added.returncode != 0:
        print(f"取出旧版代码失败：{added.stderr.strip()}")
        return 1
    try:
        shutil.copy2(BACKFILL, tree / "scripts" / BACKFILL.name)
        migrated = migrate(data, tree, log_dir)
    except MigrationStop as error:
        print(f"\n迁移停止：{error}")
        print(f"报告与备份在：{log_dir}")
        print("回退：停止服务 → 删除报告 2-run.json 里新建的画布目录 → 用 backup/creation-assets 覆盖 "
              "creation-assets → 删除 .runtime/workshop-migrations 下的项目记录。")
        return 1
    finally:
        git("worktree", "remove", "--force", str(tree))
        shutil.rmtree(tree.parent, ignore_errors=True)
    if not migrated:
        return 0
    print(f"报告与备份在：{log_dir}")
    print("\n启动 Atelier…", flush=True)
    return bootstrap.launch()


if __name__ == "__main__":
    sys.exit(main())
