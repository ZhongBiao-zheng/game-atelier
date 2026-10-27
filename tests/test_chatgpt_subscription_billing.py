from pathlib import Path

import pytest
from PIL import Image

from character_workflow.lib import job_runner, keys, model_routes
from character_workflow.lib.generation_pricing import estimate_cost_cny, estimate_submission
from character_workflow.lib.image_size import normalize_image_size_params, supports_auto_image_size
from character_workflow.lib.image_size_catalog import image_size_options
from character_workflow.lib.jobs import read_job, save_job
from character_workflow.lib.schemas import Job, JobParams, JobStatus


def subscription():
    return keys.KeySpec(
        alias="subscription", provider="chatgpt", access_key="", auth_source="codex-cli",
        created_at="2026-10-27T00:00:00Z",
        models=[keys.ModelSpec(id="gpt-image-2", name="GPT Image", modality="image")],
    )


def pending_job(**params):
    return save_job(Job(
        job_id="subscription-test", character_id="studio", prompt="a red circle",
        submitted_at="2026-10-27T00:00:00Z", model="gpt-image-2", params=JobParams(**params),
        output_paths=[], status=JobStatus.PENDING, error=None,
        alias="subscription", provider="chatgpt",
    ))


def test_subscription_price_is_zero_only_for_its_image_model():
    assert estimate_cost_cny(kind="image", provider="chatgpt", model_id="gpt-image-2") == 0
    assert estimate_cost_cny(kind="video", provider="chatgpt", model_id="gpt-image-2") is None
    assert estimate_cost_cny(kind="image", provider="chatgpt", model_id="gpt-image-2.5") is None
    assert estimate_submission(subscription(), "gpt-image-2", "image", {}) == 0


def test_subscription_drops_unverified_controls_and_preserves_references():
    source = {"size_mode": "auto", "size": "auto", "ratio": "1:1", "quality": "high",
              "background": "transparent", "resolution": "4K", "custom_size": "4096x4096",
              "n": 4, "reference_images": ["/test/reference.png"]}
    assert normalize_image_size_params(subscription(), "gpt-image-2", source) == {
        "n": 1, "reference_images": ["/test/reference.png"],
    }
    assert image_size_options("chatgpt", None, "gpt-image-2") == {
        "ratios": [], "resolutions": [],
    }
    assert not supports_auto_image_size("chatgpt", None, "gpt-image-2")
    assert source["quality"] == "high"


@pytest.mark.parametrize("params", [{"image_edit": {"mode": "inpaint"}},
                                    {"layer_decomposition": True}])
def test_subscription_rejects_unverified_edit_operations(params):
    with pytest.raises(ValueError, match="尚不支持"):
        normalize_image_size_params(subscription(), "gpt-image-2", params)


def test_subscription_job_records_zero_despite_client_cost(monkeypatch):
    keys.add_key(subscription())
    job = pending_job(estimated_cost_cny=99, actual_cost_cny=42)

    def render(*, output_dir, **kwargs):
        target = Path(output_dir) / "result.png"
        Image.new("RGB", (2, 2), "red").save(target)
        return [str(target)]

    monkeypatch.setattr(job_runner, "dispatch", render)
    final = job_runner.run_job(job.job_id)
    assert final.status == JobStatus.DONE
    assert final.provider == "chatgpt"
    assert final.params.estimated_cost_cny == final.params.actual_cost_cny == 0


def test_subscription_saved_mask_job_does_not_call_any_provider(monkeypatch):
    keys.add_key(subscription())
    job = pending_job(image_edit={"mode": "inpaint"})
    monkeypatch.setattr(job_runner, "dispatch", lambda **kwargs: pytest.fail("must not call"))
    with pytest.raises(job_runner.JobRunnerError, match="尚不支持局部编辑"):
        job_runner.run_job(job.job_id)
    final = read_job(job.job_id)
    assert final.status == JobStatus.FAILED
    assert "尚不支持局部编辑" in final.error


def test_subscription_route_preserves_order_and_clears_zero_on_paid_failover(monkeypatch):
    keys.add_key(subscription())
    paid = keys.KeySpec(alias="paid", provider="openai", access_key="test-only",
                        created_at="2026-10-27T00:00:00Z", models=subscription().models)
    keys.add_key(paid)
    model_routes.set_route_order("image", "gpt-image-2", ["paid", "subscription"])
    route = model_routes.find_route("image", "gpt-image-2")
    assert [member.alias for member in route.members] == ["paid", "subscription"]
    job = pending_job(route_id="gpt-image-2", estimated_cost_cny=0, actual_cost_cny=0)
    monkeypatch.setattr(model_routes, "next_member", lambda *args, **kwargs: (paid, paid.models[0]))
    assert job_runner._switch_route(job.job_id, RuntimeError("HTTP 401"))
    switched = read_job(job.job_id)
    assert switched.provider == "openai"
    assert switched.params.actual_cost_cny is None
    assert switched.params.estimated_cost_cny is None
