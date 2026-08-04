"""Generates the Accounting tab icon at 1x/2x/3x.

Matches the existing tabIcons style: a solid silhouette with knocked-out
detail, rendered as a black RGBA image whose alpha carries the shape (the
sidebar tints it, so only alpha matters).

A calculator rather than the bar chart it replaces -- bars read as analytics,
which is what the tab meant when it was "Sales". Also stays distinct from the
other tabs: cart (POS), grid (inventory), person (People), house (Dashboard).
"""

from PIL import Image, ImageDraw

BASE = 24          # design grid; exported at 1x/2x/3x
SS = 16            # supersample factor, downsampled for antialiasing


def build_mask(size: int) -> Image.Image:
    """White where the icon is solid, black where it's cut away."""
    s = size / BASE  # scale from the 24px design grid
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)

    def px(*v):
        return [x * s for x in v]

    # Body: a calculator, taller than wide. Sized so the rendered bounds land
    # near 58px at @3x -- the rest of the set measures 56-64, and an icon
    # running edge to edge reads heavier than its neighbours in the nav.
    d.rounded_rectangle(px(5.5, 3.2, 18.5, 21.0), radius=2.4 * s, fill=255)

    # Display window.
    d.rounded_rectangle(px(7.7, 5.5, 16.3, 9.0), radius=0.9 * s, fill=0)

    # Keypad: 3 x 3. Circles read more cleanly than squares once downsampled
    # to 24px, where a 1px square loses its corners anyway.
    cols = [9.15, 12.0, 14.85]
    rows = [12.4, 15.2, 18.0]
    r = 1.05
    for cy in rows:
        for cx in cols:
            d.ellipse(px(cx - r, cy - r, cx + r, cy + r), fill=0)

    return mask


def render(size: int) -> Image.Image:
    mask = build_mask(size * SS).resize((size, size), Image.LANCZOS)
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    icon.putalpha(mask)
    # Solid black; the app tints it per state.
    icon.paste((0, 0, 0), (0, 0, size, size), mask)
    icon.putalpha(mask)
    return icon


if __name__ == "__main__":
    import sys

    out = sys.argv[1]
    for suffix, scale in (("", 1), ("@2x", 2), ("@3x", 3)):
        path = f"{out}/accounting{suffix}.png"
        render(BASE * scale).save(path)
        print("wrote", path)
