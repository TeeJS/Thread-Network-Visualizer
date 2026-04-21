"""
Generate icon.png for the Thread Network Visualizer.

Targets Unraid's Docker tab icon at ~64x64 display size, so we render at 128x128
(community maximum) with stroke widths and node sizes chosen to stay legible
when downsampled. High-contrast palette works against Unraid's dark and light
themes alike.

Run: python3 tools/make_icon.py
Writes: icon.png (128x128 RGBA) in the repo root.
"""
from __future__ import annotations

import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

SIZE = 128
OUT = Path(__file__).resolve().parent.parent / "icon.png"

# Palette tuned for legibility on both dark and light backgrounds.
BG        = (14, 22, 40, 255)    # deep navy rounded square - our "chip"
BG_EDGE   = (46, 78, 126, 255)   # subtle border
EDGE_COL  = (120, 200, 255, 255) # light cyan mesh lines
BR_COL    = (255, 196, 60, 255)  # amber hub (border router)
LEAF_COL  = (118, 220, 165, 255) # mint green for leaf nodes
BR_RING   = (255, 255, 255, 230) # bright ring around hub

def rounded_square(img: Image.Image, radius: int, fill, outline=None, width=0) -> None:
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=radius, fill=fill,
                         outline=outline, width=width)

def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    rounded_square(img, radius=22, fill=BG, outline=BG_EDGE, width=2)

    # Draw the mesh on a higher-resolution canvas then downsample for smooth
    # edges (cheap antialiasing - PIL's basic draw primitives are jaggy).
    SCALE = 4
    mesh = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE), (0, 0, 0, 0))
    md = ImageDraw.Draw(mesh)

    cx, cy = SIZE * SCALE // 2, SIZE * SCALE // 2
    hub_r = 14 * SCALE
    leaf_r = 9 * SCALE
    ring_gap = 3 * SCALE
    orbit = 38 * SCALE
    edge_w = 4 * SCALE

    # Leaf positions: 4 nodes evenly placed around the hub.
    leaves = []
    for i in range(4):
        angle = math.radians(-90 + i * 90 + 45)  # 45, 135, 225, 315 -> diamond
        lx = cx + int(orbit * math.cos(angle))
        ly = cy + int(orbit * math.sin(angle))
        leaves.append((lx, ly))

    # Edges first so they sit behind the nodes.
    for lx, ly in leaves:
        md.line([(cx, cy), (lx, ly)], fill=EDGE_COL, width=edge_w)
    # Also draw one edge between two leaves to suggest a mesh (not a star).
    md.line([leaves[0], leaves[1]], fill=EDGE_COL, width=edge_w)
    md.line([leaves[2], leaves[3]], fill=EDGE_COL, width=edge_w)

    # Leaf nodes
    for lx, ly in leaves:
        md.ellipse((lx - leaf_r, ly - leaf_r, lx + leaf_r, ly + leaf_r),
                   fill=LEAF_COL)

    # Hub ring + hub
    md.ellipse((cx - hub_r - ring_gap, cy - hub_r - ring_gap,
                cx + hub_r + ring_gap, cy + hub_r + ring_gap),
               fill=BR_RING)
    md.ellipse((cx - hub_r, cy - hub_r, cx + hub_r, cy + hub_r), fill=BR_COL)

    mesh = mesh.resize((SIZE, SIZE), Image.LANCZOS)
    img.alpha_composite(mesh)

    # A whisper of drop shadow beneath to pop off a white background in the
    # light Unraid theme.
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((2, 4, SIZE - 3, SIZE - 1), radius=22, fill=(0, 0, 0, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(2))
    composed = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    composed.alpha_composite(shadow)
    composed.alpha_composite(img)

    composed.save(OUT, format="PNG", optimize=True)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")

if __name__ == "__main__":
    main()
