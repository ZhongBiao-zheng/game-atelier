from __future__ import annotations

import hashlib

import pytest

from character_workflow.lib import canvas_runs
from character_workflow.lib.canvas_projects import (
    canvas_output_dir,
    create_canvas_project,
    read_canvas_document,
    save_canvas_document,
)
from character_workflow.lib.canvas_runs import (
    CanvasRunCommandError,
    finalize_canvas_run,
    revised_text,
    submit_text_revision_run,
    text_revision_prompt,
)
from character_workflow.lib.jobs import read_job, save_job
from character_workflow.lib.keys import KeySpec, ModelSpec
from character_workflow.lib.schemas import CanvasTextRevision, JobKind, JobParams, JobStatus


NOW = "2026-11-27T00:00:00+00:00"
BASE = "一、调性\n城市夜行\n\n二、主视觉\n琥珀色液体\n冰镇瓶身\n"


def _version(version_id: str, text: str) -> dict:
    return {
        "version_id": version_id,
        "created_at": NOW,
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "origin": {"kind": "user_edit"},
        "kind": "text",
        "text": text,
    }


def _project(text: str = BASE, *, active_run_id: str | None = None):
    project = create_canvas_project("改写")
    current = read_canvas_document(project.project_id)
    payload = current.model_dump(mode="json")
    payload.update({
        "nodes": [{
            "id": "copy",
            "title": "文案",
            "type": "text",
            "position": {"x": 0, "y": 0},
            "z_index": 0,
            "data": {
                "current_version_id": "version-base",
                "generation_draft": None,
                "active_run_id": active_run_id,
            },
        }],
        "content_versions": {"version-base": _version("version-base", text)},
    })
    document = type(current).model_validate(payload)
    return project, save_canvas_document(project.project_id, document, current.revision)


@pytest.fixture
def text_model(monkeypatch):
    key = KeySpec(alias="llm", provider="openai", access_key="secret", models=[], created_at=NOW)
    model = ModelSpec(name="GPT", id="gpt-5-mini", modality="text", protocol="chat")
    monkeypatch.setattr(
        canvas_runs, "_resolve_key_and_model", lambda _draft, **_kwargs: (key, model, JobKind.TEXT),
    )
    monkeypatch.setattr(
        canvas_runs, "_normalized_params", lambda _draft, _count, _key, _model: ({"n": 1}, JobParams(n=1), 1),
    )


def _finish(project_id: str, job_id: str, output: str):
    target = canvas_output_dir(project_id, job_id) / "result.txt"
    target.write_text(output, encoding="utf-8")
    job = read_job(job_id)
    save_job(job.model_copy(update={"status": JobStatus.DONE, "output_paths": [str(target)]}))
    return finalize_canvas_run(project_id, job_id)


def _text(document) -> str:
    node = next(node for node in document.nodes if node.id == "copy")
    return document.content_versions[node.data.current_version_id].text


def test_whole_text_revision_writes_back_to_the_same_node(text_model):
    project, document = _project()

    job, submitted = submit_text_revision_run(
        project.project_id, "copy", document.revision,
        instruction="更有夏天感", selection=None, alias="llm", model="gpt-5-mini",
    )

    assert job.canvas_run.result_node_id == "copy"
    assert [node.id for node in submitted.nodes] == ["copy"]
    assert job.canvas_run.snapshot.text_revision.base_version_id == "version-base"
    assert job.canvas_run.snapshot.draft_prompt == "更有夏天感"
    assert BASE in job.prompt and "更有夏天感" in job.prompt

    finalized, updated = _finish(project.project_id, job.job_id, "夏日版全文\n")

    assert finalized.status == JobStatus.DONE
    assert _text(updated) == "夏日版全文"
    assert "version-base" in updated.content_versions


def test_selection_revision_only_replaces_the_selected_span(text_model):
    project, document = _project()
    start = BASE.index("琥珀色液体")
    end = BASE.index("冰镇瓶身") + len("冰镇瓶身\n")

    job, _ = submit_text_revision_run(
        project.project_id, "copy", document.revision,
        instruction="每条不超过 4 字", selection=(start, end), alias="llm", model="gpt-5-mini",
    )
    assert "【待修改片段开始】琥珀色液体\n冰镇瓶身\n【待修改片段结束】" in job.prompt

    _, updated = _finish(project.project_id, job.job_id, "\n琥珀光\n冰瓶\n\n")

    assert _text(updated) == "一、调性\n城市夜行\n\n二、主视觉\n琥珀光\n冰瓶\n"


def test_revision_does_not_overwrite_text_edited_while_running(text_model):
    project, document = _project()
    job, submitted = submit_text_revision_run(
        project.project_id, "copy", document.revision,
        instruction="改短", selection=None, alias="llm", model="gpt-5-mini",
    )
    payload = submitted.model_dump(mode="json")
    payload["content_versions"]["version-edit"] = _version("version-edit", "手改过")
    payload["nodes"][0]["data"]["current_version_id"] = "version-edit"
    save_canvas_document(project.project_id, type(submitted).model_validate(payload), submitted.revision)

    finalized, updated = _finish(project.project_id, job.job_id, "模型改写")

    assert finalized.status == JobStatus.FAILED
    assert finalized.canvas_run.candidates[0].error == "改写期间正文被改动，结果没有写回"
    assert _text(updated) == "手改过"


@pytest.mark.parametrize(("selection", "active_run_id", "code"), [
    ((0, len(BASE) + 1), None, "canvas_text_revision_selection"),
    (None, "run-busy", "canvas_text_revision_busy"),
])
def test_revision_rejects_bad_selection_and_busy_node(text_model, selection, active_run_id, code):
    project, document = _project(active_run_id=active_run_id)
    with pytest.raises(CanvasRunCommandError) as error:
        submit_text_revision_run(
            project.project_id, "copy", document.revision,
            instruction="改短", selection=selection, alias="llm", model="gpt-5-mini",
        )
    assert error.value.code == code


def test_selection_offsets_count_code_points():
    text = "前缀😀甲乙丙后缀"
    revision = CanvasTextRevision(
        base_version_id="v", instruction="改", selection_start=3, selection_end=6,
    )
    assert "【待修改片段开始】甲乙丙【待修改片段结束】" in text_revision_prompt(text, revision)
    assert revised_text(text, revision, "丁") == "前缀😀丁后缀"
