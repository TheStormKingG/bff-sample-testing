#!/usr/bin/env python3
"""
Measure how red each of the four urease reference dishes is, and seal the
answer to the file that produced it.

===========================================================================
WHY THIS SCRIPT EXISTS
===========================================================================
`5 Extruded soya` asks the operator to match a petri dish against four
photographs. If two of those photographs are attached to the wrong
assessments, the form still works, the record still saves, and a properly
cooked batch is filed as undercooked until somebody notices. Nothing in the
application can detect that — a filename, an array position and a comment
are all restatements of the same assumption.

What distinguishes the dishes is how much of each is strongly red: any
urease left in the soya splits the urea in the indicator and the phenol red
turns, so the speckling is proportional to the surviving enzyme. So that is
what is measured, and the mapping in `src/forms/registry.ts` was decided
from this output rather than from the order the files arrived in — which was
in fact the REVERSE of the assessments they belong to.

===========================================================================
WHY THE TEST SUITE DOES NOT RUN THIS
===========================================================================
Decoding WebP needs an image library. This repository has none, CI installs
none, and adding one so that one assertion can re-derive a constant would be
a dependency the product does not otherwise need. So the measurement is run
HERE, by hand, and `tests/support/ureaseEvidence.ts` records each result
beside the SHA-256 of the file it came from.

`tests/qualitativeUrease.test.tsx` then checks the hashes against the files
the application ships. That does not re-measure anything and does not claim
to: it is a SEAL. Change a photograph and the hash stops matching, the suite
fails, and the author is told to run this script again. The one thing it
rules out is the thing that actually goes wrong — a picture quietly
replaced, or reordered, with the recorded evidence left behind describing
the file that used to be there.

Usage (needs Pillow; `pip install Pillow`):

    scripts/measure-urease-dishes.py
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

try:
    from PIL import Image
except ModuleNotFoundError:
    sys.exit("This script needs Pillow: pip install Pillow")

REPO = Path(__file__).resolve().parent.parent
DISHES = REPO / "public" / "urease"

# Gallery order in `src/forms/registry.ts`: over cooked to under cooked.
ORDER = [
    "over-cooked.webp",
    "properly-cooked-slight.webp",
    "properly-cooked-moderate.webp",
    "under-cooked.webp",
]


def red_fraction(path: Path) -> float:
    """
    Share of the DISH that is strongly red.

    Sampled inside a circle of 0.4 x the image width, which is the dish and
    not the white surround: the glass rim and the background are the same in
    all four photographs and would dilute every reading by the same amount,
    flattening exactly the differences being measured.

    A pixel counts as red when its green and blue channels are well below its
    red one. The orange ground of a cooked dish fails that test; a phenol-red
    speck passes it. The absolute percentage is not meaningful on its own —
    it depends on this threshold — which is why the registry comment and the
    test both speak about the ORDER rather than the numbers.
    """
    image = Image.open(path).convert("RGB")
    width, height = image.size
    pixels = image.load()
    cx, cy = width / 2, height / 2
    radius = min(width, height) * 0.40
    total = red = 0
    for y in range(height):
        for x in range(width):
            if (x - cx) ** 2 + (y - cy) ** 2 > radius * radius:
                continue
            r, g, b = pixels[x, y]
            # Near-black pixels are shadow under the rim, not meal.
            if r < 60:
                continue
            total += 1
            if g <= 0.45 * r and b <= 0.55 * r:
                red += 1
    return red / total if total else 0.0


def main() -> int:
    rows = []
    for name in ORDER:
        path = DISHES / name
        if not path.exists():
            sys.exit(f"missing {path}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rows.append((name, digest, red_fraction(path) * 100))

    previous = -1.0
    for name, digest, percent in rows:
        flag = "" if percent > previous else "   <-- NOT redder than the one above"
        previous = percent
        print(f"{name:34s} {percent:7.4f}%  {digest}{flag}")

    if any(rows[i][2] <= rows[i - 1][2] for i in range(1, len(rows))):
        print(
            "\nThe four dishes are NOT in increasing order of redness. Either the files\n"
            "are mismatched to their assessments or one has been replaced. Do not\n"
            "update the evidence file until that is resolved.",
            file=sys.stderr,
        )
        return 1

    print("\nPaste into tests/support/ureaseEvidence.ts:\n")
    for name, digest, percent in rows:
        print(
            f"  {{ image: 'urease/{name}', sha256: '{digest}', redPercent: {percent:.4f} }},"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
