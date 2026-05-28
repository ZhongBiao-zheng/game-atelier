#!/usr/bin/env python3
"""Release sanity check — validates .claude-plugin/plugin.json + Skill discovery + size.

Schema confirmed by Task 1 validation:
- manifest 在 .claude-plugin/plugin.json
- skills 字段是 string（目录路径），Skill 通过目录扫描自动发现
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

MAX_SIZE_MB = 10
REQUIRED_TOP_FIELDS = ("name", "version", "description")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--repo", default=".")
    args = p.parse_args()
    repo = Path(args.repo).resolve()

    failures: list[str] = []

    manifest = repo / ".claude-plugin" / "plugin.json"
    if not manifest.exists():
        failures.append(".claude-plugin/plugin.json missing")
        return _report(failures)

    try:
        m = json.loads(manifest.read_text())
    except json.JSONDecodeError as e:
        failures.append(f"plugin.json invalid JSON: {e}")
        return _report(failures)

    for field in REQUIRED_TOP_FIELDS:
        if field not in m:
            failures.append(f"plugin.json missing required field: {field}")

    skills_path_str = m.get("skills")
    if skills_path_str:
        if not isinstance(skills_path_str, str):
            failures.append(f"'skills' must be a string path, got {type(skills_path_str).__name__}")
        else:
            skills_dir = (repo / skills_path_str).resolve()
            if not skills_dir.is_dir():
                failures.append(f"skills dir not found: {skills_path_str}")
            else:
                found = list(skills_dir.glob("*/SKILL.md"))
                if not found:
                    failures.append(f"no SKILL.md found under {skills_path_str}/<name>/")

    bootstrap = repo / "scripts" / "bootstrap.py"
    if not bootstrap.exists():
        failures.append("scripts/bootstrap.py missing")

    if not (repo / "pyproject.toml").exists():
        failures.append("pyproject.toml missing")

    total = sum(
        f.stat().st_size for f in repo.rglob("*")
        if f.is_file() and not _excluded(repo, f)
    )
    size_mb = total / (1024 * 1024)
    if size_mb > MAX_SIZE_MB:
        failures.append(f"Plugin size {size_mb:.1f}MB exceeds {MAX_SIZE_MB}MB cap")

    return _report(failures)


def _excluded(repo: Path, f: Path) -> bool:
    try:
        parts = f.relative_to(repo).parts
    except ValueError:
        return True
    return any(p in (
        ".git", "node_modules", "__pycache__", ".venv",
        "characters", ".runtime", "memory", "projects", ".pytest_cache",
        ".ruff_cache", "dist", "archive", ".DS_Store",
    ) for p in parts)


def _report(failures: list[str]) -> int:
    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("OK: plugin checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
