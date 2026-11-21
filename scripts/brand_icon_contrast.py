"""量彩色品牌图标的主色与图标方块底色的对比度，输出 web/src/components/brandColors.ts 里那张表的数值。

用法：uv run python scripts/brand_icon_contrast.py

- 主色：SVG 里 fill 与渐变 stop-color 出现次数最多的颜色；次数相同取先出现的。
  currentColor 在 <img> 里没有文字色可继承，按黑色算。
- 底色：图标所在方块的 --secondary（web/src/styles/tokens.css）：暗色 #26262A、亮色 #E9E9EB。
- 对比度：WCAG 2.x 相对亮度公式 (L1 + 0.05) / (L2 + 0.05)，非文本元素按 3:1 判。
"""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "web" / "src" / "assets" / "brands-color"
SURFACES = {"dark": "#26262A", "light": "#E9E9EB"}
_COLOR = re.compile(r'(?:fill|stop-color)="(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|currentColor)"')


def luminance(hex_color: str) -> float:
    value = hex_color.lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)

    def channel(part: str) -> float:
        c = int(part, 16) / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(value[i:i + 2]) for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def main_color(svg: str) -> str:
    colors = ["#000000" if c == "currentColor" else c.upper() for c in _COLOR.findall(svg)]
    counts = Counter(colors)
    top = max(counts.values())
    return next(c for c in colors if counts[c] == top)


def main() -> None:
    for path in sorted(ICONS.glob("*.svg")):
        color = main_color(path.read_text(encoding="utf-8"))
        dark, light = (round(contrast(color, SURFACES[k]), 2) for k in ("dark", "light"))
        print(f"  {path.stem}: {{ main: '{color}', dark: {dark}, light: {light} }},")


if __name__ == "__main__":
    main()
