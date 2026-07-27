# Dashboard Tabbed Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Dashboard tab's single 9-section `ScrollView` with a pinned header (stats + revenue goal) plus a `SegmentedControl` that switches between three grouped tabs — Trends, Breakdown, Activity — mirroring the pattern already used on the Settings screen.

**Architecture:** Extract the three content groups into sibling functions (`TrendsSection`, `BreakdownSection`, `ActivitySection`) defined in the same file, matching how `src/app/(owner)/settings.tsx` colocates its own `ProfileSection`/`ShopSection`/etc. `DashboardScreen` keeps all data fetching/derivation and just switches which section renders based on new `section` state.

**Tech Stack:** React Native, Expo, existing `SegmentedControl` component (`src/components/segmented-control.tsx`), TypeScript.

## Global Constraints

- No new test framework/tests: this codebase has Jest configured but zero test files for screens; verification for this feature is manual, via the Expo simulator (use the `run` skill), matching how the sibling `settings.tsx` / `product modal` changes were verified.
- Follow the Settings screen's exact pattern: `SegmentedControl` placed in its own `View` above the `ScrollView` (not inside it), sourced from `@/components/segmented-control`.
- No changes to data fetching (`reload()` `Promise.all`, `getMonthToDateRevenueCents` effect) — only rendering becomes conditional on the active tab.
- No new files — section functions are added to the existing `src/app/(owner)/(tabs)/dashboard.tsx`, consistent with how Settings' sections all live in `settings.tsx`.
- Spec reference: `docs/superpowers/specs/2026-07-26-dashboard-tabbed-sections-design.md`.

---

### Task 1: Extract TrendsSection, BreakdownSection, ActivitySection (behavior-preserving)

**Files:**
- Modify: `src/app/(owner)/(tabs)/dashboard.tsx`

**Interfaces:**
- Produces: `TrendsSection`, `BreakdownSection`, `ActivitySection` components (module-scope functions in `dashboard.tsx`) with the prop types shown below. Task 2 consumes these exact prop names.

- [ ] **Step 1: Add the three section prop types and components**

Insert these directly below the closing brace of `DashboardScreen` (i.e., after line 247, before the `const styles = StyleSheet.create({` block):

```tsx
type TrendsSectionProps = {
  trendMetric: TrendMetric;
  onTrendMetricChange: (metric: TrendMetric) => void;
  onDateRangeChange: (range: DateRange) => void;
  trendData: TrendPoint[];
  trendFormatValue: (value: number) => string;
  rankMetric: RankMetric;
  onRankMetricChange: (metric: RankMetric) => void;
  insight: string | null;
  rankItems: RankingItem[];
  rankFormatValue: (value: number) => string;
  rankEmptyLabel: string;
};

function TrendsSection({
  trendMetric,
  onTrendMetricChange,
  onDateRangeChange,
  trendData,
  trendFormatValue,
  rankMetric,
  onRankMetricChange,
  insight,
  rankItems,
  rankFormatValue,
  rankEmptyLabel,
}: TrendsSectionProps) {
  return (
    <>
      <Text style={[styles.sectionTitle, { color: theme.text }]}>Overview</Text>
      <Card style={styles.chartCard}>
        <SegmentedControl options={TREND_OPTIONS} value={trendMetric} onChange={onTrendMetricChange} />
        <RangeSelector onChange={onDateRangeChange} />
        <TrendChart data={trendData} formatValue={trendFormatValue} />
      </Card>

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Rankings</Text>
      {insight ? <Text style={[styles.insight, { color: theme.textSecondary }]}>{insight}</Text> : null}
      <Card style={styles.chartCard}>
        <SegmentedControl options={RANK_OPTIONS} value={rankMetric} onChange={onRankMetricChange} />
        <RankingChart items={rankItems} formatValue={rankFormatValue} emptyLabel={rankEmptyLabel} />
      </Card>
    </>
  );
}

type BreakdownSectionProps = {
  categorySlices: CategorySlice[];
  categoryByMonth: MonthlyCategoryBucket[];
  paymentMix: PaymentMixItem[];
};

function BreakdownSection({ categorySlices, categoryByMonth, paymentMix }: BreakdownSectionProps) {
  return (
    <>
      <Text style={[styles.sectionTitle, { color: theme.text }]}>Category mix</Text>
      <Card style={styles.chartCard}>
        <CategoryDonutChart items={categorySlices} totalLabel="Units sold" />
      </Card>

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Revenue by category</Text>
      <Card style={styles.chartCard}>
        <CategoryOverTimeChart months={categoryByMonth} />
      </Card>

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Payment mix</Text>
      <Card style={styles.chartCard}>
        <PaymentMixChart items={paymentMix} />
      </Card>
    </>
  );
}

type ActivitySectionProps = {
  lowStock: Product[];
  recentSales: Sale[];
};

function ActivitySection({ lowStock, recentSales }: ActivitySectionProps) {
  return (
    <>
      <Text style={[styles.sectionTitle, { color: theme.text }]}>Inventory alerts</Text>
      {lowStock.length === 0 ? (
        <Text style={[styles.empty, { color: theme.textSecondary }]}>Everything is well stocked.</Text>
      ) : (
        <Card style={styles.list}>
          {lowStock.map((product) => <ProductTile key={product.id} product={product} />)}
        </Card>
      )}

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Recent transactions</Text>
      {recentSales.length === 0 ? (
        <Text style={[styles.empty, { color: theme.textSecondary }]}>No transactions yet.</Text>
      ) : (
        <Card style={styles.list}>
          {recentSales.map((sale) => (
            <View key={sale.id} style={[styles.topRow, { borderBottomColor: theme.border }]}>
              <Text style={[styles.topName, { color: theme.text }]} numberOfLines={1}>{sale.items?.map((item) => item.productName).join(', ')}</Text>
              <Text style={[styles.topMeta, { color: theme.textSecondary }]}>{formatCents(sale.totalCents)}</Text>
            </View>
          ))}
        </Card>
      )}
    </>
  );
}
```

