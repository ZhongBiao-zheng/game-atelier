"""Build the macOS menu-bar (tray) template icon from the product mark.

The Dock icon (with its backplate and margins) shrinks to a 9 px squiggle in the menu bar, so the
tray uses the bare glyph: cropped tight, strokes thickened for 18 pt, black + alpha, marked as a
template so macOS tints it for light and dark menu bars.

    uv run python scripts/build_tray_icon.py

Writes assets/brand/atelier-tray-template.png (rasterised with the Tauri CLI already in desktop/).
"""
from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import tempfile

from PIL import Image, ImageFilter

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "assets/brand/atelier-mark.svg"
TARGET = REPO / "assets/brand/atelier-tray-template.png"
# tray-icon draws the image 18 pt tall; render at 3x so it stays sharp on every display.
HEIGHT = 54
# Glyph height inside the image: about 17 pt of the 18 pt slot, like the neighbouring icons.
GLYPH = 51
# Dilation on the 512 px render: thin calligraphic strokes become about 2 pt at menu-bar size.
THICKEN = 13


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        pnpm = shutil.which("pnpm") or "pnpm"
        subprocess.run([pnpm, "tauri", "icon", str(SOURCE), "--output", tmp], cwd=REPO / "desktop",
                       check=True, stdout=subprocess.DEVNULL)
        alpha = Image.open(Path(tmp) / "icon.png").convert("RGBA").getchannel("A")
    alpha = alpha.filter(ImageFilter.MaxFilter(THICKEN))
    glyph = alpha.crop(alpha.getbbox())
    width = round(glyph.width * GLYPH / glyph.height)
    glyph = glyph.resize((width, GLYPH), Image.LANCZOS)
    pad = (HEIGHT - GLYPH) // 2
    mask = Image.new("L", (width + 2 * pad, HEIGHT), 0)
    mask.paste(glyph, (pad, pad))
    icon = Image.new("RGBA", mask.size, (0, 0, 0, 0))
    icon.putalpha(mask)
    icon.save(TARGET, optimize=True)
    print(f"{TARGET.relative_to(REPO)}: {icon.size[0]}x{icon.size[1]}")


if __name__ == "__main__":
    main()
