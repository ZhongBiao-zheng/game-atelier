"""UI continuation can reference canonical pages without opening another target's history."""
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from character_workflow.lib import jobs, keys, projects, ui_jobs, workshop as ws
from character_workflow.lib import workshop_generation as generation
from character_workflow.lib.job_runner import run_job
from character_workflow.lib.schemas import JobStatus
from character_workflow.lib.workshop_schema import (
    CreateTargetInput, ListMediaInput, PrepareGenerationInput, TargetInput,
)


@pytest.fixture
def ui_workspace(isolated_data_root):
    project = projects.create_project("UI 延展", "ui-continuation")
    local = SimpleNamespace(kind="local", session_id="human", grant_id=None)
    agent = SimpleNamespace(kind="agent", session_id="agent", grant_id="ui-agent",
                            project_ids=frozenset([project.id]), capabilities=frozenset([
                                "read", "create_targets", "prepare_generation"]))
    keys.add_key(keys.KeySpec(alias="fake", provider="openai", access_key="test-only",
                             modalities=["image"], models=[keys.ModelSpec(
                                 id="gpt-image-1", name="Fake image", modality="image")],
                             created_at="2026-08-31T00:00:00Z"))
    return SimpleNamespace(root=isolated_data_root, project=project, local=local, agent=agent)


def screen(workspace, name, *, project_id=None, scheme_id="v1"):
    return ws.create_target(workspace.local, CreateTargetInput(
        type="ui_screen", project_id=project_id or workspace.project.id,
        ui_scheme_id=scheme_id, name=name, idempotency_key=ws.digest(name),
    ))["target"]


def prepare(workspace, target, name, media_ids=()):
    return generation.prepare_generation(workspace.agent, PrepareGenerationInput(
        target=target, prompt="UI 页面", alias="fake", model="gpt-image-1",
        params={"type": "image"}, media_ids=list(media_ids), idempotency_key=ws.digest(name)))


def approve_and_run(workspace, request):
    approved = generation.approve_generation(workspace.local, request["request_id"],
                                               request["revision"], lambda *_: True)
    return run_job(approved["job_id"], workshop_grant_is_active=lambda *_: True)


def canonical_image(workspace, target):
    directory = ws.resolve_target(workspace.local, TargetInput(target=target).target)
    path = directory / "canonical.png"
    Image.new("RGB", (16, 24), "gold").save(path)
    ui_jobs.set_screen_canonical(target["project_id"], target["ui_scheme_id"],
                                 target["screen_id"], str(path))
    return path


def test_new_ui_page_uses_same_scheme_canonical_and_frozen_reference(ui_workspace, monkeypatch):
    workspace = ui_workspace
    calls = []

    def dispatch(**kwargs):
        calls.append(kwargs)
        path = Path(kwargs["output_dir"]) / "output.png"
        Image.new("RGB", (16, 24), "gold").save(path)
        return [str(path)]

    monkeypatch.setattr("character_workflow.lib.job_runner.dispatch", dispatch)
    baseline = screen(workspace, "主界面")
    baseline_job = approve_and_run(workspace, prepare(workspace, baseline, "baseline"))
    assert baseline_job.status == JobStatus.DONE and len(calls) == 1
    original = Path(baseline_job.output_paths[0])
    ui_jobs.set_screen_canonical(workspace.project.id, "v1", baseline["screen_id"], str(original))
    Image.new("RGB", (8, 8), "red").save(original.parent / "unselected.png")

    continuation = screen(workspace, "背包")
    media = ws.list_media(workspace.agent, ListMediaInput(target=continuation))["media"]
    assert len(media) == 1
    assert media[0]["source_screen_id"] == baseline["screen_id"]
    assert media[0]["is_canonical"] and not media[0]["style_stale"]
    baseline_media = ws.list_media(workspace.agent, ListMediaInput(target=baseline))["media"]
    assert len(baseline_media) == 1  # Canonical + output registration do not duplicate the image.
    assert media[0]["media_id"] != baseline_media[0]["media_id"]
    before = original.read_bytes()
    request = prepare(workspace, continuation, "continue", [media[0]["media_id"]])
    assert len(calls) == 1 and len(jobs.list_jobs()) == 1
    Image.new("RGB", (16, 24), "blue").save(original)
    completed = approve_and_run(workspace, request)
    assert completed.status == JobStatus.DONE and len(calls) == 2
    assert Path(completed.params.reference_images[0]).read_bytes() == before
    assert calls[-1]["params"]["reference_images"] == completed.params.reference_images


