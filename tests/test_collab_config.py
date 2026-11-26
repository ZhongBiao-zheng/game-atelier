from concurrent.futures import ThreadPoolExecutor

from character_workflow.lib import collab_config as config


def test_shares_persist_and_revoke_old_credentials(isolated_data_root):
    project = "canvas-aaaaaaaa"
    original = config.read_config().host_id
    added = config.enable_share(project, config.ShareSettings(passcode="fixture-passphrase"))
    assert config.verify_passcode(added, "fixture-passphrase")
    assert not config.verify_passcode(added, "wrong")
    saved = (isolated_data_root / ".config/collab-shares.json").read_text()
    assert "fixture-passphrase" not in saved
    edited = config.enable_share(project, config.ShareSettings(mode="view"))
    assert edited.passcode_hash == added.passcode_hash
    assert edited.passcode_version == added.passcode_version
    edited = config.enable_share(project, config.ShareSettings(passcode=""))
    assert edited.passcode_hash is None
    assert edited.passcode_version > added.passcode_version
    config.disable_share(project)
    renewed = config.enable_share(project, config.ShareSettings())
    assert renewed.passcode_version > edited.passcode_version
    assert config.read_config().host_id == original


def test_concurrent_share_updates_preserve_other_projects():
    projects = [f"canvas-{n:08d}" for n in range(8)]
    with ThreadPoolExecutor(4) as pool:
        entries = list(pool.map(lambda p: config.enable_share(p, config.ShareSettings()), projects))
    assert set(config.read_config().shares) == {row.project_id for row in entries}
