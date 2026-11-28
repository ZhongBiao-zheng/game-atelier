"""Seed retained catalog records for project and team interoperability tests."""
from character_workflow.lib import project_reference_assets as assets


def seed_prompt(title, segments, tags, project_id=None):
    record = assets._new_asset(kind="prompt", title=title, tags=tags,
                               content=assets._prompt_content(segments), project_id=project_id)
    catalog = assets._read_catalog_unlocked()
    assets._write_catalog_unlocked(catalog, [record, *catalog.assets])
    return record


def seed_previews(asset_id, uploads):
    catalog = assets._read_catalog_unlocked()
    record = assets.get_creation_asset(asset_id)
    directory = assets._preview_dir(asset_id)
    directory.mkdir(parents=True, exist_ok=True)
    previews = list(record.content.preview_images)
    for body, mime in uploads:
        preview = assets._preview_image(body, mime)
        (directory / preview.file).write_bytes(body)
        previews.append(preview)
    updated = record.model_copy(update={"content": record.content.model_copy(update={"preview_images": previews})})
    assets._replace_asset(catalog, updated)
    return updated


def remove_fixture_record(asset_id):
    catalog = assets._read_catalog_unlocked()
    assets._write_catalog_unlocked(catalog, [row for row in catalog.assets if row.asset_id != asset_id])