- [ ] **Step 2: Replace the tail of `DashboardScreen`'s return statement with calls to the new components**

In the existing return statement, replace everything from `<Text style={[styles.sectionTitle, { color: theme.text }]}>Overview</Text>` down through the closing `)}` of the "Recent transactions" block (lines 193–243 of the original file) with:

```tsx
        <TrendsSection
          trendMetric={trendMetric}
          onTrendMetricChange={setTrendMetric}
          onDateRangeChange={setDateRange}
          trendData={trendData}
          trendFormatValue={trendFormatValue}
          rankMetric={rankMetric}
          onRankMetricChange={setRankMetric}
          insight={insight}
          rankItems={rankItems}
          rankFormatValue={rankFormatValue}
          rankEmptyLabel={rankEmptyLabel}
        />
        <BreakdownSection categorySlices={categorySlices} categoryByMonth={categoryByMonth} paymentMix={paymentMix} />
        <ActivitySection lowStock={lowStock} recentSales={recentSales} />
```

The header title, divider, stat-tile row, and revenue-goal card above this (lines 175–191) stay exactly as they are for this task — no layout change yet, just extraction.

- [ ] **Step 3: Verify no TypeScript errors**

Run: `npx tsc --noEmit`
Expected: no new errors introduced by this file.

- [ ] **Step 4: Verify unchanged behavior in the simulator**

Use the `run` skill to launch the app, sign in as an owner, and open the Dashboard tab. Confirm the screen looks and scrolls exactly as before: header, stat tiles, revenue goal (if configured), Overview, Rankings, Category mix, Revenue by category, Payment mix, Inventory alerts, Recent transactions — same order, same data, still one continuous scroll.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(owner)/(tabs)/dashboard.tsx"
git commit -m "refactor: extract dashboard sections into components"
```

---

### Task 2: Add tabbed switcher (Trends / Breakdown / Activity)

**Files:**
- Modify: `src/app/(owner)/(tabs)/dashboard.tsx`

**Interfaces:**
- Consumes: `TrendsSection`, `BreakdownSection`, `ActivitySection` from Task 1 (exact prop names as defined there).

- [ ] **Step 1: Add the section type and options constant**

Add next to `RANK_OPTIONS` (after line 44 of the original file):

```tsx
type DashboardSection = 'trends' | 'breakdown' | 'activity';

