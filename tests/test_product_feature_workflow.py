from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_agent_entry_routes_important_features_to_the_workflow() -> None:
    agent_guide = _read("CLAUDE.md")

    assert "docs/agents/product-feature-workflow.md" in agent_guide
    assert "Product Contract 未确认前不得进入完整生产实现" in agent_guide
    assert "未经用户明确授权不得合并" in agent_guide


def test_feature_template_covers_contract_risk_and_change_history() -> None:
    template = _read("docs/agents/templates/feature-prd.md")

    for heading in (
        "## Product Contract",
        "### Object",
        "### Create",
        "### Edit",
        "### Use",
        "### Delete",
        "## No-gos",
        "## Complexity Budget",
        "## Riskiest Assumptions",
        "## State Matrix",
        "## Decision Changes",
    ):
        assert heading in template


def test_issue_and_pr_guides_enforce_scope_and_merge_gates() -> None:
    issue_guide = _read("docs/agents/issue-tracker.md")
    pull_request_template = _read(".github/pull_request_template.md")

    assert "从 `origin/main` 建新分支或 worktree" in issue_guide
    assert "规则变化先写入 PRD 的 Decision Changes" in issue_guide
    assert "Diff 只包含本 PRD/问题范围内的实现与测试" in pull_request_template
    assert "### No-gos" in pull_request_template
    assert "N/A：本 PR 没有 UI 改动" in pull_request_template
    assert "只有用户明确授权后才合并" in pull_request_template


def test_verify_target_covers_the_local_delivery_path() -> None:
    makefile = _read("Makefile")
    verify_block = makefile.split("verify:\n", 1)[1].split("\nclean:", 1)[0]

    for command in (
        "uv run ruff check src scripts tests",
        "uv run pytest -v",
        "cd web && pnpm test",
        "cd web && pnpm lint",
        "$(MAKE) build",
        "uv run python scripts/check_plugin.py",
        "bash scripts/check_no_project_root.sh",
        "git diff --quiet -- web/dist",
    ):
        assert command in verify_block
