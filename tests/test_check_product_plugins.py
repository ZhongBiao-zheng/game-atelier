"""入库的官方插件包必须与源清单、磁盘文件一致。"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "check_product_plugins.py"


def run(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(SCRIPT), "--repo", str(repo)],
                          capture_output=True, text=True, encoding="utf-8")


@pytest.fixture
def copy(tmp_path) -> Path:
    shutil.copytree(REPO / "plugins" / "sprite-sheet", tmp_path / "plugins" / "sprite-sheet",
                    ignore=shutil.ignore_patterns("__pycache__", "node_modules"))
    return tmp_path


def test_current_repo_passes():
    result = run(REPO)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "product plugin(s) checked" in result.stdout


def test_repo_without_plugins_passes(tmp_path):
    assert run(tmp_path).returncode == 0


def test_stale_package_fails(copy):
    manifest = copy / "plugins/sprite-sheet/manifest.json"
    source = json.loads(manifest.read_text(encoding="utf-8"))
    manifest.write_text(json.dumps({**source, "description": "改过但没重新构建"}, ensure_ascii=False),
                        encoding="utf-8")
    result = run(copy)
    assert result.returncode == 1 and "包与 manifest.json 不一致" in result.stdout


def test_modified_package_file_fails(copy):
    entry = copy / "plugins/sprite-sheet/package/ui/index.html"
    entry.write_text(entry.read_text(encoding="utf-8") + "<!-- tampered -->", encoding="utf-8")
    result = run(copy)
    assert result.returncode == 1 and "与清单里的摘要不一致" in result.stdout


def test_unlisted_package_file_fails(copy):
    (copy / "plugins/sprite-sheet/package/extra.js").write_text("x", encoding="utf-8")
    result = run(copy)
    assert result.returncode == 1 and "清单之外的文件 extra.js" in result.stdout


def test_missing_package_fails(copy):
    shutil.rmtree(copy / "plugins/sprite-sheet/package")
    result = run(copy)
    assert result.returncode == 1 and "重新运行 make build" in result.stdout


def test_undeclared_server_module_and_direct_provider_calls_fail(copy):
    server = copy / "plugins/sprite-sheet/server"
    shutil.rmtree(server, ignore_errors=True)
    server.mkdir()
    (server / "__init__.py").write_text(
        "from character_workflow.lib.callers import dispatch\n", encoding="utf-8")
    result = run(copy)
    assert result.returncode == 1
    assert "不能直接调用厂商或 Job Runner" in result.stdout


def test_declared_route_without_implementation_fails(copy):
    init = copy / "plugins/sprite-sheet/server/__init__.py"
    source = init.read_text(encoding="utf-8")
    assert '@api.route("POST", "/repack")' in source
    init.write_text(source.replace('@api.route("POST", "/repack")', '@api.route("POST", "/renamed")'), encoding="utf-8")
    result = run(copy)
    assert result.returncode == 1
    assert "清单声明了 POST /repack，服务端模块没有实现" in result.stdout
    assert "服务端模块实现了 POST /renamed，清单里没有声明" in result.stdout


def test_server_module_that_fails_to_import_fails(copy):
    (copy / "plugins/sprite-sheet/server/__init__.py").write_text("raise RuntimeError('broken')\n", encoding="utf-8")
    result = run(copy)
    assert result.returncode == 1 and "服务端模块加载失败" in result.stdout
