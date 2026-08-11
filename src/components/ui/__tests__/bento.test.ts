import { bentoCellFraction, MIN_TILE } from '@/components/ui/bento';

// The grid widths real devices hand the bento: the window, less the ~210pt
// admin sidebar where the nav shell draws one, less 36pt of page padding, PLUS
// the 14pt the grid's own negative gutter margin gives back. That last term is
// not a rounding detail -- `BentoGrid` sizes itself with `marginHorizontal:
// -GAP / 2`, so the width its `onLayout` reports is 14pt wider than the page it
// sits on, and that reported number is what reaches the rule.
const GRID = {
  phone: 380,
  proMaxPhone: 418,
  miniPortrait: 516,
  proPortrait: 792,
  miniLandscape: 901,
  proLandscape: 1134,
  // A browser at 1440 and one at 1508, both full-screen with the sidebar out:
  // the two widths the Overview band is actually read at, and the pair that
  // `MIN_TILE` exists for.
  laptop: 1198,
  laptopWide: 1266,
  desktop: 2163,
};

const MIN_CARD = 240;
// Matches GAP in bento.tsx. A cell spends half of it on each side as padding,
// so the CARD is always a full gutter narrower than the cell.
const GAP = 14;

// What the reader actually sees, which is the only width the floor is about.
const cardWidth = (span: number, grid: number) => bentoCellFraction(span, grid) * grid - GAP;

// The spans the two converted screens actually pass, so a regression in the
// rule shows up as a failure here rather than as a screenshot someone happens
// to take.
const DASHBOARD_SPANS = [3, 3, 2, 2, 2, 12, 5, 7, 3, 3, 3, 3, 7, 5, 6, 6];
const ACCOUNTING_SPANS = [12, 7, 5, 6, 6];
const ALL_SPANS = [...new Set([...DASHBOARD_SPANS, ...ACCOUNTING_SPANS])];

