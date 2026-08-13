"""Generate Termigo's brand assets from the master logo at the repository root.

The master file (termigo.png) is a rounded-square mark rendered on an opaque
white background. Shipping it as-is puts a white box on the dark topbar and a
white fringe around the Windows taskbar icon, so this script:

  1. makes the white margin outside the rounded square transparent,
  2. writes a UI asset for the React app,
  3. writes the Tauri icon set (PNG sizes + multi-resolution .ico).

Run from the repository root:  python scripts/make-icons.py
"""

from __future__ import annotations

import io
import struct
import sys
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "termigo.png"
UI_ASSET = ROOT / "desktop" / "src" / "assets" / "termigo-mark.png"
ICON_DIR = ROOT / "desktop" / "src-tauri" / "icons"

# The legacy Wails prototype keeps its own copies; regenerate them from the same
# master so the two applications never drift apart visually.
LEGACY_ASSETS = {
    ROOT / "frontend" / "src" / "assets" / "images" / "termigo-mark.png": 512,
    ROOT / "build" / "appicon.png": 512,
}

# Square PNG icons Tauri bundles, plus the Windows Store logo sizes it expects.
PNG_ICONS = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# ICNS entry types that accept an embedded PNG payload, mapped to their pixel
# size. Written directly so the macOS icon can be refreshed from Windows.
ICNS_TYPES = {
    b"ic07": 128,
    b"ic08": 256,
    b"ic09": 512,
    b"ic11": 32,
    b"ic12": 64,
    b"ic13": 256,
    b"ic14": 512,
}

WHITE_CUTOFF = 236


def cut_white_background(image: Image.Image) -> Image.Image:
    """Clear the white margin that surrounds the rounded-square mark.

    A flood fill from the four corners is used rather than a global "white is
    transparent" rule, so the white terminal prompt glyph inside the mark keeps
    its pixels. Edge pixels are feathered by alpha so the rounded corners do not
    come out jagged.
    """
    image = image.convert("RGBA")
    width, height = image.size
    pixels = image.load()

    outside = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def consider(x: int, y: int) -> None:
        if not (0 <= x < width and 0 <= y < height) or outside[y * width + x]:
            return
        red, green, blue, _ = pixels[x, y]
        if min(red, green, blue) < WHITE_CUTOFF:
            return
        outside[y * width + x] = 1
        queue.append((x, y))

    for x in range(width):
        consider(x, 0)
        consider(x, height - 1)
    for y in range(height):
        consider(0, y)
        consider(width - 1, y)

    while queue:
        x, y = queue.popleft()
        consider(x - 1, y)
        consider(x + 1, y)
        consider(x, y - 1)
        consider(x, y + 1)

    # Feather: a background pixel touching the mark keeps partial alpha so the
    # rounded corner stays smooth instead of stair-stepping.
    for y in range(height):
        for x in range(width):
            if not outside[y * width + x]:
                continue
            red, green, blue, _ = pixels[x, y]
            # 255 = pure white margin (fully transparent), darker = anti-aliased
            # edge of the mark (partially opaque).
            brightness = min(red, green, blue)
            alpha = 0 if brightness >= 252 else int((252 - brightness) * 255 / (252 - WHITE_CUTOFF))
            pixels[x, y] = (red, green, blue, min(alpha, 255))

    return image


def square(image: Image.Image) -> Image.Image:
    """Pad to a square canvas so every generated icon keeps the aspect ratio."""
    width, height = image.size
    if width == height:
        return image
    side = max(width, height)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(image, ((side - width) // 2, (side - height) // 2))
    return canvas


def write_icns(mark: Image.Image, path: Path) -> None:
    """Write a PNG-backed .icns so macOS bundles get the current artwork.

    Pillow cannot save ICNS on Windows, but the container is simple: an 8-byte
    header followed by length-prefixed, type-tagged chunks.
    """
    chunks = bytearray()
    for icon_type, size in sorted(ICNS_TYPES.items()):
        buffer = io.BytesIO()
        mark.resize((size, size), Image.LANCZOS).save(buffer, format="PNG", optimize=True)
        payload = buffer.getvalue()
        chunks += icon_type + struct.pack(">I", len(payload) + 8) + payload
    path.write_bytes(b"icns" + struct.pack(">I", len(chunks) + 8) + bytes(chunks))


def main() -> int:
    if not MASTER.is_file():
        print(f"master logo not found: {MASTER}", file=sys.stderr)
        return 1

    mark = square(cut_white_background(Image.open(MASTER)))

    UI_ASSET.parent.mkdir(parents=True, exist_ok=True)
    mark.save(UI_ASSET, optimize=True)
    print(f"wrote {UI_ASSET.relative_to(ROOT)} ({mark.width}x{mark.height})")

    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for name, size in sorted(PNG_ICONS.items(), key=lambda item: item[1]):
        mark.resize((size, size), Image.LANCZOS).save(ICON_DIR / name, optimize=True)
    print(f"wrote {len(PNG_ICONS)} PNG icons in {ICON_DIR.relative_to(ROOT)}")

    # Pillow writes a genuine multi-resolution .ico, which is what the Windows
    # shell needs for crisp taskbar, Explorer and installer icons.
    largest = mark.resize((256, 256), Image.LANCZOS)
    ico_sizes = [(size, size) for size in ICO_SIZES]
    largest.save(ICON_DIR / "icon.ico", sizes=ico_sizes)
    print(f"wrote icon.ico ({', '.join(f'{s}x{s}' for s in ICO_SIZES)})")

    write_icns(mark, ICON_DIR / "icon.icns")
    print(f"wrote {(ICON_DIR / 'icon.icns').relative_to(ROOT)}")

    for path, size in LEGACY_ASSETS.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        mark.resize((size, size), Image.LANCZOS).save(path, optimize=True)
        print(f"wrote {path.relative_to(ROOT)} ({size}x{size})")

    legacy_ico = ROOT / "build" / "windows" / "icon.ico"
    if legacy_ico.parent.is_dir():
        largest.save(legacy_ico, sizes=ico_sizes)
        print(f"wrote {legacy_ico.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
