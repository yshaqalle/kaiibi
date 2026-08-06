import { DETAIL_TWO_COLUMN_BREAKPOINT, TABLET_BREAKPOINT, detailColumnsForWidth } from '@/constants/layout';

// The three window classes the People detail pane has to survive. The middle
// one is the case worth pinning: between the two-pane switch and the
// two-column switch the panes are side by side but the detail is NOT split,
// because two ~320px columns force the stat tiles to wrap 2x2 for no gain.
describe('detailColumnsForWidth', () => {
  it('is one column on a phone', () => {
    expect(detailColumnsForWidth(390)).toBe(1);
  });

  it('is one column in the gap between the two-pane and two-column widths', () => {
    expect(detailColumnsForWidth(1024)).toBe(1);
  });

  it('is two columns on a wide desktop window', () => {
    expect(detailColumnsForWidth(1440)).toBe(2);
  });

  // Boundary, stated explicitly so a later refactor cannot quietly flip the
  // comparison from >= to >.
  it('switches to two columns exactly at the breakpoint', () => {
    expect(detailColumnsForWidth(DETAIL_TWO_COLUMN_BREAKPOINT - 1)).toBe(1);
    expect(detailColumnsForWidth(DETAIL_TWO_COLUMN_BREAKPOINT)).toBe(2);
  });

  it('sits above the two-pane breakpoint', () => {
    expect(DETAIL_TWO_COLUMN_BREAKPOINT).toBeGreaterThan(TABLET_BREAKPOINT);
  });
});
