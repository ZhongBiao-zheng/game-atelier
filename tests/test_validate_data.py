"""A4: validate-data —— 坏 job 定位文件+字段 / 资产断链 / 占位词 / canonical / sidecar。"""
from __future__ import annotations

import json


from character_workflow.__main__ import main
from character_workflow.lib import canonical, jobs, keys, projects, ui_jobs
from character_workflow.lib.schemas import AssetSlot
from character_workflow.lib.validate_data import format_report, validate_data


def _seed_key() -> None:
    keys.write_keys_db(keys.KeysDB.model_validate({
        "version": 1,
        "default_alias": "img-main",
        "keys": [{
            "alias": "img-main",
            "provider": "openai",
            "access_key": "ak_test",
            "secret_key": None,
            "capabilities": ["portrait", "promo", "turnaround"],
            "models": [{"name": "GPT Image", "id": "gpt-image-1"}],
            "created_at": "2026-08-10T00:00:00+08:00",
        }],
    }))


def _write_good_job(isolated_data_root, job_id: str = "job-good1") -> None:
    _seed_key()
    jobs.write_job(
        job_id=job_id, character_id="hero", prompt="p", model="gpt-image-1", params={},
    )


def _issues(report, category: str):
    return [i for i in report.issues if i.category == category]


# ---------- 全绿 ----------

def test_empty_data_root_is_clean(isolated_data_root):
    report = validate_data()
    assert report.issues == []
    assert report.checked == {
        "jobs": 0,
        "docs": 0,
        "canonicals": 0,
        "video_references": 0,
        "sidecars": 0,
    }
    assert "0 errors, 0 warnings" in format_report(report)


def test_valid_job_is_clean(isolated_data_root):
    _write_good_job(isolated_data_root)
    report = validate_data()
    assert report.issues == []
    assert report.checked["jobs"] == 1


# ---------- ① job JSON ----------

def test_broken_job_reports_file_and_field(isolated_data_root):
    _write_good_job(isolated_data_root)
    bad = isolated_data_root / ".runtime" / "jobs" / "job-bad.json"
    data = json.loads((isolated_data_root / ".runtime" / "jobs" / "job-good1.json").read_text())
    data["job_id"] = "job-bad"
    data["status"] = "not-a-status"  # 非法枚举
    data["params"]["warnings"] = "字符串而非数组"  # 类型错
    bad.write_text(json.dumps(data), encoding="utf-8")

    report = validate_data()
    job_issues = _issues(report, "job")
    assert all(i.level == "error" for i in job_issues)
    assert any("job-bad.json" in i.file and "status" in i.detail for i in job_issues)
    assert any("params.warnings" in i.detail for i in job_issues)
    # 好 job 不受牵连
    assert not any("job-good1" in i.file for i in report.issues)


def test_unparseable_job_json(isolated_data_root):
    jobs_dir = isolated_data_root / ".runtime" / "jobs"
    jobs_dir.mkdir(parents=True)
    (jobs_dir / "job-trunc.json").write_text('{"job_id": "job-tr', encoding="utf-8")
    report = validate_data()
    assert any("无法解析" in i.detail and "job-trunc" in i.file for i in report.errors)


def test_legacy_seed_field_is_not_an_error(isolated_data_root):
    _write_good_job(isolated_data_root)
    p = isolated_data_root / ".runtime" / "jobs" / "job-good1.json"
    data = json.loads(p.read_text())
    data["seed"] = 42  # 已废弃字段，与 jobs._load_job 同口径剥离
    p.write_text(json.dumps(data), encoding="utf-8")
    assert validate_data().issues == []


# ---------- ② 资产存在性 ----------

def test_done_job_missing_output_is_error(isolated_data_root):
    _write_good_job(isolated_data_root)
    p = isolated_data_root / ".runtime" / "jobs" / "job-good1.json"
    data = json.loads(p.read_text())
    data["status"] = "done"
    data["output_paths"] = [str(isolated_data_root / "characters/hero/portrait/v1.png")]
    p.write_text(json.dumps(data), encoding="utf-8")

    report = validate_data()
    assert any(
        i.level == "error" and "output_paths 引用不存在" in i.detail for i in report.issues
    )


