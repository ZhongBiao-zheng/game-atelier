"""Skill #3 turnaround 端到端 smoke。

Mock job_runner.dispatch，验证：
1. turnaround Job 落盘是 PENDING_CONFIRM + kind=TURNAROUND + source_image 保留
2. 确认推进到 PENDING 后经 dispatch 出图，output_dir 指向 characters/<id>/turnaround/
3. 出图成功落 DONE + output_paths 不污染 portrait/ / promo/
4. lessons 走 turnaround.md 分卷（context_loader.load_lessons）
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
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    chars = tmp_path / "characters" / "holy"
    (chars / "portrait").mkdir(parents=True)
    (chars / "promo").mkdir()
    (chars / "turnaround").mkdir()
    (chars / "source").mkdir()
    (chars / "spec.md").write_text("# 圣灵祭祀\n金白配色 七头身", encoding="utf-8")
    # 上传源图模拟
    src = chars / "source" / "ref-sheet.png"
    src.write_bytes(b"\x89PNG fake")
    # 历代经验文件
    fake_skill_root = tmp_path / "_fake_skill"
    (fake_skill_root / "references" / "lessons").mkdir(parents=True)
    (fake_skill_root / "references" / "lessons" / "turnaround.md").write_text(
        "# header\n- 2026-05-19 prior · 三面比例对齐 · prompt：`三面身高严格一致`\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(cl, "_skill_root", lambda: fake_skill_root)
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_turnaround_full_flow_writes_job_and_image(project, monkeypatch):
    src = project / "characters" / "holy" / "source" / "ref-sheet.png"

    # 1. 落盘 PENDING_CONFIRM
    write_job(
        job_id="turn-001", character_id="holy",
        prompt="圣灵祭祀三视图 正/侧/背 横幅", model="generate_image_gpt_image_2",
        params={"size": "1536x1024", "n": 1, "vendor": "OpenAI"},
        asset_slot=AssetSlot.TURNAROUND, source_image=str(src),
        alias="oai",
    )
    j = read_job("turn-001")
    assert j.status == JobStatus.PENDING_CONFIRM
    assert j.asset_slot == AssetSlot.TURNAROUND
    assert j.source_image == str(src)

    # 2. mock dispatch 出图到临时目录，run_job 负责挪进 turnaround/
    captured_output_dir: list[Path] = []

    def fake_dispatch(*, prompt, model, alias, output_dir, n, size, params, **kw):
        captured_output_dir.append(Path(output_dir))
        _write_png(Path(output_dir) / "gen.png", width=6, height=4)
        return [str(Path(output_dir) / "gen.png")]

    monkeypatch.setattr(job_runner, "dispatch", fake_dispatch)

    # 3. 出图
    final = job_runner.run_job("turn-001")

    out_dir = job_output_dir("holy", AssetSlot.TURNAROUND)
    expected_path = out_dir / "v1.png"
    assert captured_output_dir[0] != out_dir
    assert final.status == JobStatus.DONE
    assert final.output_paths == [str(expected_path)]
    assert expected_path.exists(), "image must land under characters/holy/turnaround/"
    assert expected_path.parent.name == "turnaround"


def test_turnaround_context_load_uses_turnaround_lessons_volume(project):
    """character_turnaround Skill 不能用 portrait/promo 的经验 —— 必须读 turnaround.md 分卷。"""
    ctx = cl.load_character_context("holy", "turnaround")
    assert "圣灵祭祀" in ctx["spec"]
    assert "三面比例对齐" in ctx["lessons"]
    assert ctx["character_id"] == "holy"


def test_turnaround_job_does_not_pollute_other_dirs(project):
    """TURNAROUND job 写盘必须落到 turnaround/，绝不污染 portrait/ 或 promo/。"""
    write_job(
        job_id="turn-002", character_id="holy",
        prompt="p", model="generate_image_gpt_image_2",
        params={"n": 1}, asset_slot=AssetSlot.TURNAROUND,
    )
    out_dir = job_output_dir("holy", AssetSlot.TURNAROUND)
    portrait_dir = job_output_dir("holy", AssetSlot.PORTRAIT)
    promo_dir = job_output_dir("holy", AssetSlot.PROMO)
    assert out_dir.name == "turnaround"
    assert portrait_dir.name == "portrait"
    assert promo_dir.name == "promo"
    assert out_dir != portrait_dir
    assert out_dir != promo_dir


def test_turnaround_skill_files_exist():
    """Skill #3 的关键文件都得在位，免得 CC 路由进来发现找不到。"""
    skill_root = Path(__file__).resolve().parent.parent / "skills" / "turnaround"
    assert (skill_root / "SKILL.md").exists()
    assert (skill_root / "references" / "personas" / "turnaround-expert.md").exists()
    assert (skill_root / "references" / "prompt-turnaround-zh.md").exists()


def test_turnaround_skill_md_declares_default_n_one_and_landscape_size():
    """SKILL.md 必须显式声明默认单张出图 + 1536x1024 横幅，是 turnaround 的关键工程约束。"""
    skill_md = (
        Path(__file__).resolve().parent.parent
        / "skills" / "turnaround" / "SKILL.md"
    ).read_text(encoding="utf-8")
    assert "默认单张出图" in skill_md
    assert "1536" in skill_md and "1024" in skill_md


def test_turnaround_prompt_template_prefers_source_image_simplified_mode():
    """有立绘参考图时，三视图模板应走曹操 v2 式短 prompt，而不是展开全量 spec。"""
    prompt_doc = (
        Path(__file__).resolve().parent.parent
        / "skills" / "turnaround" / "references" / "prompt-turnaround-zh.md"
    ).read_text(encoding="utf-8")

    assert "曹操 v2" in prompt_doc
    assert "参考图中的[角色简述]，[风格]" in prompt_doc
    assert "双臂微微向下倾斜约 15 度的 T-pose" in prompt_doc
    assert "禁止在第1段展开 spec 全量锚点" in prompt_doc
    assert "排除：" not in prompt_doc
