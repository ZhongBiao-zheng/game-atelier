"""第 5 批 5-6A：自定义接口接入说明是唯一来源。

设置页「复制接入说明」整份复制 data/http_protocol_manual.md（前端 ?raw 导入同一文件）；
「AI 帮我配置」的提示词只取其中「模板规范」一节。改说明就同时改了两边，不会漂移。
"""
from __future__ import annotations

from importlib.resources import files

from character_workflow.lib import http_protocol_assist as assist

MANUAL = files("character_workflow").joinpath("data/http_protocol_manual.md").read_text(encoding="utf-8")


def test_assist_prompt_carries_exactly_the_spec_section_of_the_manual():
    system, _user = assist.build_messages("image", assist.Sources(blocks=[("文档", "POST /v1/x")]))
    head, rest = MANUAL.split(f"\n{assist.MANUAL_SPEC_HEADING}\n", 1)
    section = rest.split("\n## ", 1)[0].strip()
    assert section and system.endswith(section)
    # 其他节（分流、计费、自测、安全）是给用户 AI 代理看的，不进「AI 帮我配置」的提示词。
    for heading in ("## 先判断要不要写模板", "## 提交、失败与计费", "## 自测", "## 安全"):
        assert heading in MANUAL
        assert heading not in system


def test_spec_section_lists_every_top_level_field_the_validator_accepts():
    for name in assist.TOP_LEVEL:
        assert f"{name}" in assist.SPEC


def test_manual_has_no_host_or_secret_examples():
    assert "http://" not in MANUAL and "https://" not in MANUAL
    assert assist.redact_secrets(MANUAL)[1] == 0