def test_missing_source_image_is_warning(isolated_data_root):
    _write_good_job(isolated_data_root)
    p = isolated_data_root / ".runtime" / "jobs" / "job-good1.json"
    data = json.loads(p.read_text())
    data["source_image"] = str(isolated_data_root / "characters/hero/source/gone.png")
    p.write_text(json.dumps(data), encoding="utf-8")

    report = validate_data()
    assert any(
        i.level == "warning" and "source_image" in i.detail for i in report.issues
    )
    assert report.errors == []


# ---------- ③ 文档零占位 ----------

def test_spec_placeholder_reported_with_line(isolated_data_root):
    spec = isolated_data_root / "characters" / "hero" / "spec.md"
    spec.parent.mkdir(parents=True)
    spec.write_text("## visual_dna\n- 发色: 银白\n- 瞳色: TBD\n", encoding="utf-8")
    report = validate_data()
    hits = _issues(report, "placeholder")
    assert len(hits) == 1 and hits[0].level == "error"
    assert "L3" in hits[0].detail and "TBD" in hits[0].detail


def test_style_and_anchor_docs_scanned(isolated_data_root):
    projects.create_project("魔幻", slug="mohuan")
    pdir = isolated_data_root / "projects" / "mohuan"
    (pdir / "style.md").write_text("## style\n- render: 待定\n", encoding="utf-8")
    (pdir / "design").mkdir(parents=True)
    (pdir / "design" / "gdd.md").write_text("## 核心循环\n- 抽卡: ?\n", encoding="utf-8")
    report = validate_data()
    files = {i.file for i in _issues(report, "placeholder")}
    assert "projects/mohuan/style.md" in files
    assert "projects/mohuan/design/gdd.md" in files
    assert report.checked["docs"] == 2


def test_validate_data_does_not_migrate_legacy_ui_layout(isolated_data_root):
    projects.create_project("魔幻", slug="mohuan")
    root = isolated_data_root / "projects/mohuan"
    import shutil
    shutil.rmtree(root / "ui")
    legacy = root / "screens/home/v1.png"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(b"png")

    validate_data()

    assert legacy.is_file()
    assert not (root / "ui/schemes.json").exists()


def test_normal_question_in_prose_not_flagged(isolated_data_root):
    spec = isolated_data_root / "characters" / "hero" / "spec.md"
    spec.parent.mkdir(parents=True)
    spec.write_text("## notes\n- 他为什么出走?背景待补充章节讲清\n", encoding="utf-8")
    report = validate_data()
    assert _issues(report, "placeholder") == []


# ---------- ④ canonical ----------

