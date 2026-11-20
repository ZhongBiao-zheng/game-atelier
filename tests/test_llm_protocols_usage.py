"""用量归一（计费以此为准，ADR-0044）。夹具取自各家官方文档的原样样例。"""
from character_workflow.lib.llm_protocols.usage import (
    Usage, from_anthropic, from_gemini, from_openai, to_chat,
)


def _four(usage: Usage) -> tuple[int, int, int, int]:
    return usage.input_total, usage.cache_read, usage.cache_write, usage.output_total


def test_anthropic_input_tokens_exclude_cache_so_total_adds_all_three():
    # https://platform.claude.com/docs/en/build-with-claude/prompt-caching 「1-hour cache duration」样例；
    # 文档原文：total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens
    sample = {
        "input_tokens": 2048,
        "cache_read_input_tokens": 1800,
        "cache_creation_input_tokens": 248,
        "output_tokens": 503,
        "cache_creation": {"ephemeral_5m_input_tokens": 148, "ephemeral_1h_input_tokens": 100},
    }
    assert _four(from_anthropic(sample)) == (4096, 1800, 248, 503)


def test_anthropic_without_cache_fields():
    # https://platform.claude.com/docs/en/build-with-claude/streaming 的 message_start 样例
    assert _four(from_anthropic({"input_tokens": 25, "output_tokens": 1})) == (25, 0, 0, 1)


def test_openai_chat_prompt_tokens_already_include_cache():
    # https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
    sample = {
        "prompt_tokens": 19, "completion_tokens": 10, "total_tokens": 29,
        "prompt_tokens_details": {"cached_tokens": 0, "audio_tokens": 0},
        "completion_tokens_details": {"reasoning_tokens": 0, "audio_tokens": 0,
                                      "accepted_prediction_tokens": 0,
                                      "rejected_prediction_tokens": 0},
    }
    assert _four(from_openai(sample)) == (19, 0, 0, 10)


def test_openai_responses_input_tokens_include_cache_reads_and_writes():
    # https://developers.openai.com/api/docs/guides/prompt-caching
    # 「Input usage fields with both write lifetimes」：1000 = 12000 − 4000 − 7000 是普通输入。
    sample = {
        "input_tokens": 12000,
        "input_tokens_details": {
            "cached_tokens": 4000,
            "cache_write_tokens": 7000,
            "cache_write_tokens_details": {"ttl_30m_tokens": 3000, "ttl_12h_tokens": 4000},
        },
        "output_tokens": 0,
    }
    assert _four(from_openai(sample)) == (12000, 4000, 7000, 0)


def test_gemini_prompt_includes_cache_and_output_adds_thoughts():
    # Gemini 文档没有带全部字段的 usageMetadata 原样样例；按字段定义构造：
    # https://aistudio.google.com/api-reference/generate-content —— promptTokenCount「includes the
    # number of tokens in the cached content」；totalTokenCount = prompt + tool-use prompt + thoughts +
    # response candidates。下面四个数满足这条等式（1000 + 50 + 150 + 200 = 1400）。
    sample = {
        "promptTokenCount": 1000, "cachedContentTokenCount": 600,
        "toolUsePromptTokenCount": 50, "thoughtsTokenCount": 150,
        "candidatesTokenCount": 200, "totalTokenCount": 1400,
    }
    usage = from_gemini(sample)
    assert _four(usage) == (1050, 600, 0, 350)
    assert usage.reasoning == 150
    assert usage.input_total + usage.output_total == sample["totalTokenCount"]


def test_incomplete_usage_is_unknown_not_zero():
    assert from_anthropic({"output_tokens": 5}) is None
    assert from_openai({"prompt_tokens": 5}) is None
    assert from_gemini({"candidatesTokenCount": 5}) is None
    assert from_openai({"prompt_tokens": True, "completion_tokens": 1}) is None


def test_to_chat_round_trips_through_openai_reader():
    usage = Usage(input_total=4096, cache_read=1800, cache_write=248, output_total=503)
    chat = to_chat(usage)
    assert chat["prompt_tokens"] == 4096 and chat["total_tokens"] == 4599
    assert from_openai(chat) == usage
