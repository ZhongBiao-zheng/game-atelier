"""Skill #2 promo 端到端 smoke。

Mock job_runner.dispatch，验证：
1. promo Job 落盘是 PENDING_CONFIRM + kind=PROMO + source_image 保留
2. 确认推进到 PENDING 后经 dispatch 出图，output_dir 指向 characters/<id>/promo/
3. 出图成功落 DONE + output_paths 不污染 portrait/
4. lessons 走 promo.md 分卷（context_loader.load_lessons）
"""
import struct
import zlib
from pathlib import Path

import pytest

from character_workflow.lib import context_loader as cl
from character_workflow.lib import job_runner
from character_workflow.lib.jobs import (
    job_output_dir, read_job, write_job,
)
from character_workflow.lib.schemas import AssetSlot, JobStatus


def _write_png(path: Path, width: int = 2, height: int = 2) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + b"\xff\xff\xff" * width for _ in range(height))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    chars = tmp_path / "characters" / "holy"
    (chars / "portrait").mkdir(parents=True)
    (chars / "promo").mkdir()
    (chars / "source").mkdir()
    (chars / "spec.md").write_text("# 圣灵祭祀\n金白配色", encoding="utf-8")
    # 上传源图模拟
    src = chars / "source" / "ref-001.png"
    src.write_bytes(b"\x89PNG fake")
    # 历代经验文件
    fake_skill_root = tmp_path / "_fake_skill"
    (fake_skill_root / "references" / "lessons").mkdir(parents=True)
    (fake_skill_root / "references" / "lessons" / "promo.md").write_text(
        "# header\n- 2026-05-19 prior · 暖逆光剪影 · prompt：`侧逆光`\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(cl, "_skill_root", lambda: fake_skill_root)
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_promo_full_flow_writes_job_and_image(project, monkeypatch):
    src = project / "characters" / "holy" / "source" / "ref-001.png"

    # 1. 落盘 PENDING_CONFIRM
    write_job(
        job_id="promo-001", character_id="holy",
        prompt="圣灵祭祀末战前夕 KV", model="generate_image_gpt_image_2",
        params={"size": "1536x864", "n": 1, "vendor": "OpenAI"},
        asset_slot=AssetSlot.PROMO, source_image=str(src),
        alias="oai",
    )
    j = read_job("promo-001")
    assert j.status == JobStatus.PENDING_CONFIRM
    assert j.asset_slot == AssetSlot.PROMO
    assert j.source_image == str(src)

    # 2. mock dispatch 出图到临时目录，run_job 负责挪进 promo/
    captured_output_dir: list[Path] = []

    def fake_dispatch(*, prompt, model, alias, output_dir, n, size, params, **kw):
        captured_output_dir.append(Path(output_dir))
        _write_png(Path(output_dir) / "gen.png", width=4, height=3)
        return [str(Path(output_dir) / "gen.png")]

    monkeypatch.setattr(job_runner, "dispatch", fake_dispatch)

    # 3. 出图（run_job 内部把 PENDING_CONFIRM 推到 PENDING 再调 dispatch）
    final = job_runner.run_job("promo-001")

    out_dir = job_output_dir("holy", AssetSlot.PROMO)
    expected_path = out_dir / "v1.png"
    # dispatch 拿到的是临时目录，不是最终 promo/
    assert captured_output_dir[0] != out_dir
    assert final.status == JobStatus.DONE
    assert final.output_paths == [str(expected_path)]
    assert expected_path.exists(), "image must land under characters/holy/promo/"
    assert "portrait" not in str(expected_path.parent.name)


def test_promo_context_load_uses_promo_lessons_volume(project):
    """character_promo Skill 不能用 portrait 的经验 —— 必须读 promo.md 分卷。"""
    ctx = cl.load_character_context("holy", "promo")
    assert "圣灵祭祀" in ctx["spec"]
    assert "暖逆光剪影" in ctx["lessons"]
    assert ctx["character_id"] == "holy"


def test_promo_job_does_not_pollute_portrait_dir(project, monkeypatch):
    """PROMO job 写盘必须落到 promo/，绝不污染 portrait/。"""
    write_job(
        job_id="promo-002", character_id="holy",
        prompt="p", model="generate_image_gpt_image_2",
        params={"n": 1}, asset_slot=AssetSlot.PROMO,
    )
    out_dir = job_output_dir("holy", AssetSlot.PROMO)
    portrait_dir = job_output_dir("holy", AssetSlot.PORTRAIT)
    assert out_dir != portrait_dir
    assert out_dir.name == "promo"
    assert portrait_dir.name == "portrait"


def test_promo_skill_files_exist():
    """Skill #2 的关键文件都得在位，免得 CC 路由进来发现找不到。"""
    skill_root = Path(__file__).resolve().parent.parent / "skills" / "promo"
    assert (skill_root / "SKILL.md").exists()
    assert (skill_root / "references" / "personas" / "promo-expert.md").exists()
    assert (skill_root / "references" / "prompt-promo-zh.md").exists()


def test_promo_skill_md_declares_default_n_one():
    """SKILL.md 必须显式声明默认单张出图，避免 character_workflow 旧 'n=4' 习惯漏过来。"""
    skill_md = (
        Path(__file__).resolve().parent.parent
        / "skills" / "promo" / "SKILL.md"
    ).read_text(encoding="utf-8")
    assert "默认单张出图" in skill_md
