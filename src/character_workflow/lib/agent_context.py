"""Request-only views of the canonical agent history."""
from collections.abc import Callable

MEDIA_SCHEME = "atelier-media://"


def hydrate_user_images(items: list, resolve: Callable[[str], str | None], missing: str) -> list:
    def image_part(part):
        if not isinstance(part, dict) or part.get("type") != "input_image":
            return part
        url = part.get("image_url")
        if not isinstance(url, str) or not url.startswith(MEDIA_SCHEME):
            return part
        data_url = resolve(url.removeprefix(MEDIA_SCHEME))
        if data_url is None:
            return {"type": "input_text", "text": missing}
        return {**part, "image_url": data_url}

    return [
        {**item, "content": [image_part(part) for part in item["content"]]}
        if isinstance(item, dict) and item.get("role") == "user"
        and isinstance(item.get("content"), list) else item
        for item in items
    ]