def test_character_canonical_broken_link(isolated_data_root):
    d = isolated_data_root / "characters" / "hero" / "portrait"
    d.mkdir(parents=True)
    (d / "v1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, str(d / "v1.png"))
    (d / "v1.png").unlink()  # 定稿后文件被删 → 断链

    report = validate_data()
    assert any(
        i.category == "canonical" and "portrait 定稿引用不存在" in i.detail
        for i in report.errors
    )


def test_screen_canonical_broken_link(isolated_data_root):
    proj = projects.create_project("魔幻", slug="mohuan")
    d = isolated_data_root / "projects" / "mohuan" / "ui" / "v1" / "screens" / "home"
    d.mkdir(parents=True)
    (d / "v1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    ui_jobs.set_screen_canonical(proj.id, "v1", "home", str(d / "v1.png"))
    (d / "v1.png").unlink()

    report = validate_data()
    assert any(
        i.category == "canonical" and "screen home 定稿引用不存在" in i.detail
        for i in report.errors
    )


def test_corrupt_canonical_json_is_error(isolated_data_root):
    cfile = isolated_data_root / "characters" / "hero" / "canonical.json"
    cfile.parent.mkdir(parents=True)
    cfile.write_text("{broken", encoding="utf-8")
    report = validate_data()
    assert any(i.category == "canonical" and "结构非法" in i.detail for i in report.errors)


def test_missing_video_reference_is_error(isolated_data_root):
    project = projects.create_project("视频项目", slug="video-project")
    projects.assign_character("missing", project.id)
    references = (
        isolated_data_root
        / "projects"
        / project.slug
        / "videos"
        / "launch-pv"
        / "references.json"
    )
    references.parent.mkdir(parents=True)
    (references.parent / "brief.md").write_text("# 宣传片\n", encoding="utf-8")
    (references.parent / "prompt.md").write_text("镜头1：亮相。", encoding="utf-8")
    references.write_text(
        '{"paths":["characters/missing/portrait/v1.png"]}',
        encoding="utf-8",
    )

    report = validate_data()

    assert any(
        issue.category == "reference" and "参考素材不存在" in issue.detail
        for issue in report.errors
    )


def test_video_reference_validation_rejects_foreign_and_duplicate_paths(
    isolated_data_root,
):
    project = projects.create_project("视频项目", slug="video-project")
    other = projects.create_project("其他项目", slug="other-project")
    projects.assign_character("hero", project.id)
    projects.assign_character("outsider", other.id)
    for character_id in ("hero", "outsider"):
        image = isolated_data_root / "characters" / character_id / "portrait" / "v1.png"
        image.parent.mkdir(parents=True)
        image.write_bytes(b"png")
    production = isolated_data_root / "projects/video-project/videos/launch-pv"
    production.mkdir(parents=True)
    (production / "brief.md").write_text("# 宣传片\n", encoding="utf-8")
    (production / "prompt.md").write_text("镜头1：亮相。", encoding="utf-8")
    local = "characters/hero/portrait/v1.png"
    (production / "references.json").write_text(json.dumps({"paths": [
        local,
        local,
        "characters/outsider/portrait/v1.png",
        str(isolated_data_root / local),
    ]}), encoding="utf-8")

    details = [issue.detail for issue in _issues(validate_data(), "reference")]

    assert any("重复路径" in detail for detail in details)
    assert sum("不属于当前项目" in detail for detail in details) == 2


# ---------- ⑤ 画廊 sidecar ----------

def test_sidecar_broken_links_are_warnings(isolated_data_root):
    runtime = isolated_data_root / ".runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / "gallery-ratings.json").write_text(
        json.dumps({"ratings": {"characters/hero/portrait/gone.png": 5.0}}), encoding="utf-8",
    )
    (runtime / "gallery-hidden.json").write_text(
        json.dumps({"paths": ["characters/hero/promo/gone.png"]}), encoding="utf-8",
    )
    report = validate_data()
    sidecar = _issues(report, "sidecar")
    assert len(sidecar) == 2 and all(i.level == "warning" for i in sidecar)
    assert report.errors == []


def test_sidecar_existing_link_clean(isolated_data_root):
    img = isolated_data_root / "characters" / "hero" / "portrait" / "v1.png"
    img.parent.mkdir(parents=True)
    img.write_bytes(b"\x89PNG\r\n\x1a\n")
    runtime = isolated_data_root / ".runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / "gallery-favorites.json").write_text(
        json.dumps({"paths": ["characters/hero/portrait/v1.png"]}), encoding="utf-8",
    )
    assert validate_data().issues == []


def test_corrupt_sidecar_is_error(isolated_data_root):
    runtime = isolated_data_root / ".runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / "gallery-ratings.json").write_text("[not-a-dict", encoding="utf-8")
    report = validate_data()
    assert any(i.category == "sidecar" and i.level == "error" for i in report.issues)


# ---------- CLI ----------

def test_cli_exit_codes(isolated_data_root, capsys):
    assert main(["validate-data"]) == 0
    out = capsys.readouterr().out
    assert "0 errors, 0 warnings" in out

    jobs_dir = isolated_data_root / ".runtime" / "jobs"
    jobs_dir.mkdir(parents=True)
    (jobs_dir / "job-bad.json").write_text("{broken", encoding="utf-8")
    assert main(["validate-data"]) == 1
    out = capsys.readouterr().out
    assert "job-bad.json" in out and "1 errors" in out


def test_cli_warning_only_exits_zero(isolated_data_root, capsys):
    runtime = isolated_data_root / ".runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / "gallery-hidden.json").write_text(
        json.dumps({"paths": ["characters/gone.png"]}), encoding="utf-8",
    )
    assert main(["validate-data"]) == 0
    assert "1 warnings" in capsys.readouterr().out


def test_report_summary_counts(isolated_data_root):
    _write_good_job(isolated_data_root)
    spec = isolated_data_root / "characters" / "hero" / "spec.md"
    spec.parent.mkdir(parents=True)
    spec.write_text("## visual_dna\n- 发色: 银白\n", encoding="utf-8")
    text = format_report(validate_data())
    assert "jobs 1" in text and "文档 1" in text
