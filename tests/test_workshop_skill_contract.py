"""Validate executable examples and references without pretending to run an Agent model."""
import json
import re
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from character_workflow.lib.workshop_schema import TOOL_INPUT_MODELS


ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / "docs/references/workshop-mcp-workflow.md"
GENERATION_SKILLS = ("character", "promo", "turnaround", "ui-page", "video")


def test_documented_mcp_payload_examples_validate_against_runtime_schema():
    examples = re.findall(r"### (workshop_[a-z_]+)\n\n```json\n(.*?)\n```",
                          WORKFLOW.read_text("utf-8"), re.S)
    assert len(examples) >= 4
    for name, raw in examples:
        operation = name.removeprefix("workshop_").replace("_", "-")
        arguments = json.loads(raw)
        assert set(arguments) == {"payload"}
        TOOL_INPUT_MODELS[operation].model_validate(arguments["payload"])


def test_all_skill_markdown_links_resolve_within_plugin():
    for path in (ROOT / "skills").rglob("*.md"):
        for link in re.findall(r"\]\(([^)]+)\)", path.read_text("utf-8")):
            if "://" in link or link.startswith("#"):
                continue
            target = (path.parent / link.split("#")[0]).resolve()
            assert target.is_relative_to(ROOT), (path, link)
            assert target.is_file(), (path, link)


def test_skill_metadata_is_portable_and_does_not_auto_allow_shell_writes():
    for path in (ROOT / "skills").glob("*/SKILL.md"):
        _, raw, _body = path.read_text("utf-8").split("---", 2)
        metadata = yaml.safe_load(raw)
        assert metadata["name"] == path.parent.name
        assert isinstance(metadata["description"], str)
        assert len(metadata["description"]) <= 1024
        assert set(metadata) <= {"name", "description", "metadata", "license", "allowed-tools"}
        assert not set(metadata.get("allowed-tools", [])) & {"Bash", "Write", "Edit"}


def test_skill_tool_names_exist_and_no_reference_reintroduces_direct_execution():
    tool_names = {"workshop_" + name.replace("-", "_") for name in TOOL_INPUT_MODELS}
    for path in (ROOT / "skills").rglob("*.md"):
        text = path.read_text("utf-8")
        named = set(re.findall(r"\bworkshop_[a-z_]+\b", text))
        assert named <= tool_names, (path, named - tool_names)
        for bypass in ("run-job", "run-latest", "retry-job", "submit-screen",
                       "submit-video-production", "--reference-image", "--source-image"):
            assert bypass not in text, (path, bypass)


@pytest.mark.parametrize("name", GENERATION_SKILLS)
def test_generation_skill_keeps_prepare_human_approval_poll_and_registered_media(name):
    text = (ROOT / "skills" / name / "SKILL.md").read_text("utf-8")
    for operation in ("workshop_prepare_generation", "workshop_get_generation",
                      "workshop_list_models", "workshop_read_media"):
        assert operation in text
    assert "人工批准" in text
    assert "media_ids" in text
    assert "Job" in text or "请求" in text


def test_project_and_empty_scheme_docs_work_without_fake_generation_targets():
    project = {"type": "project", "project_id": "project-demo"}
    scheme = {"type": "ui_scheme", "project_id": "project-demo", "ui_scheme_id": "v1"}
    for target, kind in ((project, "gdd"), (scheme, "ui_style")):
        TOOL_INPUT_MODELS["read-document"].model_validate({"target": target, "kind": kind})
        with pytest.raises(ValidationError):
            TOOL_INPUT_MODELS["prepare-generation"].model_validate({
                "target": target, "prompt": "not a generation target", "alias": "test",
                "model": "test", "params": {"type": "image", "n": 1},
                "media_ids": [], "idempotency_key": "reject-generation-target",
            })


def test_video_keeps_single_full_prompt_and_page_approval_in_eval_expectations():
    evaluations = json.loads((ROOT / "skills/video/evals/evals.json").read_text("utf-8"))
    assert len(evaluations["evals"]) >= 4
    first = evaluations["evals"][0]
    assert "人工批准" in first["expected_output"]
    assert "一个 Job" in first["expected_output"]
    ids = {assertion["id"] for item in evaluations["evals"] for assertion in item["assertions"]}
    assert {"no_shot_entities", "no_forced_bgm_ban", "no_shell_fallback"} <= ids