const SECTION_OPTIONS: { key: DashboardSection; label: string }[] = [
  { key: 'trends', label: 'Trends' },
  { key: 'breakdown', label: 'Breakdown' },
  { key: 'activity', label: 'Activity' },
];
```

- [ ] **Step 2: Add the `section` state**

Inside `DashboardScreen`, next to the other `useState` calls (after `const [rankMetric, setRankMetric] = useState<RankMetric>('products');`):

```tsx
  const [section, setSection] = useState<DashboardSection>('trends');
```

- [ ] **Step 3: Restructure the return statement — pin the header, add the nav, make tab content conditional**

Replace the full return statement (from Task 1's version) with:

```tsx
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: theme.surface }]}>
      <View style={styles.headerFixed}>
        <Text style={[styles.greeting, { color: theme.text }]}>Dashboard</Text>
        <View style={[styles.headerDivider, { backgroundColor: theme.border }]} />

        <View style={styles.metricRow}>
          <StatTile value={formatCents(todayTotalCents)} label="Today's sales" delta={salesDelta} sparkline={dailyMetrics.map((d) => d.totalCents)} />
          <StatTile value={String(todayOrders)} label="Orders" delta={ordersDelta} />
          <StatTile value={String(lowStock.length)} label="Low stock" tone={lowStock.length > 0 ? 'warning' : 'default'} />
        </View>

        {shop?.monthlyRevenueGoalCents ? (
          <>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Revenue goal this month</Text>
            <Card style={styles.chartCard}>
              <GoalMeter valueCents={monthToDateCents} goalCents={shop.monthlyRevenueGoalCents} />
            </Card>
          </>
        ) : null}
      </View>

      <View style={styles.sectionNav}>
        <SegmentedControl options={SECTION_OPTIONS} value={section} onChange={setSection} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {section === 'trends' && (
          <TrendsSection
            trendMetric={trendMetric}
            onTrendMetricChange={setTrendMetric}
            onDateRangeChange={setDateRange}
            trendData={trendData}
            trendFormatValue={trendFormatValue}
            rankMetric={rankMetric}
            onRankMetricChange={setRankMetric}
            insight={insight}
            rankItems={rankItems}
            rankFormatValue={rankFormatValue}
            rankEmptyLabel={rankEmptyLabel}
          />
        )}
        {section === 'breakdown' && (
          <BreakdownSection categorySlices={categorySlices} categoryByMonth={categoryByMonth} paymentMix={paymentMix} />
        )}
        {section === 'activity' && <ActivitySection lowStock={lowStock} recentSales={recentSales} />}
      </ScrollView>
    </SafeAreaView>
  );
```

- [ ] **Step 4: Add the two new styles**

In the `styles = StyleSheet.create({...})` block, add these two entries (e.g., right after `safeArea`):

```tsx
  headerFixed: { paddingHorizontal: 24, paddingTop: 24 },
  sectionNav: { paddingHorizontal: 24, paddingTop: 16 },
```

- [ ] **Step 5: Verify no TypeScript errors**

Run: `npx tsc --noEmit`
Expected: no new errors introduced by this file.

- [ ] **Step 6: Verify in the simulator**

Use the `run` skill to launch the app and open the Dashboard tab. Confirm:
- The title, stat tiles, and revenue goal card stay fixed at the top and do not scroll away.
- A segmented control with "Trends", "Breakdown", "Activity" appears below them, defaulting to "Trends".
- Tapping each tab swaps the content below to the correct group (Trends: Overview + Rankings; Breakdown: Category mix + Revenue by category + Payment mix; Activity: Inventory alerts + Recent transactions).
- The in-tab toggles still work: switching the Overview metric (Revenue/Orders/Discounts), changing the date range, and switching the Rankings metric (Products/Units/Cashiers) all update their charts as before.
- Low-stock and recent-transactions content in the Activity tab matches what was shown before this change.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(owner)/(tabs)/dashboard.tsx"
git commit -m "feat: add tabbed sections to dashboard (Trends/Breakdown/Activity)"
```
