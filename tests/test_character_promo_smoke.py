"""Skill #2 character-promo 端到端 smoke。

Mock lovart_caller.submit_and_wait，验证：
1. promo Job 落盘是 PENDING_CONFIRM + kind=PROMO + source_image 保留
2. 确认推进到 PENDING 后调用 lovart_caller，output_dir 指向 characters/<id>/promo/
3. 出图成功落 DONE + output_paths 不污染 portrait/
4. lessons 走 promo.md 分卷（context_loader.load_lessons）
"""
from pathlib import Path

import pytest

from character_workflow.lib import context_loader as cl
from character_workflow.lib.callers import lovart as lc
from character_workflow.lib.jobs import (
    job_output_dir, read_job, update_job_status, write_job,
)
from character_workflow.lib.schemas import JobKind, JobStatus


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
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
        params={"size": "1536x864", "n": 1, "vendor": "OpenAI (via Lovart)"},
        seed=None, kind=JobKind.PROMO, source_image=str(src),
    )
    j = read_job("promo-001")
    assert j.status == JobStatus.PENDING_CONFIRM
    assert j.kind == JobKind.PROMO
    assert j.source_image == str(src)

    # 2. 画师确认 → PENDING
    update_job_status("promo-001", status=JobStatus.PENDING)
    assert read_job("promo-001").status == JobStatus.PENDING

    # 3. mock lovart 返回一张图，确认 output_dir 正确
    out_dir = job_output_dir("holy", JobKind.PROMO)
    expected_path = out_dir / "v1.png"

    captured_output_dir: list[Path] = []

    def fake_submit(*, prompt, model, output_dir, n, reference_images=None, timeout=600.0):
        captured_output_dir.append(Path(output_dir))
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        Path(output_dir, "v1.png").write_bytes(b"\x89PNG generated")
        return lc.LovartResult(output_paths=[str(expected_path)], raw_json={"n": n})

    monkeypatch.setattr(lc, "submit_and_wait", fake_submit)

    j2 = read_job("promo-001")
    result = lc.submit_and_wait(
        prompt=j2.prompt, model=j2.model, output_dir=out_dir,
        n=j2.params.n or 1,
        reference_images=[j2.source_image] if j2.source_image else None,
    )
    assert captured_output_dir[0] == out_dir
    assert captured_output_dir[0].name == "promo"
    assert "portrait" not in str(captured_output_dir[0])

    # 4. 写 DONE
    update_job_status("promo-001", status=JobStatus.DONE, output_paths=result.output_paths)
    final = read_job("promo-001")
    assert final.status == JobStatus.DONE
    assert final.output_paths == [str(expected_path)]
    assert expected_path.exists(), "image must land under characters/holy/promo/"


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
        params={"n": 1}, seed=None, kind=JobKind.PROMO,
    )
    out_dir = job_output_dir("holy", JobKind.PROMO)
    portrait_dir = job_output_dir("holy", JobKind.PORTRAIT)
    assert out_dir != portrait_dir
    assert out_dir.name == "promo"
    assert portrait_dir.name == "portrait"


def test_promo_skill_files_exist():
    """Skill #2 的关键文件都得在位，免得 CC 路由进来发现找不到。"""
    skill_root = Path(__file__).resolve().parent.parent / "skills" / "character-promo"
    assert (skill_root / "SKILL.md").exists()
    assert (skill_root / "references" / "personas" / "promo-expert.md").exists()
    assert (skill_root / "references" / "prompt-promo-zh.md").exists()


def test_promo_skill_md_declares_default_n_one():
    """SKILL.md 必须显式声明 n=1 默认，避免 character_workflow 旧 'n=4' 习惯漏过来。"""
    skill_md = (
        Path(__file__).resolve().parent.parent
        / "skills" / "character-promo" / "SKILL.md"
    ).read_text(encoding="utf-8")
    assert "n=1" in skill_md
