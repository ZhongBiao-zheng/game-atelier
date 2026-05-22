"""Skill #3 character-turnaround 端到端 smoke。

Mock lovart_caller.submit_and_wait，验证：
1. turnaround Job 落盘是 PENDING_CONFIRM + kind=TURNAROUND + source_image 保留
2. 确认推进到 PENDING 后调用 lovart_caller，output_dir 指向 characters/<id>/turnaround/
3. 出图成功落 DONE + output_paths 不污染 portrait/ / promo/
4. lessons 走 turnaround.md 分卷（context_loader.load_lessons）
"""
from pathlib import Path

import pytest

from character_workflow.lib import context_loader as cl
from character_workflow.lib import lovart_caller as lc
from character_workflow.lib.jobs import (
    job_output_dir, read_job, update_job_status, write_job,
)
from character_workflow.lib.schemas import JobKind, JobStatus


@pytest.fixture
def project(tmp_path, monkeypatch):
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
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
        params={"size": "1536x1024", "n": 1, "vendor": "OpenAI (via Lovart)"},
        seed=None, kind=JobKind.TURNAROUND, source_image=str(src),
    )
    j = read_job("turn-001")
    assert j.status == JobStatus.PENDING_CONFIRM
    assert j.kind == JobKind.TURNAROUND
    assert j.source_image == str(src)

    # 2. 画师确认 → PENDING
    update_job_status("turn-001", status=JobStatus.PENDING)
    assert read_job("turn-001").status == JobStatus.PENDING

    # 3. mock lovart 返回一张横幅图，确认 output_dir 正确
    out_dir = job_output_dir("holy", JobKind.TURNAROUND)
    expected_path = out_dir / "v1.png"

    captured_output_dir: list[Path] = []

    def fake_submit(*, prompt, model, output_dir, n, reference_images=None, timeout=600.0):
        captured_output_dir.append(Path(output_dir))
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        Path(output_dir, "v1.png").write_bytes(b"\x89PNG generated")
        return lc.LovartResult(output_paths=[str(expected_path)], raw_json={"n": n})

    monkeypatch.setattr(lc, "submit_and_wait", fake_submit)

    j2 = read_job("turn-001")
    result = lc.submit_and_wait(
        prompt=j2.prompt, model=j2.model, output_dir=out_dir,
        n=j2.params.n or 1,
        reference_images=[j2.source_image] if j2.source_image else None,
    )
    assert captured_output_dir[0] == out_dir
    assert captured_output_dir[0].name == "turnaround"
    assert "portrait" not in str(captured_output_dir[0])
    assert "promo" not in str(captured_output_dir[0])

    # 4. 写 DONE
    update_job_status("turn-001", status=JobStatus.DONE, output_paths=result.output_paths)
    final = read_job("turn-001")
    assert final.status == JobStatus.DONE
    assert final.output_paths == [str(expected_path)]
    assert expected_path.exists(), "image must land under characters/holy/turnaround/"


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
        params={"n": 1}, seed=None, kind=JobKind.TURNAROUND,
    )
    out_dir = job_output_dir("holy", JobKind.TURNAROUND)
    portrait_dir = job_output_dir("holy", JobKind.PORTRAIT)
    promo_dir = job_output_dir("holy", JobKind.PROMO)
    assert out_dir.name == "turnaround"
    assert portrait_dir.name == "portrait"
    assert promo_dir.name == "promo"
    assert out_dir != portrait_dir
    assert out_dir != promo_dir


def test_turnaround_skill_files_exist():
    """Skill #3 的关键文件都得在位，免得 CC 路由进来发现找不到。"""
    skill_root = Path(__file__).resolve().parent.parent / "skills" / "character-turnaround"
    assert (skill_root / "SKILL.md").exists()
    assert (skill_root / "references" / "personas" / "turnaround-expert.md").exists()
    assert (skill_root / "references" / "prompt-turnaround-zh.md").exists()


def test_turnaround_skill_md_declares_default_n_one_and_landscape_size():
    """SKILL.md 必须显式声明 n=1 默认 + 1536x1024 横幅，是 turnaround 的关键工程约束。"""
    skill_md = (
        Path(__file__).resolve().parent.parent
        / "skills" / "character-turnaround" / "SKILL.md"
    ).read_text(encoding="utf-8")
    assert "n=1" in skill_md
    assert "1536" in skill_md and "1024" in skill_md
