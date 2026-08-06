// Below this width, admin screens use their phone-shaped layout (bottom
// nav, stacked panes). At or above it, they switch to the wide/tablet
// layout (sidebar nav, side-by-side panes). Shared by the nav shell
// (admin-tabs.tsx, admin-tabs.web.tsx, admin-sidebar.tsx) and screens that
// reflow at the same threshold (pos.tsx).
export const TABLET_BREAKPOINT = 820;

// Above this width the People detail pane splits into two columns: who the
// person is on the left, what they have done on the right. Below it the pane
// is under ~660px and two columns would be ~320px each, which forces the stat
// tiles to wrap 2x2 -- survivable, but no better than stacking.
//
// Higher than TABLET_BREAKPOINT on purpose: the panes go side by side first,
// and only a genuinely wide window splits the detail as well.
export const DETAIL_TWO_COLUMN_BREAKPOINT = 1100;

export function detailColumnsForWidth(width: number): 1 | 2 {
  return width >= DETAIL_TWO_COLUMN_BREAKPOINT ? 2 : 1;
}
