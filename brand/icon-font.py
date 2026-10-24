#!/usr/bin/env python3
# Builds brand/icons/icon-font.woff2, the VS Code icon font whose one glyph (U+F101) is the brand
# mark from brand/mark.svg. Status bar text shows it as $(kilo-logo). Rerun it after changing the
# mark, then `bun brand/apply.ts` copies it into the extension. Needs fonttools and brotli:
#
#   pip install --target /tmp/fonttools fonttools brotli
#   PYTHONPATH=/tmp/fonttools python3 brand/icon-font.py

import os
import re

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

root = os.path.dirname(os.path.abspath(__file__))
svg = open(os.path.join(root, "mark.svg")).read()
x0, y0, width, height = (float(v) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).split())
path = re.search(r'<path d="([^"]+)"', svg).group(1)

# Fit the mark into the em the way Kilo's font did: 1000 units, 850 above the baseline.
em, ascent, descent, margin = 1000, 850, -150, 80
scale = (em - 2 * margin) / max(width, height * 1.25)
left = (em - width * scale) / 2
top = (ascent + descent) / 2 + height * scale / 2 + 40


def point(x, y):
    return (round(left + (x - x0) * scale), round(top - (y - y0) * scale))


contours = []
for part in re.findall(r"M[^M]*", path):
    tokens = re.findall(r"[MHVLZ]|-?\d+(?:\.\d+)?", part)
    points, x, y, i = [], 0.0, 0.0, 0
    while i < len(tokens):
        op = tokens[i]
        if op in "ML":
            x, y = float(tokens[i + 1]), float(tokens[i + 2])
            i += 3
        elif op == "H":
            x = float(tokens[i + 1])
            i += 2
        elif op == "V":
            y = float(tokens[i + 1])
            i += 2
        else:
            i += 1
            continue
        points.append(point(x, y))
    area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1]))
    # TrueType fills outer contours drawn clockwise.
    contours.append(points if area < 0 else points[::-1])

pen = TTGlyphPen(None)
for points in contours:
    pen.moveTo(points[0])
    for p in points[1:]:
        pen.lineTo(p)
    pen.closePath()
mark = pen.glyph()

fb = FontBuilder(em, isTTF=True)
fb.setupGlyphOrder([".notdef", "kilo-logo"])
fb.setupCharacterMap({0xF101: "kilo-logo"})
fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "kilo-logo": mark})
mark.recalcBounds(fb.font["glyf"])
fb.setupHorizontalMetrics({".notdef": (500, 0), "kilo-logo": (em, mark.xMin)})
fb.setupHorizontalHeader(ascent=ascent, descent=descent)
fb.setupNameTable({"familyName": "brand-icon-font", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=ascent, sTypoDescender=descent, usWinAscent=ascent, usWinDescent=-descent)
fb.setupPost()
fb.font.flavor = "woff2"
fb.save(os.path.join(root, "icons", "icon-font.woff2"))
print("wrote brand/icons/icon-font.woff2", [(mark.xMin, mark.yMin, mark.xMax, mark.yMax)])
