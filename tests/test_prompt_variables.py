from __future__ import annotations

import json
from urllib.parse import quote, unquote

import pytest

from character_workflow.lib.prompt_variables import (
    build_prompt_variable_template,
    resolve_prompt_variables,
)
from character_workflow.lib.schemas import (
    CreationPromptTextSegment,
    CreationPromptVariableSegment,
)


def variable(name="主体", example="三头犬", value=""):
    return build_prompt_variable_template([
        CreationPromptVariableSegment(kind="variable", name=name, default_value=example),
    ], {name: value})


def test_template_keeps_example_separate_from_empty_value():
    token = variable()
    payload = json.loads(unquote(token[len("@[variable:"):-1]))
    assert payload == {"name": "主体", "example": "三头犬", "value": ""}
    assert resolve_prompt_variables("一只" + token) == "一只三头犬"


def test_same_name_values_resolve_without_trimming_content_or_recursive_parsing():
    value = " 中文\n@[variable:not-a-template] "
    token = variable(value=value)
    assert resolve_prompt_variables(token + "与" + token) == value + "与" + value
    assert resolve_prompt_variables("普通 @[node:image-a] 提示词") == "普通 @[node:image-a] 提示词"


def test_missing_names_are_deduplicated_and_same_name_conflicts_rejected():
    with pytest.raises(ValueError, match="请填写提示词变量：主体、场景$"):
        resolve_prompt_variables(variable(example=" ") + variable("场景", example=" ") + variable(example=" "))
    with pytest.raises(ValueError, match="同名提示词变量内容不一致：主体"):
        resolve_prompt_variables(variable(value="猫") + variable(value="狗"))
    assert resolve_prompt_variables(variable(value=" \n\t")) == "三头犬"
    for whitespace in ("\ufeff", "\u0085", "\u001c", "\u00a0"):
        assert resolve_prompt_variables(variable(value=whitespace)) == "三头犬"
        with pytest.raises(ValueError, match="请填写提示词变量"):
            resolve_prompt_variables(variable(example=whitespace))
    assert resolve_prompt_variables(variable() + variable(value="三头犬")) == "三头犬三头犬"
    with pytest.raises(ValueError, match="同名提示词变量内容不一致"):
        resolve_prompt_variables(variable() + variable(example="猫"))
    with pytest.raises(ValueError, match="请填写提示词变量：主体"):
        resolve_prompt_variables(variable(example=" \t", value=" \n"))


@pytest.mark.parametrize("token", [
    "@[variable:", "@[variable:%]", "@[variable:%FF]", "@[variable:[]]",
    '@[variable:{"name":"主体","example":"狗","value":false}]',
    '@[variable:{"name":"主体","value":"狗"}]',
    '@[variable:{"name":" ","example":"狗","value":"猫"}]',
    "@[variable:" + quote(json.dumps({"name": "x", "example": "x", "value": "x",
                                      "extra": "x"})) + "]",
])
def test_malformed_reserved_tokens_are_never_sent_to_provider(token):
    with pytest.raises(ValueError, match="提示词变量格式无效"):
        resolve_prompt_variables("before " + token + " after")


def test_template_keeps_text_and_explicit_values_and_checks_canvas_length():
    segments = [
        CreationPromptTextSegment(kind="text", text="一只"),
        CreationPromptVariableSegment(kind="variable", name="主体", default_value="三头犬"),
    ]
    assert resolve_prompt_variables(build_prompt_variable_template(segments, {"主体": "猫"})) == "一只猫"
    with pytest.raises(ValueError, match="提示词变量模板过长"):
        build_prompt_variable_template([
            CreationPromptVariableSegment(kind="variable", name="主体", default_value="犬" * 10_000),
        ])
