"""Personal project folders: lightweight references to existing project assets."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_text
from character_workflow.lib.jobs import job_lock
from character_workflow.lib.projects import read_projects
from character_workflow.lib.schemas import (
    Project,
    ProjectFolder,
    ProjectFolderItem,
    ProjectFoldersFile,
)
from character_workflow.lib.ui_jobs import resolve_project


def _path(project: Project) -> Path:
    return data_root.projects_dir() / project.slug / "folders.json"


def _read(project: Project) -> ProjectFoldersFile:
    path = _path(project)
    if not path.is_file():
        return ProjectFoldersFile()
    return ProjectFoldersFile.model_validate_json(path.read_text(encoding="utf-8"))


def _write(project: Project, folders: ProjectFoldersFile) -> ProjectFoldersFile:
    atomic_write_text(_path(project), folders.model_dump_json(indent=2))
    return folders


def read_project_folders(project_id: str) -> ProjectFoldersFile:
    return _read(resolve_project(project_id))


def create_folder(project_id: str, name: str, note: str = "") -> ProjectFoldersFile:
    project = resolve_project(project_id)
    with job_lock(f"project-folders-{project.id}"):
        folders = _read(project)
        folders.folders.insert(0, ProjectFolder(
            id=f"folder-{uuid4().hex[:10]}",
            name=name.strip(),
            note=note.strip(),
            created_at=datetime.now(timezone.utc).isoformat(),
        ))
        return _write(project, folders)


def update_folder(project_id: str, folder_id: str, name: str, note: str) -> ProjectFoldersFile:
    project = resolve_project(project_id)
    with job_lock(f"project-folders-{project.id}"):
        folders = _read(project)
        folder = _find_folder(folders, folder_id)
        folder.name = name.strip()
        folder.note = note.strip()
        return _write(project, folders)


def reorder_folders(project_id: str, ordered_ids: list[str]) -> ProjectFoldersFile:
    project = resolve_project(project_id)
    with job_lock(f"project-folders-{project.id}"):
        folders = _read(project)
        by_id = {folder.id: folder for folder in folders.folders}
        ordered = [by_id[folder_id] for folder_id in ordered_ids if folder_id in by_id]
        ordered_set = set(ordered_ids)
        folders.folders = ordered + [
            folder for folder in folders.folders if folder.id not in ordered_set
        ]
        return _write(project, folders)


def delete_folder(project_id: str, folder_id: str) -> ProjectFoldersFile:
    project = resolve_project(project_id)
    with job_lock(f"project-folders-{project.id}"):
        folders = _read(project)
        _find_folder(folders, folder_id)
        folders.folders = [folder for folder in folders.folders if folder.id != folder_id]
        return _write(project, folders)


def add_folder_item(
    project_id: str,
    folder_id: str,
    item: ProjectFolderItem,
) -> ProjectFoldersFile:
    project = resolve_project(project_id)
    _validate_asset(project, item)
    with job_lock(f"project-folders-{project.id}"):
        folders = _read(project)
        folder = _find_folder(folders, folder_id)
        if item not in folder.items:
            folder.items.append(item)
            return _write(project, folders)
        return folders


def remove_folder_item(
    project_id: str,
    folder_id: str,
    item: ProjectFolderItem,
) -> ProjectFoldersFile:
    project = resolve_project(project_id)
    with job_lock(f"project-folders-{project.id}"):
        folders = _read(project)
        folder = _find_folder(folders, folder_id)
        folder.items = [existing for existing in folder.items if existing != item]
        return _write(project, folders)


def replace_character_reference(old_id: str, new_id: str) -> None:
    for project in read_projects().projects:
        with job_lock(f"project-folders-{project.id}"):
            folders = _read(project)
            changed = False
            for folder in folders.folders:
                for item in folder.items:
                    if item.kind == "character" and item.asset_id == old_id:
                        item.asset_id = new_id
                        changed = True
            if changed:
                _write(project, folders)


def remove_character_references(character_id: str) -> None:
    for project in read_projects().projects:
        with job_lock(f"project-folders-{project.id}"):
            folders = _read(project)
            changed = False
            for folder in folders.folders:
                kept = [
                    item for item in folder.items
                    if not (item.kind == "character" and item.asset_id == character_id)
                ]
                if len(kept) != len(folder.items):
                    folder.items = kept
                    changed = True
            if changed:
                _write(project, folders)


def _find_folder(folders: ProjectFoldersFile, folder_id: str) -> ProjectFolder:
    folder = next((candidate for candidate in folders.folders if candidate.id == folder_id), None)
    if folder is None:
        raise KeyError(folder_id)
    return folder


def _validate_asset(project: Project, item: ProjectFolderItem) -> None:
    if item.kind == "character":
        assignments = read_projects().assignments
        exists = (
            assignments.get(item.asset_id) == project.id
            and (data_root.characters_dir() / item.asset_id).is_dir()
        )
    elif item.kind == "ui_screen":
        screens_root = data_root.projects_dir() / project.slug / "screens"
        directory_ids = {
            path.name for path in screens_root.iterdir() if path.is_dir()
        } if screens_root.is_dir() else set()
        from character_workflow.lib.workspace_summary import project_workspace_summary
        planned_ids = {
            screen.screen_id for screen in project_workspace_summary(project.id).ui.screen_items
        }
        exists = item.asset_id in directory_ids | planned_ids
    else:
        from character_workflow.lib.video_jobs import list_productions
        exists = any(
            production.production_id == item.asset_id
            for production in list_productions(project.id)
        )
    if not exists:
        raise ValueError(f"资产 {item.asset_id} 不存在或不属于这个项目")
