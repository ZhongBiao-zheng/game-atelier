import pytest
from pydantic import ValidationError

from character_workflow.lib.schemas import CanvasTextNode


def _text_node(data: dict[str, object]) -> CanvasTextNode:
    return CanvasTextNode.model_validate(
        {
            "id": "text-one",
            "title": "文本",
            "type": "text",
            "position": {"x": 0, "y": 0},
            "z_index": 0,
            "data": {
                "current_version_id": None,
                "generation_draft": None,
                "active_run_id": None,
                **data,
            },
        }
    )


def test_text_node_uses_atelier_body_scale_by_default():
    assert _text_node({}).data.display.scale == "sm"


def test_text_node_rejects_arbitrary_font_scale():
    with pytest.raises(ValidationError, match="scale"):
        _text_node({"display": {"scale": "display"}})
