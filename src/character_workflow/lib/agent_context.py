"""Request-only views of the canonical agent history."""
from collections.abc import Callable

MEDIA_SCHEME = "atelier-media://"


RECENT_USER_TURNS = 2


def user_turn_starts(items: list) -> list[int]:
    return [i for i, item in enumerate(items) if isinstance(item, dict) and item.get("role") == "user"]


def hydrate_user_images(items: list, resolve: Callable[[str], str | None], missing: str) -> list:
    def image_part(part, recent):
        if not isinstance(part, dict) or part.get("type") != "input_image":
            return part
        url = part.get("image_url")
        if not isinstance(url, str) or not url.startswith(MEDIA_SCHEME):
            return part
        ref = url.removeprefix(MEDIA_SCHEME)
        if not recent:
            return {"type": "input_text", "text": f"[早期参考图已省略：media_ref={ref}，需要时调用 read_media]"}
        data_url = resolve(ref)
        if data_url is None:
            return {"type": "input_text", "text": missing}
        return {**part, "image_url": data_url}

    result = list(items)
    turns = user_turn_starts(items)
    for turn, start in enumerate(turns):
        item = items[start]
        if isinstance(item.get("content"), list):
            recent = turn >= len(turns) - RECENT_USER_TURNS
            result[start] = {**item, "content": [image_part(part, recent) for part in item["content"]]}
    return result
