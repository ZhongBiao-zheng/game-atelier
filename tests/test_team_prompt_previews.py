"""提示词效果图通过团队文件夹自包含地分享、采用和重新采用。"""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import shutil

import pytest
from PIL import Image

from character_workflow.lib import creation_assets as assets
from character_workflow.lib import team_library_index as idx
from character_workflow.lib.canvas_projects import create_canvas_project
from character_workflow.lib.schemas import TeamLibraryIndex
from character_workflow.lib.team_library import mount_library
from character_workflow.lib.team_library_adopt import (
    TeamAssetAdoptError, adopt_team_asset, adoption_staleness, readopt_team_asset,
)
from character_workflow.lib.team_library_share import share_creation_asset, TeamShareError
from tests.local_client import LocalTestClient
from tests.team_library_helpers import scan_and_cache
from viewer_server.server_app import build_app


def png(color):
    stream = BytesIO()
    Image.new('RGB', (120, 60), color).save(stream, 'PNG')
    return stream.getvalue()


@pytest.fixture
def shared(tmp_path):
    folder = tmp_path / 'shared-library'
    folder.mkdir()
    project = create_canvas_project('分享者')
    mount = mount_library(project_id=project.project_id, path=str(folder), name='参考', created_by='林晓')
    asset = assets.create_prompt_asset('山谷', [{'kind': 'text', 'text': '夕照'}], ['场景'])
    asset = assets.add_prompt_previews(asset.asset_id, [(png('red'), 'image/png'), (png('blue'), 'image/png')], source_job_id='job-source', source_model='gpt-image-2')
    team = share_creation_asset(mount, asset_id=asset.asset_id, title=asset.title, tags=asset.tags, author='林晓')
    entry = scan_and_cache(mount).entries[0]
    return mount, asset, team, entry


def adopt(mount, entry):
    return adopt_team_asset(mount=mount, entry=entry, project_id=mount.project_id)[0]


def test_round_trip_between_two_data_roots_is_self_contained(shared, tmp_path, monkeypatch):
    mount, original, team, entry = shared
    assert [p.file for p in team.prompt.preview_images] == [p.file for p in original.content.preview_images]
    assert entry.preview_images == team.prompt.preview_images
    folder = idx.shared_asset_dir(mount, entry)
    for preview in team.prompt.preview_images:
        assert (folder / 'previews' / preview.file).is_file()
    recipient = tmp_path / 'recipient'
    recipient.mkdir()
    monkeypatch.setenv('GAME_ATELIER_DATA_ROOT', str(recipient))
    project = create_canvas_project('采用者')
    mount = mount_library(project_id=project.project_id, path=mount.mount_path, name=None, created_by='小李')
    copied = adopt(mount, scan_and_cache(mount).entries[0])
    assert copied.content.preview_images == original.content.preview_images
    assert copied.adopted_from.source_preview_fingerprint
    shutil.rmtree(folder)
    assert assets.prompt_preview_bytes(copied.asset_id, copied.content.preview_images[0].file) == (png('red'), 'image/png')
    assert not (recipient / 'creation-assets' / 'blobs').exists()


def test_legacy_manifest_and_index_without_previews_still_read_and_adopt(shared):
    mount, _, _, entry = shared
    manifest = idx.shared_asset_dir(mount, entry) / 'asset.json'
    data = json.loads(manifest.read_text())
    data['prompt'].pop('preview_images', None)
    manifest.write_text(json.dumps(data))
    index = scan_and_cache(mount)
    raw = index.model_dump(mode='json')
    raw['entries'][0].pop('preview_images', None)
    legacy = TeamLibraryIndex.model_validate(raw)
    assert legacy.entries[0].preview_images == []
    assert 'preview_images' not in legacy.entries[0].model_dump()
    assert adopt(mount, legacy.entries[0]).content.preview_images == []


def test_source_preview_order_changes_are_stale_even_with_same_timestamp(shared):
    mount, _, _, entry = shared
    copied = adopt(mount, entry)
    assets.add_prompt_previews(copied.asset_id, [(png('green'), 'image/png')])
    assert adoption_staleness(assets.get_creation_asset(copied.asset_id)) == 'fresh'
    manifest = idx.shared_asset_dir(mount, entry) / 'asset.json'
    data = json.loads(manifest.read_text())
    data['prompt']['preview_images'].reverse()
    manifest.write_text(json.dumps(data))
    scan_and_cache(mount)
    assert adoption_staleness(copied) == 'stale'
    refreshed = readopt_team_asset(copied.asset_id)
    assert refreshed.asset_id == copied.asset_id
    assert [p.file for p in refreshed.content.preview_images] == [p['file'] for p in data['prompt']['preview_images']]
    assert len(list(assets._preview_dir(copied.asset_id).iterdir())) == 2
    assert adoption_staleness(refreshed) == 'fresh'


def test_partial_sync_and_escaping_symlink_are_not_adoptable(shared, tmp_path):
    mount, _, team, entry = shared
    path = idx.shared_asset_dir(mount, entry) / 'previews' / team.prompt.preview_images[0].file
    body = path.read_bytes()
    path.unlink()
    assert scan_and_cache(mount).entries[0].status == 'incomplete'
    outside = tmp_path / 'outside.png'
    outside.write_bytes(body)
    path.symlink_to(outside)
    assert scan_and_cache(mount).entries[0].status == 'incomplete'
    with pytest.raises(TeamAssetAdoptError):
        adopt(mount, entry)  # 即使请求用旧 ready 索引，读取边界仍拒绝。


