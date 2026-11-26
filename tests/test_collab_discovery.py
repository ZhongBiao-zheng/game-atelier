import socket
import time
import uuid

import pytest

from character_workflow.lib import collab_discovery as cd


@pytest.mark.parametrize("address", [
    "https://127.0.0.1", "user@10.0.0.1", "127.1", "169.254.169.254", "0.0.0.0",
    "127.0.0.1:1234/path", "example.com", "8.8.8.8", "192.168.1.1:65536",
])
def test_endpoint_only_accepts_literal_lan_destinations(address):
    with pytest.raises(ValueError):
        cd.lan_endpoint(address)


def test_observe_refresh_expire_and_remove(monkeypatch):
    d = cd.Discovery()
    own, other = str(uuid.uuid4()), uuid.uuid4()
    address = "192.168.1.2:5181"
    peer = cd.Peer(address, cd.Manifest(protocol_version=1, host_id=other, display_name="May", shares=[]), 1, 0)
    d.peers[address] = peer
    beacon = cd.Beacon(proto=1, host_id=other, display_name="May", port=5181,
                       share_count=1, revision=1, ts=0)
    clock = [15.]
    monkeypatch.setattr(cd.time, "monotonic", lambda: clock[0])
    assert not d.online()
    d.on_beacon(beacon.model_dump_json().encode(), "192.168.1.2", own)
    assert d.get(peer.key) is peer
    clock[0] += 13
    assert not d.online()
    beacon.share_count = 0
    d.on_beacon(beacon.model_dump_json().encode(), "192.168.1.2", own)
    assert not d.peers


def test_udp_listener_and_manual_poll_use_isolated_socket(monkeypatch):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as temp:
        temp.bind(("127.0.0.1", 0))
        port = temp.getsockname()[1]
    monkeypatch.setenv("GAME_ATELIER_COLLAB_DISCOVERY_PORT", str(port))
    host = uuid.uuid4()
    manifest = cd.Manifest(protocol_version=1, host_id=host, display_name="May", shares=[])
    monkeypatch.setattr(cd, "fetch_manifest", lambda _: manifest)
    beacon = cd.Beacon(proto=1, host_id=host, display_name="May", port=5181,
                       share_count=1, revision=1, ts=0)
    d = cd.Discovery()
    d.start(lambda: None, lambda: [])
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender:
            sender.sendto(beacon.model_dump_json().encode(), ("127.0.0.1", port))
        deadline = time.monotonic() + 3
        while not d.online() and time.monotonic() < deadline:
            time.sleep(.02)
        assert d.online()[0].manifest.host_id == host
    finally:
        d.stop()
