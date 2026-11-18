"""Build the macOS menu-bar (tray) template icon from the product mark.

The Dock icon (with its backplate and margins) shrinks to a 9 px squiggle in the menu bar, so the
tray uses the bare glyph: cropped tight, strokes thickened for 18 pt, black + alpha, marked as a
template so macOS tints it for light and dark menu bars.

    uv run python scripts/build_tray_icon.py

Writes assets/brand/atelier-tray-template.png (rasterised with @resvg/resvg-js from desktop/).
"""
from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageFilter

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "assets/brand/atelier-mark.svg"
TARGET = REPO / "assets/brand/atelier-tray-template.png"
# Square render of the 1000x1000 mark that the dilation below is tuned for.
RENDER = 512
# The menu bar draws the image 18 pt tall; render at 3x so it stays sharp on every display.
HEIGHT = 54
# Glyph height inside the image: about 17 pt of the 18 pt slot, like the neighbouring icons.
GLYPH = 51
# Dilation on the 512 px render: thin calligraphic strokes become about 2 pt at menu-bar size.
THICKEN = 13


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "mark.png"
        render = ("const fs=require('fs');const {Resvg}=require('@resvg/resvg-js');"
                  "const [src,out,size]=process.argv.slice(1);"
                  "fs.writeFileSync(out,new Resvg(fs.readFileSync(src,'utf8'),"
                  "{fitTo:{mode:'width',value:Number(size)},background:'rgba(0,0,0,0)'}).render().asPng());")
        subprocess.run(["node", "-e", render, str(SOURCE), str(target), str(RENDER)], cwd=REPO / "desktop",
                       check=True)
        alpha = Image.open(target).convert("RGBA").getchannel("A")
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
