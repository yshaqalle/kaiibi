# Dashboard tabbed sections

## Problem
`DashboardScreen` (`src/app/(owner)/(tabs)/dashboard.tsx`) renders all 9 of its content
blocks — stat tiles, revenue goal, overview trend chart, rankings, category mix, revenue
by category, payment mix, inventory alerts, recent transactions — inline in a single
`ScrollView`. There's no way to jump between them; viewing anything past "Rankings"
requires scrolling through everything above it.

## Design
Reuse the section-switcher pattern already used on the Settings screen
(`src/app/(owner)/settings.tsx`): a persistent `SegmentedControl` above the scrollable
content that swaps which block of content is mounted, instead of stacking everything.

- Add `const [section, setSection] = useState<'trends' | 'breakdown' | 'activity'>('trends')`.
- Render the pinned header unconditionally, same as today: "Dashboard" title, the 3
  `StatTile`s (today's sales, orders, low stock), and the revenue goal `GoalMeter` card
  (still conditional on `shop.monthlyRevenueGoalCents`).
- Immediately below the pinned header, render `SegmentedControl` with options
  `Trends` / `Breakdown` / `Activity`, placed the same way Settings places its
  `sectionNav` — above the `ScrollView`, not inside it.
- Inside the `ScrollView`, render only the active section's content:
  - **Trends** — "Overview" card (trend metric `SegmentedControl` + `RangeSelector` +
    `TrendChart`) and "Rankings" card (rank metric `SegmentedControl` + insight text +
    `RankingChart`).
  - **Breakdown** — "Category mix" (`CategoryDonutChart`), "Revenue by category"
    (`CategoryOverTimeChart`), "Payment mix" (`PaymentMixChart`).
  - **Activity** — "Inventory alerts" (low-stock `ProductTile` list) and "Recent
    transactions" (last 5 sales list).
- Data fetching is unchanged: the existing `reload()` `Promise.all` still fetches all 8
  data sources on mount regardless of the active tab. Only rendering becomes conditional
  on `section` — no lazy/per-tab fetching, no new loading states.
- Extract three sibling components — `TrendsSection`, `BreakdownSection`,
  `ActivitySection` — colocated next to `dashboard.tsx`, each taking the relevant
  already-computed data/state (and setters, for the in-tab toggles) as props.
  `dashboard.tsx` retains all data-fetching and derivation logic and just switches
  between the three based on `section`.

## Out of scope
- Any change to data fetching strategy (lazy loading, per-tab refresh, caching).
- Changes to the Settings screen itself.
- Changes to the Sales tab (`(tabs)/sales.tsx`), which has its own separate long-scroll
  page not addressed by this design.
- Persisting the selected tab across app restarts/navigations — it resets to "Trends"
  each time the screen mounts, same as Settings resets to "Profile".
