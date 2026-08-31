"""Real preparation/approval fixture for caller and original Workshop smoke tests."""
from types import SimpleNamespace
from uuid import uuid4

from character_workflow.lib import data_root, jobs, keys, projects, workshop
from character_workflow.lib.workshop_generation import approve_generation, prepare_generation
from character_workflow.lib.workshop_schema import PrepareGenerationInput, TargetInput


def approved_character_job(*, character_id="holy", prompt="test", model="gpt-image-1",
                           params=None, asset_slot="portrait", source_image=None, alias="oai"):
    project_file = projects.read_projects()
    project_id = project_file.assignments.get(character_id)
    if project_id is None:
        project = project_file.projects[0] if project_file.projects else projects.create_project("测试")
        projects.assign_character(character_id, project.id)
        project_id = project.id
    spec = data_root.characters_dir() / character_id / "spec.md"
    spec.parent.mkdir(parents=True, exist_ok=True)
    if not spec.exists():
        spec.write_text("# 测试角色", encoding="utf-8")
    current = keys.find_by_alias(alias)
    if current is None:
        keys.add_key(keys.KeySpec(alias=alias, provider="openai", access_key="test-only",
                                 modalities=["image"], models=[keys.ModelSpec(
                                     id=model, name=model, modality="image")], created_at="test"))
    elif all(item.id != model for item in current.models):
        keys.patch_key(alias, {"models": [*current.models, keys.ModelSpec(id=model, name=model)]})
    local = SimpleNamespace(kind="local", session_id="test-human", grant_id=None)
    target = TargetInput(target={"type": "character", "project_id": project_id,
                                 "character_id": character_id, "asset_slot": str(asset_slot)}).target
    references = [entry["media_id"] for entry, path in workshop.media_entries(local, target)
                  if source_image and str(path) == str(source_image)]
    prepared = prepare_generation(local, PrepareGenerationInput(
        target=target, prompt=prompt, model=model, alias=alias, params={"type": "image", **(params or {})},
        media_ids=references, idempotency_key=uuid4().hex))
    approved = approve_generation(local, prepared["request_id"], 1, lambda *_: True)
    return jobs.read_job(approved["job_id"])