@pytest.mark.parametrize("scope", ["project", "scheme"])
def test_canonical_media_does_not_cross_project_or_scheme(ui_workspace, scope):
    workspace = ui_workspace
    own = screen(workspace, "当前页面")
    if scope == "project":
        project = projects.create_project("其他项目", "other-ui")
        other = screen(workspace, "私密页面", project_id=project.id)
    else:
        created = ws.create_target(workspace.local, CreateTargetInput(
            type="ui_scheme", project_id=workspace.project.id, name="其他方案",
            idempotency_key="other-scheme"))["target"]
        other = screen(workspace, "其他方案页面", scheme_id=created["ui_scheme_id"])
    canonical_image(workspace, other)
    foreign_id = ws.list_media(workspace.local, ListMediaInput(target=other))["media"][0]["media_id"]
    assert ws.list_media(workspace.agent, ListMediaInput(target=own))["media"] == []
    with pytest.raises(ws.WorkshopError) as error:
        prepare(workspace, own, "foreign-reference", [foreign_id])
    assert error.value.code == "REFERENCE_NOT_ALLOWED"
    assert error.value.status == 403 and jobs.list_jobs() == []


def test_ui_canonical_reference_reports_changed_style(ui_workspace):
    workspace = ui_workspace
    baseline = screen(workspace, "基准页面")
    style = workspace.root / "projects" / workspace.project.slug / "style.md"
    style.write_text("# 暖色", encoding="utf-8")
    canonical_image(workspace, baseline)
    continuation = screen(workspace, "延展页面")
    style.write_text("# 冷色", encoding="utf-8")
    entry = ws.list_media(workspace.agent, ListMediaInput(target=continuation))["media"][0]
    assert entry["style_stale"] is True


def test_forged_canonical_cannot_register_another_projects_file(ui_workspace):
    workspace = ui_workspace
    own = screen(workspace, "当前页面")
    secret_project = projects.create_project("私密项目", "private-ui")
    secret = screen(workspace, "私密页面", project_id=secret_project.id)
    secret_path = canonical_image(workspace, secret)
    # A modified manifest is not proof that the referenced image belongs to this scheme.
    forged = ui_jobs.read_screen_canonical(secret_project.id, "v1")
    canonical_path = ui_jobs.screens_dir(workspace.project.id, "v1") / "canonical.json"
    canonical_path.write_text(forged.model_dump_json(), encoding="utf-8")
    assert secret_path.is_file()
    assert ws.list_media(workspace.agent, ListMediaInput(target=own))["media"] == []
    fabricated = ws.media_id_for_path(TargetInput(target=own).target, secret_path)
    with pytest.raises(ws.WorkshopError) as error:
        prepare(workspace, own, "forged-reference", [fabricated])
    assert error.value.code == "REFERENCE_NOT_ALLOWED" and error.value.status == 403


def test_ui_canonical_rejects_symbolic_link(ui_workspace, tmp_path):
    workspace = ui_workspace
    baseline = screen(workspace, "基准")
    original = canonical_image(workspace, baseline)
    other = screen(workspace, "新页面")
    outside = tmp_path / "outside.png"
    Image.new("RGB", (16, 24), "red").save(outside)
    original.unlink()
    try:
        original.symlink_to(outside)
    except OSError:
        pytest.skip("Current Windows account cannot create symbolic links")
    with pytest.raises(ws.WorkshopError) as error:
        ws.list_media(workspace.agent, ListMediaInput(target=other))
    assert error.value.code == "REFERENCE_NOT_ALLOWED" and error.value.status == 403
