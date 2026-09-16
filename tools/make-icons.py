#!/usr/bin/env python3
"""Regenerate the app icons.

The mark is the Modernist language at icon scale: ink ground, no rounded
corners, a dashed accent trail between two nodes — the same dashed red route
the app draws on the map.

    python3 tools/make-icons.py
"""

import bisect
import math
import pathlib

from PIL import Image, ImageDraw

INK = (32, 30, 29, 255)        # --color-text
ACCENT = (236, 48, 19, 255)    # --color-accent
GROUND = (248, 244, 244, 255)  # --color-neutral-100

OUT = pathlib.Path(__file__).resolve().parent.parent / "assets" / "icons"

# The trail, in a 1000-unit square, drawn from the bottom left upwards.
TRAIL = [(165, 835), (350, 585), (560, 545), (835, 225)]
DASH, GAP = 80, 52


def dashed(draw, pts, width, fill):
    """Lay dashes along the polyline, measured by distance from its start.

    Positions are computed from one arc-length parameter rather than stepped
    forward segment by segment, so rounding cannot stall the walk.
    """
    seg = [math.hypot(x1 - x0, y1 - y0) for (x0, y0), (x1, y1) in zip(pts, pts[1:])]
    total = sum(seg)
    if total == 0:
        return
    cum = [0.0]
    for length in seg:
        cum.append(cum[-1] + length)

    def at(dist):
        dist = min(max(dist, 0.0), total)
        i = min(bisect.bisect_right(cum, dist) - 1, len(seg) - 1)
        if seg[i] == 0:
            return pts[i]
        t = (dist - cum[i]) / seg[i]
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        return (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)

    start = 0.0
    while start < total:
        end = min(start + DASH, total)
        # Keep any vertex the dash spans, so a dash bends with the trail.
        poly = [at(start)]
        poly += [pts[i] for i, c in enumerate(cum) if start < c < end]
        poly.append(at(end))
        draw.line([c for p in poly for c in p], fill=fill, width=width, joint="curve")
        start += DASH + GAP


def node(draw, xy, r, fill):
    x, y = xy
    draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def render(size, inset):
    """`inset` is the share of the edge kept clear — maskable icons need it."""
    scale = 4  # supersample, then downscale for clean edges
    px = size * scale
    img = Image.new("RGBA", (px, px), INK)
    draw = ImageDraw.Draw(img)

    art = px * (1 - 2 * inset)
    off = px * inset
    to_px = lambda p: (off + p[0] / 1000 * art, off + p[1] / 1000 * art)
    pts = [to_px(p) for p in TRAIL]

    dashed(draw, pts, max(1, round(art * 0.062)), GROUND)
    node(draw, pts[0], art * 0.062, ACCENT)
    node(draw, pts[-1], art * 0.062, ACCENT)

    return img.resize((size, size), Image.LANCZOS)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <rect width="1000" height="1000" fill="#201e1d"/>
  <polyline points="{pts}" fill="none" stroke="#f8f4f4" stroke-width="62"
            stroke-linejoin="round" stroke-dasharray="80 52"/>
  <circle cx="165" cy="835" r="62" fill="#ec3013"/>
  <circle cx="835" cy="225" r="62" fill="#ec3013"/>
</svg>
"""

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    render(192, 0.10).save(OUT / "icon-192.png")
    render(512, 0.10).save(OUT / "icon-512.png")
    render(512, 0.19).save(OUT / "maskable-512.png")  # inside the 80% safe zone
    (OUT / "favicon.svg").write_text(
        SVG.format(pts=" ".join(f"{x},{y}" for x, y in TRAIL))
    )
    print("wrote", ", ".join(sorted(p.name for p in OUT.iterdir())))
