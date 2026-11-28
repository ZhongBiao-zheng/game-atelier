from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

import pytest
from PIL import Image

from character_workflow.lib import project_reference_assets as assets
from character_workflow.lib.schemas import CreationPromptAssetContent, JobParams


def png(index=0):
    buffer = BytesIO()
    Image.new('RGB', (120, 240), (index, 50, 80)).save(buffer, 'PNG')
    return buffer.getvalue()


@pytest.fixture
def prompt():
    return assets.create_prompt_asset('角色', [{'kind': 'text', 'text': '铅笔素描'}], [])


def test_empty_metadata_is_omitted_and_old_content_reads():
    content = {'kind': 'prompt', 'segments': [{'kind': 'text', 'text': '角色'}]}
    assert CreationPromptAssetContent.model_validate(content).model_dump() == content
    assert 'prompt_asset_id' not in JobParams().model_dump()
    assert 'prompt_asset_id' not in JobParams.model_validate({'prompt_asset_id': 'old-preview-target'}).model_dump()


def test_upload_deduplicates_and_keeps_previews_when_prompt_is_edited(prompt, isolated_data_root):
    saved = assets.add_prompt_previews(prompt.asset_id, [(png(), 'image/png')] * 2)
    preview, = saved.content.preview_images
    assert (preview.width, preview.height) == (120, 240)
    assert assets.prompt_preview_bytes(prompt.asset_id, preview.file) == (png(), 'image/png')
    assert not (isolated_data_root / 'project-references/blobs').exists()
    edited = assets.update_prompt_asset(prompt.asset_id, title='新标题', segments=[{'kind': 'text', 'text': '水彩'}], tags=[])
    assert edited.content.preview_images == saved.content.preview_images
    assert assets.add_prompt_previews(prompt.asset_id, [(png(), 'image/png')]).updated_at == edited.updated_at


def test_limit_and_atomic_replacement_at_capacity(prompt, isolated_data_root):
    saved = assets.add_prompt_previews(prompt.asset_id, [(png(i), 'image/png') for i in range(8)])
    before = saved.content.preview_images
    with pytest.raises(ValueError, match='最多 8'):
        assets.add_prompt_previews(prompt.asset_id, [(png(9), 'image/png')])
    saved = assets.add_prompt_previews(prompt.asset_id, [(png(9), 'image/png')], replace_file=before[3].file)
    assert len(saved.content.preview_images) == 8
    assert saved.content.preview_images[3].file != before[3].file
    assert not (assets._preview_dir(prompt.asset_id) / before[3].file).exists()
    files = [p.file for p in saved.content.preview_images]
    reordered = assets.reorder_prompt_previews(prompt.asset_id, files[::-1])
    assert [p.file for p in reordered.content.preview_images] == files[::-1]
    with pytest.raises(ValueError):
        assets.reorder_prompt_previews(prompt.asset_id, files[:-1])
    assets.delete_prompt_preview(prompt.asset_id, files[0])
    with pytest.raises(KeyError):
        assets.prompt_preview_bytes(prompt.asset_id, files[0])
    assets.delete_creation_asset(prompt.asset_id)
    assert not assets._preview_dir(prompt.asset_id).exists()


def test_failed_catalog_write_rolls_back_new_files_but_retains_old(prompt, monkeypatch):
    saved = assets.add_prompt_previews(prompt.asset_id, [(png(), 'image/png')])
    old = saved.content.preview_images[0].file
    def fail(*args):
        raise OSError('disk full')
    monkeypatch.setattr(assets, '_replace_asset', fail)
    with pytest.raises(OSError):
        assets.add_prompt_previews(prompt.asset_id, [(png(2), 'image/png')], replace_file=old)
    assert [p.name for p in assets._preview_dir(prompt.asset_id).iterdir()] == [old]
    assert assets.get_creation_asset(prompt.asset_id).content.preview_images[0].file == old


def test_concurrent_uploads_do_not_exceed_limit(prompt):
    def add(index):
        try:
            assets.add_prompt_previews(prompt.asset_id, [(png(index), 'image/png')])
            return True
        except ValueError:
            return False
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(add, range(12)))
    assert sum(results) == 8
    assert len(assets.get_creation_asset(prompt.asset_id).content.preview_images) == 8
    assert len(list(assets._preview_dir(prompt.asset_id).iterdir())) == 8


@pytest.mark.parametrize('body,mime', [(b'bad', 'image/png'), (png(), 'image/jpeg'), (png(), 'image/svg+xml')])
def test_bad_upload_is_rejected_without_files(prompt, body, mime):
    with pytest.raises(ValueError):
        assets.add_prompt_previews(prompt.asset_id, [(body, mime)])
    assert not assets._preview_dir(prompt.asset_id).exists()


def test_preview_path_cannot_escape_or_follow_symlink(prompt, tmp_path):
    saved = assets.add_prompt_previews(prompt.asset_id, [(png(), 'image/png')])
    file = saved.content.preview_images[0].file
    with pytest.raises(KeyError):
        assets.prompt_preview_bytes(prompt.asset_id, '../other.png')
    path = assets._preview_dir(prompt.asset_id) / file
    path.unlink()
    target = tmp_path / 'outside.png'
    target.write_bytes(png())
    path.symlink_to(target)
    with pytest.raises(KeyError):
        assets.prompt_preview_bytes(prompt.asset_id, file)
