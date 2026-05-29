"""Prompt assembly for the character Skill suite.

把"专家人设 + 项目世界观 + 历代经验 + 当前角色 spec + 任务模板"这五段
按固定顺序拼成一段 markdown，喂给 Claude（不是喂给图像模型）。

Claude 读了这段 markdown 之后才动笔写最终中文出图 prompt。
所以 prompt_builder 不做风格 / 模型相关的渲染逻辑 —— 它只是 section 装配器。

模板里的 `{placeholder}` 走 Python `str.format()` 渲染；缺字段抛 KeyError 并带字段名。
"""
from __future__ import annotations

from character_workflow.lib.context_loader import CharacterContext


def render(template: str, context: dict, persona: str | None = None) -> str:
    """渲染一段 prompt body。template 中 `{key}` 用 context[key] 替换。

    - 缺字段：抛 KeyError("missing field: <name>")
    - 多余字段：忽略（不警告）
    - persona 非空：作为前缀加一段 markdown header
    """
    try:
        body = template.format(**context)
    except KeyError as e:
        missing = e.args[0] if e.args else "?"
        raise KeyError(f"missing field: {missing}") from None
    if persona:
        return f"# 专家人设\n\n{persona.strip()}\n\n# 任务\n\n{body.strip()}\n"
    return body


def assemble_character_prompt(
    ctx: CharacterContext,
    persona: str,
    task: str,
) -> str:
    """组装一段完整的"专家+背景+经验+spec+任务"五段 prompt。

    persona / task 由 Skill 各自提供；ctx 由 context_loader 拉。
    输出是给 Claude 读的 markdown 块，不是图像模型 prompt。
    """
    sections: list[str] = []
    if persona.strip():
        sections.append(f"# 专家人设\n\n{persona.strip()}")
    if ctx["worldview"].strip():
        sections.append(f"# 项目世界观\n\n{ctx['worldview'].strip()}")
    if ctx["lessons"].strip():
        sections.append(f"# 历代经验\n\n{ctx['lessons'].strip()}")
    if ctx["spec"].strip():
        sections.append(f"# 当前角色 spec ({ctx['character_id']})\n\n{ctx['spec'].strip()}")
    if task.strip():
        sections.append(f"# 任务\n\n{task.strip()}")
    return "\n\n".join(sections) + "\n"
