"""Edit sizing and MJ order resumability."""
from types import SimpleNamespace

import pytest

from character_workflow.lib import canvas_image_edits as edits


def test_ratio_only_edit_sizes_reject_unsupported_geometry(monkeypatch):
    from character_workflow.lib import image_size_catalog

    key = SimpleNamespace(provider="openrouter", base_url="https://openrouter.ai/api/v1")
    assert edits.edit_size_params(key, "google/gemini-3-pro-image-preview", 2100, 900)["ratio"] == "21:9"
    with pytest.raises(ValueError, match="不支持这个画框比例"):
        edits.edit_size_params(key, "google/gemini-3-pro-image-preview", 100, 500)
    monkeypatch.setattr(image_size_catalog, "image_size_options", lambda *_: {"ratios": []})
    with pytest.raises(ValueError, match="未声明"):
        edits.edit_size_params(key, "google/gemini-3-pro-image-preview", 100, 100)


def test_edit_sizes_reject_provider_normalization_that_changes_ratio(monkeypatch):
    from character_workflow.lib import image_size

    key = SimpleNamespace(provider="openai")
    monkeypatch.setattr(image_size, "normalize_image_size_params", lambda *_: {"size": "1024x1024"})
    with pytest.raises(ValueError, match="无法匹配"):
        edits.edit_size_params(key, "gpt-image-1", 1536, 1024)


@pytest.mark.parametrize("model,ids,uncertain,expected", [
    ("gpt-image-1", ["id"], False, False),
    ("midjourney", ["id"], False, True),
    ("midjourney", ["id"], True, False),
])
def test_resumability_requires_a_known_confirmed_mj_order(model, ids, uncertain, expected):
    params = SimpleNamespace(mj_submission_ids=ids, mj_submit_uncertain=uncertain)
    assert edits.has_resumable_mj_task(SimpleNamespace(model=model, provider="custom", params=params)) is expected