describe('bentoCellFraction', () => {
  // The whole point of the rule. Everything else is a consequence of it.
  it.each(Object.entries(GRID))('never leaves a card under the floor on %s', (_name, width) => {
    for (const span of ALL_SPANS) {
      // A full-width card is the widest a grid can offer: on a screen too
      // narrow for even that, the floor is the screen, not a bug.
      expect(cardWidth(span, width) >= MIN_CARD || bentoCellFraction(span, width) === 1).toBe(true);
    }
  });

  // The bug this pins: on a 440pt phone the grid measures 418pt, 7/12 of that
  // is 243.8pt, and the floor let it through -- but a cell spends a gutter on
  // padding, so the card the reader got was 229.8pt. Revenue, Revenue vs.
  // expenses and the profit waterfall all sat at 58% of a phone with the other
  // 42% empty beside them, because their span-5 partners had already stepped up
  // to full width.
  it('stacks every card on the largest phone, gutter included', () => {
    for (const span of ALL_SPANS) {
      expect(bentoCellFraction(span, GRID.proMaxPhone)).toBe(1);
    }
  });

  // The same defect one size up, and the reason the fix is a rule rather than a
  // wider floor: an iPad mini fits a 7/12 card and cannot fit the 5/12 one
  // beside it, so keeping the 7 partial buys a lone card and a hole.
  it('never leaves a partial-width card with nothing that fits beside it', () => {
    for (let width = 320; width <= 2400; width += 2) {
      for (const span of ALL_SPANS) {
        const fraction = bentoCellFraction(span, width);
        if (fraction === 1) continue;
        const remainder = (1 - fraction) * width - GAP;
        expect(remainder).toBeGreaterThanOrEqual(MIN_CARD);
      }
    }
  });

  it('keeps the design proportion wherever it already fits', () => {
    // Desktop is the width the design was drawn at, so nothing should move.
    for (const span of ALL_SPANS) {
      expect(bentoCellFraction(span, GRID.desktop)).toBeCloseTo(span / 12, 5);
    }
    // The Overview band stays five across there: the spans still sum to one row.
    const band = [3, 3, 2, 2, 2].reduce((sum, s) => sum + bentoCellFraction(s, GRID.desktop), 0);
    expect(band).toBeCloseTo(1, 5);
  });

  it('stacks to a single column on a phone', () => {
    for (const span of ALL_SPANS) {
      expect(bentoCellFraction(span, GRID.phone)).toBe(1);
    }
  });

  it('widens the small Overview cards on a tablet rather than shaving slivers', () => {
    // span=2 is the case three breakpoint attempts never fixed: it resolves to
    // 1/6 at both 12 and 6 columns, which is 130pt here.
    expect(bentoCellFraction(2, GRID.proPortrait)).toBeCloseTo(1 / 3, 5);
    expect(cardWidth(2, GRID.proPortrait)).toBeGreaterThanOrEqual(MIN_CARD);
    // ...and on the landscape iPad, where it came out 187pt and broke "Revenue".
    expect(cardWidth(2, GRID.proLandscape)).toBeGreaterThanOrEqual(MIN_CARD);
  });

  // The bug this pins: the Overview band is one strip of five, and it only ever
  // read as one at 85% browser zoom. At 100% on the same window the three small
  // cells were 197pt cards judged against a 240 floor written for cards with
  // sentences in them, so all three stepped up to a third and two wrapped under
  // the other three.
  it('keeps the Overview band in one row on a laptop once the tiles carry their own floor', () => {
    for (const grid of [GRID.laptop, GRID.laptopWide]) {
      // Today's floor is what broke it, and that has to stay true or the test
      // is passing on a width where nothing was ever wrong.
      expect(bentoCellFraction(2, grid)).toBeCloseTo(1 / 3, 5);
      expect(bentoCellFraction(2, grid, MIN_TILE)).toBeCloseTo(1 / 6, 5);

      const band =
        bentoCellFraction(3, grid) * 2 + bentoCellFraction(2, grid, MIN_TILE) * 3;
      expect(band).toBeCloseTo(1, 5);
    }
  });

  // A lower floor is a claim about the tile's contents, not a licence to shrink
  // without limit: below the laptop widths the band still steps up and wraps,
  // exactly as it did before.
  it('still widens the tiles where even 184 does not fit', () => {
    // A 1366 laptop: a sixth is 173pt.
    expect(bentoCellFraction(2, 1124, MIN_TILE)).toBeCloseTo(1 / 3, 5);
    expect(bentoCellFraction(2, GRID.proPortrait, MIN_TILE)).toBeCloseTo(1 / 3, 5);
    expect(bentoCellFraction(2, GRID.phone, MIN_TILE)).toBe(1);
  });

  it('holds the tile floor at every width, and never below the span asked for', () => {
    for (let width = 320; width <= 2400; width += 2) {
      const fraction = bentoCellFraction(2, width, MIN_TILE);
      expect(fraction).toBeGreaterThanOrEqual(2 / 12 - 1e-9);
      expect(fraction * width - GAP >= MIN_TILE || fraction === 1).toBe(true);
    }
  });

  it('leaves every other cell on the default floor', () => {
    // The floor is per-cell, so a screen that passes nothing is untouched --
    // this is what says Accounting cannot move when the Dashboard does.
    for (const width of Object.values(GRID)) {
      for (const span of ACCOUNTING_SPANS) {
        expect(bentoCellFraction(span, width, undefined)).toBe(bentoCellFraction(span, width));
      }
    }
  });

  it('leaves the wide Accounting pairings alone where they already fit', () => {
    // 7/12 and 5/12 are 454pt and 324pt on the portrait iPad — both clear the
    // floor, so the two-up reading of Revenue beside Payment methods survives.
    expect(bentoCellFraction(7, GRID.proPortrait)).toBeCloseTo(7 / 12, 5);
    expect(bentoCellFraction(5, GRID.proPortrait)).toBeCloseTo(5 / 12, 5);
  });

  it('never returns a fraction narrower than the span asked for', () => {
    for (const width of Object.values(GRID)) {
      for (const span of ALL_SPANS) {
        expect(bentoCellFraction(span, width)).toBeGreaterThanOrEqual(span / 12 - 1e-9);
      }
    }
  });

  it('clamps spans outside 1..12 instead of producing a bogus width', () => {
    // 0 and negatives clamp to 1; a 1/12 card is 179pt even on the desktop
    // grid, so the floor then widens it — which is the rule working, not a
    // clamp failure. Compare against span=1 rather than against 1/12.
    expect(bentoCellFraction(0, GRID.desktop)).toBe(bentoCellFraction(1, GRID.desktop));
    expect(bentoCellFraction(-4, GRID.desktop)).toBe(bentoCellFraction(1, GRID.desktop));
    expect(bentoCellFraction(99, GRID.desktop)).toBe(1);
  });

  // Deliberately NOT monotonic in pixels: the moment a grid grows wide enough
  // to fit three across, each card is narrower than it was at full width. That
  // is ordinary reflow. The invariant that has to hold is the floor.
  it('holds the floor at every width between a phone and a desktop', () => {
    for (const span of ALL_SPANS) {
      for (let width = 320; width <= 2400; width += 2) {
        const fraction = bentoCellFraction(span, width);
        expect(cardWidth(span, width) >= MIN_CARD || fraction === 1).toBe(true);
      }
    }
  });
});
