import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def _base_env(data_root: Path) -> dict[str, str]:
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env["CHARACTER_WORKFLOW_DATA_ROOT"] = str(data_root)
    return env


def test_turn_start_cli_runs_without_manual_pythonpath(isolated_data_root):
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "character_workflow",
            "turn-start",
            "--message",
            "/game-atelier:character",
        ],
        cwd=REPO_ROOT,
        env=_base_env(isolated_data_root),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["stage"] in ("A", "B")
    assert payload["recommend_action"] == "ask"


def test_turn_start_cli_stdout_stays_json_when_context_loader_logs(isolated_data_root):
    (isolated_data_root / "worldview.md").write_text("world background\n", encoding="utf-8")

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "character_workflow",
            "turn-start",
            "--message",
            "/game-atelier:character",
        ],
        cwd=REPO_ROOT,
        env=_base_env(isolated_data_root),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.lstrip().startswith("{")
    payload = json.loads(result.stdout)
    assert "project_memory" in payload


def test_turn_start_cli_serializes_key_models(isolated_data_root):
    config = isolated_data_root / ".config"
    config.mkdir(exist_ok=True)
    (config / "keys.json").write_text(
        json.dumps(
            {
                "version": 1,
                "default_alias": "seedream",
                "keys": [
                    {
                        "alias": "seedream",
                        "provider": "seedream",
                        "access_key": "secret-value",
                        "secret_key": None,
                        "capabilities": ["portrait", "promo", "turnaround"],
                        "models": [
                            {
                                "name": "Doubao-Seedream-4.5",
                                "id": "doubao-seedream-4-5-251128",
                            }
                        ],
                        "notes": "",
                        "created_at": "2026-05-28T00:00:00+08:00",
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "character_workflow",
            "turn-start",
            "--message",
            "/game-atelier:character",
        ],
        cwd=REPO_ROOT,
        env=_base_env(isolated_data_root),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["available_keys"][0]["models"] == [
        {"name": "Doubao-Seedream-4.5", "id": "doubao-seedream-4-5-251128"}
    ]
    assert "secret-value" not in result.stdout