def test_corrupted_preview_is_rejected_without_partial_local_asset(shared):
    mount, _, team, entry = shared
    path = idx.shared_asset_dir(mount, entry) / 'previews' / team.prompt.preview_images[1].file
    path.write_bytes(png('green'))
    with pytest.raises(TeamAssetAdoptError):
        adopt(mount, entry)
    assert len(assets.list_creation_assets().assets) == 1
    assert len(list((assets._preview_dir('unused').parent).iterdir())) == 1


def test_adopt_and_readopt_catalog_failure_leave_files_unchanged(shared, monkeypatch):
    mount, _, _, entry = shared
    copied = adopt(mount, entry)
    current = assets.get_creation_asset(copied.asset_id)
    directory = assets._preview_dir(copied.asset_id)
    before = {p.name: p.read_bytes() for p in directory.iterdir()}
    # 来源多一张新图；失败必须回滚新文件，旧图片和 catalog 均原样保留。
    source = assets.create_prompt_asset('新效果图', [{'kind': 'text', 'text': '测试'}], [])
    source = assets.add_prompt_previews(source.asset_id, [(png('green'), 'image/png')])
    preview = source.content.preview_images[0]
    folder = idx.shared_asset_dir(mount, entry)
    (folder / 'previews' / preview.file).write_bytes(png('green'))
    manifest = folder / 'asset.json'
    data = json.loads(manifest.read_text())
    data['prompt']['preview_images'].append(preview.model_dump())
    manifest.write_text(json.dumps(data))
    scan_and_cache(mount)
    def fail(*args, **kwargs):
        raise OSError('catalog unavailable')
    with monkeypatch.context() as patch:
        patch.setattr(assets, '_write_catalog_unlocked', fail)
        with pytest.raises(OSError):
            readopt_team_asset(copied.asset_id)
    assert assets.get_creation_asset(copied.asset_id) == current
    assert {p.name: p.read_bytes() for p in directory.iterdir()} == before


def test_concurrent_adoption_creates_one_preview_directory(shared):
    mount, original, _, entry = shared
    with ThreadPoolExecutor(max_workers=4) as pool:
        copies = list(pool.map(lambda _: adopt(mount, entry), range(8)))
    assert len({a.asset_id for a in copies}) == 1
    assert len(list(assets._preview_dir(original.asset_id).parent.iterdir())) == 2


def test_missing_local_preview_does_not_publish_partial_share(shared):
    mount, original, _, _ = shared
    assets._preview_path(original.asset_id, original.content.preview_images[0].file).unlink()
    with pytest.raises(TeamShareError):
        share_creation_asset(mount, asset_id=original.asset_id, title='再次分享', tags=[], author='林晓')
    assert len(idx.build_index(mount).entries) == 1


def test_prompt_preview_thumbnail_route_and_cover_order(shared, isolated_data_root):
    mount, _, team, entry = shared
    base = f'/api/team-libraries/{mount.library_id}/assets/{entry.id}'
    with LocalTestClient(base_url='http://127.0.0.1', app=build_app(dist_dir=isolated_data_root / 'dist')) as client:
        file = team.prompt.preview_images[0].file
        response = client.get(f'{base}/previews/{file}/thumb?w=128')
        assert response.status_code == 200
        assert response.headers['content-type'] == 'image/webp'
        assert response.headers['cache-control'] == 'private, max-age=300'
        assert max(Image.open(BytesIO(response.content)).size) <= 128
        assert client.get(f'{base}/previews/{"f" * 16}.png/thumb').status_code == 404
        assert client.get(f'{base}/previews/{file}/thumb?w=4096').status_code == 422
        assert client.get(f'{base}/content').status_code == 404


def test_initial_adoption_catalog_failure_rolls_back_preview_files(shared, monkeypatch):
    mount, original, _, entry = shared
    def fail(*args, **kwargs):
        raise OSError('catalog unavailable')
    with monkeypatch.context() as patch:
        patch.setattr(assets, '_write_catalog_unlocked', fail)
        with pytest.raises(OSError):
            adopt(mount, entry)
    assert len(assets.list_creation_assets().assets) == 1
    assert [p.name for p in assets._preview_dir(original.asset_id).parent.iterdir()] == [original.asset_id]


def test_removed_previews_mark_stale_and_readopt_clears_local_files(shared):
    mount, _, _, entry = shared
    copied = adopt(mount, entry)
    manifest = idx.shared_asset_dir(mount, entry) / 'asset.json'
    data = json.loads(manifest.read_text())
    data['prompt'].pop('preview_images')
    manifest.write_text(json.dumps(data))
    before = idx.read_index(mount.library_id)
    after = scan_and_cache(mount)
    assert idx.diff_index(before, after)[0]['change'] == 'updated'
    assert adoption_staleness(copied) == 'stale'
    refreshed = readopt_team_asset(copied.asset_id)
    assert refreshed.content.preview_images == []
    assert list(assets._preview_dir(copied.asset_id).iterdir()) == []
    assert adoption_staleness(refreshed) == 'fresh'
