"""Validate manifests before starting a service or opening a provider key file."""

import re
from pathlib import Path
from typing import Annotated, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


class Fields(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


Count = Annotated[int, Field(ge=0)]
Money = Annotated[float, Field(ge=0)]
Name = Annotated[str, Field(min_length=1)]
FileId = Annotated[str, Field(pattern=r"^[\w-]{1,100}$")]


class Expect(Fields):
    images: Count | None = None
    videos: Count | None = None
    size: Annotated[str, Field(pattern=r"^[1-9]\d*[xX×][1-9]\d*$")] | None = None
    ratio: Annotated[str, Field(pattern=r"^[1-9]\d*:[1-9]\d*$")] | None = None
    orientation: Literal["portrait", "landscape"] | None = None
    duration_s: Annotated[float, Field(gt=0)] | None = None
    model_family: Name | None = None
    uses_all_attachments: bool | None = None
    uses_previous_result: bool | None = None
    asks_user: bool | None = None
    on_canvas: bool | None = None
    skills: list[Name] = Field(default_factory=list)

    @model_validator(mode="after")
    def exclusive_dimensions(self):
        if self.size and self.ratio:
            raise ValueError("size 和 ratio 只能选一个")
        return self


class Limits(Fields):
    max_results: Count = 2
    max_cost_cny: Money = 1.0
    max_steps: Annotated[int, Field(gt=0)] = 30
    max_seconds: Annotated[float, Field(gt=0)] = 600


class Preferred(Fields):
    alias: str | None
    model: Name


class Settings(Fields):
    creation_mode: Literal["all", "image", "video"] = "all"
    permission: Literal["auto", "review"] = "auto"
    confirm_above_cny: Money = 10
    preferred_models: list[Annotated[str, Field(pattern=r"^[^/]+/.+$")] | Preferred] = Field(
        default_factory=list
    )


class Turn(Fields):
    say: Name
    attachments: list[Name] = Field(default_factory=list)
    expect: Expect = Field(default_factory=Expect)


class Node(Fields):
    id: FileId
    type: Literal["image"]
    title: Name
    file: Name


class Canvas(Fields):
    nodes: list[Node]
    selected: list[FileId] = Field(default_factory=list)

    @model_validator(mode="after")
    def selected_nodes_exist(self):
        ids = {n.id for n in self.nodes}
        if len(ids) != len(self.nodes) or not set(self.selected) <= ids:
            raise ValueError("canvas.nodes 的 id 需唯一，canvas.selected 必须来自这些节点")
        return self


class Case(Fields):
    id: FileId
    surface: Literal["canvas", "studio"]
    title: Name
    settings: Settings = Field(default_factory=Settings)
    limits: Limits = Field(default_factory=Limits)
    turns: Annotated[list[Turn], Field(min_length=1)]
    expect: Expect = Field(default_factory=Expect)
    canvas: Canvas | None = None
    human_check: list[Name] = Field(default_factory=list)


def _attachments(raw):
    turns = raw.get("turns")
    if isinstance(turns, list):
        for turn in turns:
            if isinstance(turn, dict) and isinstance(turn.get("attachments"), list):
                yield from (item for item in turn["attachments"] if isinstance(item, str))
    canvas = raw.get("canvas")
    if isinstance(canvas, dict) and isinstance(canvas.get("nodes"), list):
        for node in canvas["nodes"]:
            if isinstance(node, dict) and isinstance(node.get("file"), str):
                yield node["file"]


def inspect_cases(path: Path, only: str | None, fixtures: Path):
    files = sorted([*path.glob("*.yaml"), *path.glob("*.yml")]) if path.is_dir() else [path]
    selected = {entry.strip() for entry in only.split(",")} if only else set()
    seen, cases, issues = set(), [], []
    fixtures = fixtures.resolve()
    for file in files:
        try:
            documents = list(yaml.safe_load_all(file.read_text(encoding="utf-8")))
        except (OSError, UnicodeError, yaml.YAMLError):
            issues.append(f"{file.name} 无法读取为 YAML 清单")
            continue
        for doc in documents:
            for index, raw in enumerate(doc if isinstance(doc, list) else [doc], 1):
                case_id = raw.get("id") if isinstance(raw, dict) else None
                label = f"{file.name}#{index}"
                if isinstance(case_id, str) and re.fullmatch(r"[\w-]{1,100}", case_id):
                    label = case_id
                    if selected and case_id not in selected:
                        continue
                    if case_id in seen:
                        issues.append(f"{case_id} 的 id 重复")
                        continue
                    seen.add(case_id)
                if isinstance(raw, dict):
                    for name in dict.fromkeys(_attachments(raw)):
                        try:
                            candidate = (fixtures / name).resolve()
                            available = candidate.is_relative_to(fixtures) and candidate.is_file()
                        except (OSError, RuntimeError, ValueError):
                            available = False
                        if not available:
                            issues.append(f"{label} 指定的附件不可用：{name}")
                try:
                    case = Case.model_validate(raw)
                except ValidationError as error:
                    fields = ", ".join(
                        ".".join(map(str, detail["loc"])) or "需求" for detail in error.errors()
                    )
                    issues.append(f"{label} 含未知或无效字段：{fields}")
                    continue
                if case.canvas is not None and case.surface != "canvas":
                    issues.append(f"{case.id} 的 canvas 只适用于画布")
                cases.append(
                    case.model_dump(exclude_unset=True, exclude_none=True)
                    | {"limits": case.limits.model_dump()}
                )
    if selected - seen:
        issues.append("--only 包含不存在的 id：" + ", ".join(sorted(selected - seen)))
    if not cases and not issues:
        issues.append("需求清单为空")
    return cases, issues


def load_cases(path: Path, only: str | None, fixtures: Path):
    cases, issues = inspect_cases(path, only, fixtures)
    if issues:
        raise ValueError("\n".join(issues))
    return cases
