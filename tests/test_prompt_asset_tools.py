"""提示词资产的 Agent 读路径：索引过滤 / 标签词表 / 全文读取 / 推荐配置校验 / 授权。"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from character_workflow.lib import workshop
from character_workflow.lib.creation_assets import (
    create_prompt_asset,
    list_prompt_asset_index,
    read_prompt_asset,
)
from character_workflow.lib.schemas import CreationAssetRecommendation
from character_workflow.lib.workshop_schema import ListPromptAssetsInput, ReadPromptAssetInput


def _seed():
    hd = create_prompt_asset("通用高清-写实", [
        {"kind": "text", "text": "使图片变清晰，风格："},
        {"kind": "variable", "name": "风格", "default_value": "写实"},
    ], ["高清", "写实"], recommendation=CreationAssetRecommendation(
        model="gpt-image-2", params={"quality": "high", "size": "2048x2048"},
    ))
    vector = create_prompt_asset("高清-矢量", [{"kind": "text", "text": "矢量化"}], ["高清", "矢量"],
                                 project_id="project-a")
    poster = create_prompt_asset("海报构图", [{"kind": "text", "text": "海报"}], ["海报"])
    return hd, vector, poster


def test_index_filters_by_all_tags_and_title_without_bodies(isolated_data_root):
    hd, vector, poster = _seed()
    result = list_prompt_asset_index(tags=["高清"])
    assert {row["asset_id"] for row in result["assets"]} == {hd.asset_id, vector.asset_id}
    assert result["total"] == 2
    assert all("segments" not in row and "prompt" not in row for row in result["assets"])
    assert list_prompt_asset_index(tags=["高清", "矢量"])["assets"][0]["asset_id"] == vector.asset_id
    assert list_prompt_asset_index(tags=["HD"])["assets"] == []
    assert list_prompt_asset_index(query="海报")["assets"][0]["asset_id"] == poster.asset_id
    assert list_prompt_asset_index(limit=1)["total"] == 3
    assert len(list_prompt_asset_index(limit=1)["assets"]) == 1


def test_index_facets_cover_whole_library_and_project_rows_sort_first(isolated_data_root):
    hd, vector, poster = _seed()
    result = list_prompt_asset_index(tags=["海报"], project_id="project-a")
    assert result["tag_facets"] == [
        {"tag": "高清", "count": 2}, {"tag": "写实", "count": 1},
        {"tag": "海报", "count": 1}, {"tag": "矢量", "count": 1},
    ]
    ranked = list_prompt_asset_index(project_id="project-a")["assets"]
    assert ranked[0]["asset_id"] == vector.asset_id
    assert ranked[0]["has_recommendation"] is False
    assert next(row for row in ranked if row["asset_id"] == hd.asset_id)["has_recommendation"] is True


def test_read_returns_prompt_variables_recommendation_and_marks_used(isolated_data_root):
    hd, _, _ = _seed()
    before = list_prompt_asset_index()["assets"]
    assert next(r for r in before if r["asset_id"] == hd.asset_id)["last_used_at"] is None
    detail = read_prompt_asset(hd.asset_id, "project-b")
    assert detail["prompt"] == "使图片变清晰，风格：写实"
    assert detail["variables"] == [{"name": "风格", "default_value": "写实"}]
    assert detail["recommendation"] == {
        "mode": "image", "model": "gpt-image-2", "params": {"quality": "high", "size": "2048x2048"},
    }
    after = next(r for r in list_prompt_asset_index(project_id="project-b")["assets"]
                 if r["asset_id"] == hd.asset_id)
    assert after["last_used_at"] is not None
    assert list_prompt_asset_index(project_id="project-b")["assets"][0]["asset_id"] == hd.asset_id
    with pytest.raises(KeyError):
        read_prompt_asset("creation-asset-missing")


def test_recommendation_rejects_non_whitelisted_params():
    with pytest.raises(ValidationError, match="mask_image"):
        CreationAssetRecommendation(model="gpt-image-2", params={"mask_image": "/etc/passwd"})
    with pytest.raises(ValidationError):
        CreationAssetRecommendation(model="seedance", mode="video", params={"quality": "high"})
    assert CreationAssetRecommendation(model="seedance", mode="video", params={"duration": 5}).params == {
        "duration": 5,
    }


def _agent(capabilities, project_ids=(), canvas_project_ids=()):
    return SimpleNamespace(kind="agent", grant_id="grant-1", session_id="s1",
                           capabilities=frozenset(capabilities), project_ids=frozenset(project_ids),
                           canvas_project_ids=frozenset(canvas_project_ids))


def test_workshop_tools_accept_workshop_or_canvas_read_and_scope_project(isolated_data_root):
    hd, _, _ = _seed()
    listing = workshop.list_prompt_assets(_agent({"canvas_read"}), ListPromptAssetsInput(tags=["高清"]))
    assert listing["total"] == 2
    detail = workshop.read_prompt_asset(
        _agent({"read"}, project_ids={"project-a"}),
        ReadPromptAssetInput(asset_id=hd.asset_id, project_id="project-a"),
    )
    assert detail["title"] == "通用高清-写实"
    with pytest.raises(workshop.WorkshopError) as denied:
        workshop.list_prompt_assets(_agent({"edit_documents"}), ListPromptAssetsInput())
    assert denied.value.code == "CAPABILITY_DENIED"
    with pytest.raises(workshop.WorkshopError) as foreign:
        workshop.list_prompt_assets(_agent({"read"}, project_ids={"project-a"}),
                                    ListPromptAssetsInput(project_id="project-z"))
    assert foreign.value.code == "TARGET_NOT_AUTHORIZED"
    with pytest.raises(workshop.WorkshopError) as missing:
        workshop.read_prompt_asset(_agent({"read"}), ReadPromptAssetInput(asset_id="creation-asset-x"))
    assert missing.value.status == 404
