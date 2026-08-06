// Below this width, admin screens use their phone-shaped layout (bottom
// nav, stacked panes). At or above it, they switch to the wide/tablet
// layout (sidebar nav, side-by-side panes). Shared by the nav shell
// (admin-tabs.tsx, admin-tabs.web.tsx, admin-sidebar.tsx) and screens that
// reflow at the same threshold (pos.tsx).
export const TABLET_BREAKPOINT = 820;

// Above this width the People detail pane splits into two columns: who the
// person is on the left, what they have done on the right. Below it two
// columns would be too narrow to be worth it -- at 1100px itself: subtract
// the 220px admin sidebar and 36px of body padding, leaving 844px; the list
// pane takes 34% of that (~287px) plus an 18px gap to the detail pane, which
// leaves the detail pane ~539px wide; split that into two columns with a
// 14px gap and each is ~262px, which forces the stat tiles to wrap 2x2 --
// survivable, but no better than stacking.
//
// Higher than TABLET_BREAKPOINT on purpose: the panes go side by side first,
// and only a genuinely wide window splits the detail as well.
export const DETAIL_TWO_COLUMN_BREAKPOINT = 1100;

export function detailColumnsForWidth(width: number): 1 | 2 {
  return width >= DETAIL_TWO_COLUMN_BREAKPOINT ? 2 : 1;
}
