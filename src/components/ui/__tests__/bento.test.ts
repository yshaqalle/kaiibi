import { bentoCellFraction } from '@/components/ui/bento';

// The grid widths real devices hand the bento: the window, less the ~210pt
// admin sidebar where the nav shell draws one, less 36pt of page padding.
const GRID = {
  phone: 366,
  miniPortrait: 502,
  proPortrait: 778,
  miniLandscape: 887,
  proLandscape: 1120,
  desktop: 2149,
};

const MIN_CARD = 240;

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
      const px = bentoCellFraction(span, width) * width;
      // A full-width card is the widest a grid can offer: on a screen too
      // narrow for even that, the floor is the screen, not a bug.
      expect(px >= MIN_CARD || bentoCellFraction(span, width) === 1).toBe(true);
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
    expect(bentoCellFraction(2, GRID.proPortrait) * GRID.proPortrait).toBeGreaterThanOrEqual(MIN_CARD);
    // ...and on the landscape iPad, where it came out 187pt and broke "Revenue".
    expect(bentoCellFraction(2, GRID.proLandscape) * GRID.proLandscape).toBeGreaterThanOrEqual(MIN_CARD);
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
      for (let width = 320; width <= 2400; width += 20) {
        const fraction = bentoCellFraction(span, width);
        const px = fraction * width;
        expect(px >= MIN_CARD || fraction === 1).toBe(true);
      }
    }
  });
});
