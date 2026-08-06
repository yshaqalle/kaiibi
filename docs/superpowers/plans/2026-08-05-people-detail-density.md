# People Detail Density Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a whole customer or team member readable in the People detail pane without scrolling, at a 900px-tall window.

**Architecture:** Three shared pieces are added — a dense `StatTile` density, a `GlanceStrip` card, and a `DetailColumns` two-column layout — then both People tabs are rewritten to use them. `TwoPaneListDetail` gains an opt-in mode where the wide detail pane is a flex container rather than a `ScrollView`, which is what lets history cards bound themselves to the pane instead of a hardcoded `maxHeight`.

**Tech Stack:** Expo SDK 57, React Native, TypeScript, Jest with the `jest-expo` preset. No new dependencies — `react-test-renderer@19.2.3` is already present transitively.

**Spec:** `docs/superpowers/specs/2026-08-05-people-detail-density-design.md`
**Mockup:** `docs/design/people-density-mockup.html`

## Global Constraints

- **Never hardcode a hex colour.** Every colour comes from `Colors.light` in `src/constants/theme.ts`. People is not yet a converted bento screen in that file's comment, but the two tabs in scope already read `theme.bento*` tokens — follow what the file does, not the comment.
- **`const theme = Colors.light`** at module scope in every file that reads a token. No dark mode.
- **Card radius is `BENTO_RADIUS` (26)** via `Card variant="bento"`. Never write `borderRadius: 26` on a `View`.
- **Do not change `StatTile`'s default rendering.** Dashboard and Accounting render the same component.
- **Do not touch** the Schedule tab, the Me tab, Dashboard, Accounting, Inventory, or POS.
- **Do not fix the Notes field's save behaviour.** It is a known separate defect, documented in the spec's "Not in this change".
- Expo docs, when needed, are the versioned ones at https://docs.expo.dev/versions/v57.0.0/ (per `AGENTS.md`).
- Commit after every task. Do not push.

---

### Task 1: Two-column breakpoint

The pure function the detail layout switches on. Lives beside `TABLET_BREAKPOINT` because it is the same kind of fact, and a screen should never disagree with the chrome around it.

**Files:**
- Modify: `src/constants/layout.ts`
- Test: `src/constants/__tests__/layout.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DETAIL_TWO_COLUMN_BREAKPOINT: number` — the constant, 1100.
  - `detailColumnsForWidth(width: number): 1 | 2` — 2 at or above the breakpoint, 1 below.

- [ ] **Step 1: Write the failing test**

Create `src/constants/__tests__/layout.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx jest src/constants/__tests__/layout.test.ts
```

Expected: FAIL. The message will name the missing export — something like `TypeError: (0 , _layout.detailColumnsForWidth) is not a function`.

This run also proves jest picks up a test outside `src/lib/__tests__/`, which is where every other test in this repo lives. `jest.config.js` only ignores `node_modules`, `.expo` and `.claude`, so it should. If the run reports "no tests found", stop and move the test to `src/lib/__tests__/layout.test.ts`, adjusting nothing else.

- [ ] **Step 3: Add the constant and the function**

Append to `src/constants/layout.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx jest src/constants/__tests__/layout.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/constants/layout.ts src/constants/__tests__/layout.test.ts
git commit -m "feat: add two-column breakpoint for the People detail pane"
```

---

### Task 2: A dense `StatTile`

The strip's height comes from here. A new prop, not a change to the defaults — Dashboard and Accounting render this component and must not move.

**Files:**
- Modify: `src/components/stat-tile.tsx`
- Test: `src/components/__tests__/stat-tile.test.tsx` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `StatTile` gains `density?: 'default' | 'dense'`, defaulting to `'default'`. Orthogonal to the existing `variant?: 'default' | 'bento'` — the two combine freely.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/stat-tile.test.tsx`:

```tsx
import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { StatTile } from '@/components/stat-tile';

// Every string rendered anywhere in the tree, flattened. Enough to assert
// "this text survived" without reaching for a query library the repo does not
// have installed.
function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function renderTile(density: 'default' | 'dense') {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(
      <StatTile variant="bento" density={density} value="3" label="In today" hint="clocked in at some point" />
    );
  });
  return textsIn(tree!.toJSON() as ReactTestRendererJSON);
}

// This is the regression that guards the whole design decision. The dense
// tile exists so the glance strip can shrink WITHOUT dropping the hints --
// "in today: 3" with no "clocked in at some point" reads as a count of who is
// on the floor right now, which it is not. If a later tightening pass deletes
// the hint to win height, this fails.
describe('StatTile density', () => {
  it('renders the hint at the default density', () => {
    expect(renderTile('default')).toContain('clocked in at some point');
  });

  it('still renders the hint when dense', () => {
    expect(renderTile('dense')).toContain('clocked in at some point');
  });

  it('keeps the label and value when dense', () => {
    const texts = renderTile('dense');
    expect(texts).toContain('IN TODAY');
    expect(texts).toContain('3');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx jest src/components/__tests__/stat-tile.test.tsx
```

Expected: FAIL — TypeScript will reject the `density` prop, which surfaces as a Babel/TS error or a failing assertion depending on how `jest-expo` handles it. Either way it must not pass.

If instead you see an `act(...)` warning that fails the run, that is environmental — the `act` import is already in place; report it and continue only if the assertions themselves pass afterwards.

- [ ] **Step 3: Add the `density` prop**

In `src/components/stat-tile.tsx`, add to the props type, immediately after the existing `variant` prop and its comment block:

```tsx
  /**
   * `dense` trims the tile's padding and figure size for a strip that has to
   * share the window with two scrolling panes below it (People). It changes
   * only the metrics -- the label, the value and the HINT all still render,
   * which is the point: a figure that doesn't say what is in and out of it
   * invites an argument, and that is exactly as true in a shorter tile.
   */
  density?: 'default' | 'dense';
```

Add it to the destructured parameters, after `variant = 'default'`:

```tsx
  density = 'default',
```

Add a local flag beside the existing `bento` one:

```tsx
  const bento = variant === 'bento';
  const dense = density === 'dense';
```

Then apply it at the four places that carry height. Replace the `Card`, label, value and hint elements' style arrays:

```tsx
    <Card variant={bento ? 'bento' : 'default'} style={[styles.tile, bento && styles.tileBento, dense && styles.tileDense]}>
```

```tsx
      <View style={[styles.valueRow, dense && styles.valueRowDense]}>
```

```tsx
        <Text
          style={[styles.value, dense && styles.valueDense, bento ? TONE_BENTO[tone] : TONE[tone]]}
```

```tsx
      {hint ? <Text style={[styles.hint, bento && styles.hintBento, dense && styles.hintDense]} numberOfLines={2}>{hint}</Text> : null}
```

Order matters on the value: `valueDense` must come before the tone entry so a tone never overrides the size, and after `styles.value` so it wins on `fontSize`.

- [ ] **Step 4: Add the dense styles**

In the `styles` StyleSheet at the bottom of the same file, add each dense entry directly after the rule it overrides:

```tsx
  // minWidth is deliberately NOT reduced: it is what makes the surrounding
  // flexWrap row actually wrap on a phone (see the comment on `tile`), and a
  // denser tile still needs a readable floor.
  tileDense: { minHeight: 74, padding: 9 },
```

```tsx
  valueRowDense: { marginTop: 5 },
```

```tsx
  valueDense: { fontSize: 20 },
```

```tsx
  hintDense: { fontSize: 10.5, marginTop: 2, lineHeight: 14 },
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
npx jest src/components/__tests__/stat-tile.test.tsx
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Confirm nothing else moved**

```bash
npx tsc --noEmit
npx jest
```

Expected: `tsc` clean; the full suite passes. `density` is optional with a default, so every existing `StatTile` call site is unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/components/stat-tile.tsx src/components/__tests__/stat-tile.test.tsx
git commit -m "feat: add a dense density to StatTile"
```

---

### Task 3: The `GlanceStrip` card

Both People tabs render the identical shape — a low card of dense tiles, no card title, with an optional caveat underneath. One component, not two.

**Files:**
- Create: `src/components/ui/glance-strip.tsx`

**Interfaces:**
- Consumes: `StatTile` with `density="dense"` from Task 2 (callers pass the tiles as children).
- Produces:
  ```tsx
  function GlanceStrip(props: {
    children: ReactNode;       // the StatTiles
    caveat?: ReactNode;        // rendered below them, inside the same card
    style?: StyleProp<ViewStyle>;
  }): JSX.Element
  ```

- [ ] **Step 1: Create the component**

Create `src/components/ui/glance-strip.tsx`:

```tsx
import { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Card } from '@/components/card';

// The headline figures at the top of a People tab.
//
// Deliberately NOT a `BentoCard`: this card has no title. "Customers at a
// glance" / "The team at a glance" says nothing the tile labels underneath it
// don't already say, and on a screen where the chrome was eating 40% of the
// window before the panes got a say, a redundant heading is 27px that buys
// nothing.
//
// What it does NOT drop is the per-tile hint. That was the other candidate --
// collapse the four tiles to one inline row of figures -- and it wins more
// height by deleting three of the four qualifications. "In today: 3" without
// "clocked in at some point" reads as a count of who is on the floor now,
// which it is not. The height comes out of the detail pane's layout instead
// (see DetailColumns).
export function GlanceStrip({
  children,
  caveat,
  style,
}: {
  children: ReactNode;
  /** Rendered below the tiles, inside the card -- it explains them. */
  caveat?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Card variant="bento" style={[styles.card, style]}>
      <View style={styles.row}>{children}</View>
      {caveat}
    </Card>
  );
}

const styles = StyleSheet.create({
  // 12, not BentoCard's 18: the tiles carry their own padding and the card is
  // only a ground for them.
  card: { padding: 12 },
  // flexWrap + the tiles' own minWidth is what drops them to a second line on
  // a phone rather than crushing four onto one.
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
});
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean. Nothing imports it yet — that happens in Tasks 6 and 7.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/glance-strip.tsx
git commit -m "feat: add GlanceStrip, the People tabs' dense figure strip"
```

---

### Task 4: Let the wide detail pane fill instead of scroll

`TwoPaneListDetail`'s wide branch wraps `detail` in a `ScrollView` with `contentContainerStyle: { flexGrow: 1 }`. A flex child inside a `ScrollView` has unbounded height by definition, so nothing inside it can flex against the pane — which is what Task 6 and Task 7 need for the history cards to bound themselves.

**Files:**
- Modify: `src/components/two-pane-list-detail.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `TwoPaneListDetail` gains `detailFills?: boolean`, defaulting to `false` (today's behaviour). When `true` **and** not `compact`, the detail pane is a plain flex `View` and its content owns its own scrolling.

- [ ] **Step 1: Add the prop**

In `src/components/two-pane-list-detail.tsx`, add to the props type after `detailTitle`:

```tsx
  /**
   * Wide layout only. `true` makes the detail pane a flex container rather
   * than a ScrollView, so a detail that lays itself out in columns can bound
   * its own scrolling regions to the pane's height. The caller becomes
   * responsible for ALL scrolling inside the detail -- content taller than
   * the pane is clipped, not scrolled.
   *
   * Default `false` keeps the original behaviour for any caller whose detail
   * is a plain stack.
   */
  detailFills?: boolean;
```

Add it to the destructured parameters after `detailTitle`:

```tsx
  detailFills = false,
```

- [ ] **Step 2: Branch the wide detail pane**

Replace the wide-layout `return` at the bottom of the component:

```tsx
  return (
    <View style={styles.split}>
      <View style={styles.listPane}>
        <ScrollView style={styles.paneScroll} contentContainerStyle={styles.paneContent} showsVerticalScrollIndicator={false}>
          {list}
        </ScrollView>
      </View>
      {/* The detail either scrolls as one block (the original shape) or fills
          the pane and lets its own cards scroll internally. The second is what
          keeps a bounded history list bounded: a flex child of a ScrollView
          has no height to flex against. */}
      <View style={styles.detailPane}>
        {detailFills ? (
          <View style={styles.paneFill}>{detail}</View>
        ) : (
          <ScrollView style={styles.paneScroll} contentContainerStyle={styles.paneContent} showsVerticalScrollIndicator={false}>
            {detail}
          </ScrollView>
        )}
      </View>
    </View>
  );
```

- [ ] **Step 3: Add the style**

In the `styles` StyleSheet, directly after `paneContent`:

```tsx
  // minHeight: 0 is load-bearing on web -- without it a flex child refuses to
  // shrink below its content size and the inner scrollers never engage.
  paneFill: { flex: 1, minHeight: 0 },
```

- [ ] **Step 4: Typecheck and confirm the existing callers are unaffected**

```bash
npx tsc --noEmit
grep -rn "TwoPaneListDetail" src --include=*.tsx
```

Expected: `tsc` clean. The grep shows the component's own file and exactly two call sites, both in `src/app/(admin)/(tabs)/people.tsx`. Neither passes `detailFills` yet, so both keep today's behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/components/two-pane-list-detail.tsx
git commit -m "feat: add detailFills to TwoPaneListDetail for a flexing detail pane"
```

---

### Task 5: The `DetailColumns` layout

The two-column detail, and the hook the tabs use to decide whether their history cards should flex.

Note it does **not** use `BentoGrid`/`BentoCell`: those set `alignItems: 'flex-start'` and size cells by percentage width, so columns do not stretch to a shared height. This layout needs both columns to fill the pane so the right one can bound a scrolling card.

**Files:**
- Create: `src/components/ui/detail-columns.tsx`

**Interfaces:**
- Consumes: `detailColumnsForWidth` from Task 1.
- Produces:
  - `useDetailColumns(): 1 | 2` — the live column count for the current window.
  - `DetailColumns(props: { left: ReactNode; right: ReactNode }): JSX.Element`
  - `detailCardStyles` — a `StyleSheet` with `fill` and `fillBody`, for cards that should flex and scroll inside a column.

- [ ] **Step 1: Create the component**

Create `src/components/ui/detail-columns.tsx`:

```tsx
import { type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { detailColumnsForWidth } from '@/constants/layout';

export function useDetailColumns(): 1 | 2 {
  const { width } = useWindowDimensions();
  return detailColumnsForWidth(width);
}

// The People detail pane's body.
//
// Left is who the person is and what you would change about them; right is
// what they have done. That split is not arbitrary -- it puts every editable
// control in one column, so the eye does not hunt between two for the next
// action.
//
// NOT BentoGrid/BentoCell: those size cells by percentage width and set
// alignItems 'flex-start', so a short column does not stretch to its
// neighbour's height. Here both columns must fill the pane, because the right
// one contains a card that bounds its own scrolling against that height.
export function DetailColumns({ left, right }: { left: ReactNode; right: ReactNode }) {
  const columns = useDetailColumns();

  if (columns === 1) {
    return <View style={styles.stack}>{left}{right}</View>;
  }

  return (
    <View style={styles.row}>
      <View style={styles.column}>{left}</View>
      <View style={styles.column}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  // One column: a plain stack. The caller is inside a ScrollView at this
  // width (TwoPaneListDetail's detailFills is false below the two-column
  // breakpoint), so nothing here may flex.
  stack: { gap: 14 },
  row: { flexDirection: 'row', gap: 14, flex: 1, minHeight: 0, alignItems: 'stretch' },
  // minWidth 0 lets a long product name shrink the column rather than
  // widening it past its half of the pane.
  column: { flex: 1, minWidth: 0, gap: 14 },
});

/**
 * For a card that should take the remaining height of its column and scroll
 * its own body -- a purchase ledger, a shift list. Spread onto a `BentoCard`
 * as `style={detailCardStyles.fill}` and `bodyStyle={detailCardStyles.fillBody}`,
 * ONLY when `useDetailColumns()` is 2. At one column the card is inside a
 * ScrollView and must size to its content instead.
 */
export const detailCardStyles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  fillBody: { flex: 1, minHeight: 0 },
});
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/detail-columns.tsx
git commit -m "feat: add DetailColumns, the two-column People detail layout"
```

---

### Task 6: Rebuild the Customers tab

**Files:**
- Modify: `src/app/(admin)/(tabs)/people.tsx` — `CustomersTab` (from ~line 213) and `CustomerDetailPane` (from ~line 429)

**Interfaces:**
- Consumes: `GlanceStrip` (Task 3), `TwoPaneListDetail`'s `detailFills` (Task 4), `DetailColumns` / `useDetailColumns` / `detailCardStyles` (Task 5), `StatTile`'s `density` (Task 2).
- Produces: nothing other tasks depend on. Task 7 mirrors this shape on Team but shares no code with it beyond the components above.

- [ ] **Step 1: Add the imports**

At the top of `src/app/(admin)/(tabs)/people.tsx`, alongside the existing component imports:

```tsx
import { DetailColumns, detailCardStyles, useDetailColumns } from '@/components/ui/detail-columns';
import { GlanceStrip } from '@/components/ui/glance-strip';
```

- [ ] **Step 2: Replace the glance strip**

In `CustomersTab`'s `return`, replace the `BentoCard title="Customers at a glance"` block (currently at lines ~365-375, including the comment above it) with:

```tsx
      {/* One low card, not a grid: four figures read as a single glance, and
          splitting them into four cells would put three gutters through one
          thought. No title -- the tile labels already say what these are, and
          the heading was 27px this screen could not spare. */}
      <GlanceStrip style={tabStyles.strip}>
        <StatTile variant="bento" density="dense" value={String(customers.length)} label="Customers" hint={`${segmentCounts.new} joined in the last 30 days`} />
        <StatTile variant="bento" density="dense" value={String(segmentCounts.vip)} label="VIPs" hint="tagged vip" />
        <StatTile variant="bento" density="dense" value={String(segmentCounts['at-risk'])} label="At risk" hint="tagged at risk" />
        <StatTile variant="bento" density="dense" value={formatCompactCents(lifetimeSpendCents)} label="Lifetime spend" hint="across every store" />
      </GlanceStrip>
```

- [ ] **Step 3: Put search and the chips on one row**

Replace the `View style={tabStyles.search}` block and the `ScrollView ... tabStyles.filterScroll` block that follow it with a single row:

```tsx
      <View style={tabStyles.controlRow}>
        <View style={[tabStyles.search, tabStyles.searchInRow]}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search by name, phone, or tag"
            placeholderTextColor={theme.bentoMuted2}
            style={tabStyles.searchInput}
          />
        </View>
        {/* Keeps its horizontal scroll: on a narrow window five chips will not
            fit beside the field, and wrapping them would put the row's height
            back where it started. */}
        <ScrollView horizontal style={tabStyles.filterScroll} showsHorizontalScrollIndicator={false} contentContainerStyle={tabStyles.chips}>
          <CategoryChip variant="bento" label={`All · ${customers.length}`} active={segment === 'all'} onPress={() => setSegment('all')} />
          {(Object.keys(CUSTOMER_SEGMENT_LABELS) as CustomerSegment[]).map((key) => (
            <CategoryChip variant="bento" key={key} label={`${CUSTOMER_SEGMENT_LABELS[key]} · ${segmentCounts[key]}`} active={segment === key} onPress={() => setSegment(key)} />
          ))}
        </ScrollView>
      </View>
```

- [ ] **Step 4: Add the row styles**

In `tabStyles`, add after the existing `filterScroll` entry:

```tsx
  // Search and the filter chips share one line. Two stacked 44px bands plus
  // their margins was 110px of chrome for one job.
  controlRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  searchInRow: { flex: 1, marginBottom: 0 },
```

Then change `filterScroll` to drop its own bottom margin, since the row owns it now:

```tsx
  filterScroll: { flexGrow: 0, flexShrink: 0, height: 44 },
```

- [ ] **Step 5: Tell the pane to fill**

In `CustomersTab`, add the hook near the other hooks at the top of the function body (after `const canEdit = can('customers.edit');`):

```tsx
  const detailColumns = useDetailColumns();
```

Then on the `TwoPaneListDetail` element, add the prop:

```tsx
      <TwoPaneListDetail
        compact={compact}
        list={list}
        detail={detail}
        detailOpen={selected !== null}
        onCloseDetail={() => setSelectedId(null)}
        detailTitle="Customer"
        detailFills={detailColumns === 2}
      />
```

- [ ] **Step 6: Collapse the detail identity to one row**

In `CustomerDetailPane`, replace the first `BentoCard` (the block from `<BentoCard>` through its closing tag, currently ~lines 476-504) with:

```tsx
      <BentoCard>
        {/* Name, badge, phone and the actions on ONE line. Stacked, these were
            four bands and ~64px of margin before the first figure. The row
            wraps on a long name rather than clipping, which spends the height
            back only in the case that needs it. */}
        <View style={tabStyles.detHeadRow}>
          <View style={tabStyles.detIdent}>
            <Text style={tabStyles.detName}>
              {customer.firstName} {customer.lastName ?? ''}
            </Text>
            <Badge variant="bento" label={CUSTOMER_SEGMENT_LABELS[segment]} tone={segment === 'vip' ? 'danger' : 'default'} />
            {customer.phone && <Text style={tabStyles.detMeta}>{customer.phone}</Text>}
          </View>
          <View style={tabStyles.detActions}>
            <WhatsAppButton phone={customer.phone} name={customer.firstName} variant="pill" />
            {canEdit && (
              <Pressable onPress={onEdit} style={tabStyles.actionButton}>
                <Text style={tabStyles.actionButtonText}>Edit</Text>
              </Pressable>
            )}
            {canEdit && (
              <Pressable onPress={toggleVip} style={tabStyles.actionButton}>
                <Text style={tabStyles.actionButtonText}>{isVip ? 'Remove VIP' : 'Mark VIP'}</Text>
              </Pressable>
            )}
          </View>
        </View>
        <View style={tabStyles.metricRow}>
          <StatTile variant="bento" value={stats ? formatCents(stats.totalSpentCents) : '—'} label="Lifetime spend" />
          <StatTile variant="bento" value={stats ? String(stats.visitCount) : '—'} label="Orders" />
          <StatTile variant="bento" value={stats?.lastPurchaseAt ? new Date(stats.lastPurchaseAt).toLocaleDateString() : '—'} label="Last purchase" />
          {loyaltyOn && <StatTile variant="bento" value={customer.pointsBalance.toLocaleString()} label="Points" />}
        </View>
        {error && <Text style={tabStyles.errorText}>{error}</Text>}
      </BentoCard>
```

Note the detail tiles stay at the **default** density. Only the glance strip goes dense — these four have a whole column to sit in.

- [ ] **Step 7: Add the identity-row styles**

In `tabStyles`, after the existing `actions` entry:

```tsx
  detHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 },
  // minWidth 0 so a long name shrinks rather than pushing the buttons off.
  detIdent: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 1, minWidth: 0 },
  detActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
```

- [ ] **Step 8: Split the detail body into two columns**

The code below reads a local `fills` flag that Step 9 declares. TypeScript will
flag it as undefined between these two steps — that is expected; do not
"fix" it here, and do not run the app until Step 9 is done.

Replace everything in `CustomerDetailPane`'s return after that first `BentoCard` — the Notes card, the "Usually shops at" card, and the `BentoGrid` holding the two histories — with:

```tsx
      <DetailColumns
        left={
          <>
            <BentoCard title="Notes">
              <NotesField key={customer.id} value={customer.notes} onSave={async (notes) => { await updateCustomer(customer.id, { notes }); await onChanged(); }} />
            </BentoCard>

            {/* Where they actually shop, by visit count. Hidden for a single-store
                business (nothing to distinguish) and when the history is tied or
                empty — naming a store on a 2-2 split would present a coin flip as a
                fact. See usualStore in lib/customer-segments.ts. */}
            {usual && (
              <BentoCard title="Usually shops at">
                <Text style={tabStyles.usualStore}>{storeNameOf(usual.locationId) ?? 'Unknown store'}</Text>
                <Text style={tabStyles.usualStoreMeta}>{`${usual.visits} of ${usual.totalVisits} visits`}</Text>
              </BentoCard>
            )}
          </>
        }
        right={
          <>
            <BentoCard
              title="Purchase history"
              scope={stats ? `${stats.visitCount} orders` : undefined}
              style={fills ? detailCardStyles.fill : undefined}
              bodyStyle={fills ? detailCardStyles.fillBody : undefined}
            >
              {purchases.length === 0 ? (
                <Text style={tabStyles.empty}>No purchases yet.</Text>
              ) : (
                <ScrollView showsVerticalScrollIndicator={false}>
                  {purchases.map((p) => (
                    <View key={p.saleItemId} style={tabStyles.histRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={tabStyles.histTitle}>
                          {p.productName}
                          {p.quantity > 1 ? ` ×${p.quantity}` : ''}
                        </Text>
                        <Text style={tabStyles.histMeta}>
                          {new Date(p.createdAt).toLocaleDateString()} · {p.paymentMethod}
                          {storeNameOf(p.locationId) ? ` · ${storeNameOf(p.locationId)}` : ''}
                        </Text>
                      </View>
                      <Text style={tabStyles.histAmount}>{formatCents(p.lineTotalCents)}</Text>
                    </View>
                  ))}
                </ScrollView>
              )}
            </BentoCard>

            {/* What answers "why is my balance 148" at the counter. The ledger is
                append-only, so a correction shows up as its own row rather than
                quietly changing an old one. */}
            {loyaltyOn && (
              <BentoCard
                title="Points history"
                scope={`${customer.pointsBalance.toLocaleString()} balance`}
                style={fills ? detailCardStyles.fill : undefined}
                bodyStyle={fills ? detailCardStyles.fillBody : undefined}
              >
                {pointsHistory.length === 0 ? (
                  <Text style={tabStyles.empty}>No points activity yet.</Text>
                ) : (
                  <ScrollView showsVerticalScrollIndicator={false}>
                    {pointsHistory.map((entry) => (
                      <View key={entry.id} style={tabStyles.histRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={tabStyles.histTitle}>{POINTS_REASON_LABELS[entry.reason]}</Text>
                          <Text style={tabStyles.histMeta}>
                            {new Date(entry.createdAt).toLocaleDateString()}
                            {entry.note ? ` · ${entry.note}` : ''}
                          </Text>
                        </View>
                        <Text style={[tabStyles.histAmount, entry.deltaPoints < 0 && tabStyles.histAmountNegative]}>
                          {entry.deltaPoints > 0 ? '+' : ''}
                          {entry.deltaPoints.toLocaleString()}
                        </Text>
                      </View>
                    ))}
                    {pointsHistory.length > 0 && !ledgerNote.dismissed && (
                      <Caveat tone="context" onDismiss={ledgerNote.dismiss}>
                        The ledger is append-only — a correction arrives as its own row rather than quietly changing an old
                        one, which is what answers &quot;why is my balance what it is&quot; at the counter.
                      </Caveat>
                    )}
                  </ScrollView>
                )}
              </BentoCard>
            )}
          </>
        }
      />
```

- [ ] **Step 9: Add the `fills` flag and the stack style**

At the top of `CustomerDetailPane`'s function body, beside the other hooks:

```tsx
  // Only at two columns does a card have a bounded height to flex against. At
  // one column the detail is inside TwoPaneListDetail's ScrollView, where a
  // flex child would collapse to nothing.
  const fills = useDetailColumns() === 2;
```

Then change the wrapper `View` at the top of the return so the two-column layout can fill the pane:

```tsx
    <View style={[tabStyles.detailStack, fills && tabStyles.detailStackFills]}>
```

And add to `tabStyles`, after `detailStack`:

```tsx
  detailStackFills: { flex: 1, minHeight: 0 },
```

- [ ] **Step 10: Remove the now-unused imports**

`BentoGrid` and `BentoCell` may no longer be used by `CustomersTab`. Do **not** delete them from the import yet — Task 7 removes Team's usage, and only then can you tell. Run:

```bash
npx tsc --noEmit
npm run lint
```

Expected: `tsc` clean. Lint may warn about unused imports; leave them until Task 7's cleanup step.

- [ ] **Step 11: Verify in the running app**

```bash
npm run web
```

Check, at a browser window ~1440px wide and ~900px tall:
1. The glance strip is one low card with four tiles, no "Customers at a glance" heading, and all four hints readable.
2. Search and the five chips are on one line.
3. Selecting a customer shows name, badge, phone and all three buttons on one line.
4. Notes and "Usually shops at" are in the left column; both histories in the right.
5. Nothing below the two-column breakpoint is broken: narrow the window to ~1000px and confirm the detail stacks to one column and scrolls as before; narrow past 820px and confirm the detail still opens as a bottom sheet.

- [ ] **Step 12: Commit**

```bash
git add "src/app/(admin)/(tabs)/people.tsx"
git commit -m "feat: two-column Customers detail with a dense glance strip"
```

---

### Task 7: Rebuild the Team tab

The same two moves, plus moving the search out of the list pane.

**Files:**
- Modify: `src/app/(admin)/(tabs)/people.tsx` — `TeamManagementTab` (from ~line 608) and `TeamDetailPane` (from ~line 859)

**Interfaces:**
- Consumes: everything Task 6 consumes. The imports are already in place from Task 6, Step 1. It also reuses the `tabStyles` entries Task 6 added — `detHeadRow`, `detIdent`, `detActions`, `detailStackFills` — which is why this task must run after it.
- Produces: nothing.

- [ ] **Step 1: Replace Team's glance strip**

In `TeamManagementTab`'s `return`, replace the `BentoCard title="The team at a glance"` block (currently ~lines 813-841) with:

```tsx
      <GlanceStrip
        style={tabStyles.strip}
        caveat={
          !canViewHours && !noHoursNote.dismissed ? (
            <Caveat tone="partial" onDismiss={noHoursNote.dismiss}>
              Hours are hidden — you don&apos;t have timesheet access, so the two figures that come from clock-ins are
              left blank rather than shown as zero.
            </Caveat>
          ) : undefined
        }
      >
        <StatTile
          variant="bento"
          density="dense"
          value={String(staff.length)}
          label="On the team"
          hint={disabledCount > 0 ? `${staff.length - disabledCount} active · ${disabledCount} disabled` : 'all active'}
        />
        <StatTile
          variant="bento"
          density="dense"
          value={canViewHours ? String(activeTodayCount) : '—'}
          label="In today"
          hint={canViewHours ? 'clocked in at some point' : 'needs timesheet access'}
        />
        <StatTile variant="bento" density="dense" value={String(onLeaveMemberIds.size)} label="On leave" hint="approved time off" />
        <StatTile
          variant="bento"
          density="dense"
          value={canViewHours ? `${hoursThisPeriod.toFixed(0)}h` : '—'}
          label="Hours this period"
          hint={canViewHours ? 'since the 1st' : 'needs timesheet access'}
        />
      </GlanceStrip>
```

- [ ] **Step 2: Move the search out of the list pane**

In `TeamManagementTab`, delete the `View style={tabStyles.search}` block from the top of the `list` node (currently ~lines 747-755), leaving `list` starting with the error text and `TimeOffRequestsPanel`:

```tsx
  const list = (
    <>
      {error && <Text style={tabStyles.errorText}>{error}</Text>}
      {canApproveTimeOff && <TimeOffRequestsPanel requests={timeOff} staff={staff} onChange={reload} />}
```

Then add the search above `TwoPaneListDetail` in the `return`, directly after the `GlanceStrip`:

```tsx
      {/* Above the panes, not inside the list, so it does not slide off the top
          of a long roster. Matches Customers. TimeOffRequestsPanel stays in the
          pane -- it is a queue you work through, not a control you reach for. */}
      <View style={tabStyles.search}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search by name, role, or phone"
          placeholderTextColor={theme.bentoMuted2}
          style={tabStyles.searchInput}
        />
      </View>
```

- [ ] **Step 3: Tell Team's pane to fill**

Add the hook near the top of `TeamManagementTab`'s body, beside the other hooks:

```tsx
  const detailColumns = useDetailColumns();
```

And on its `TwoPaneListDetail`:

```tsx
        detailFills={detailColumns === 2}
```

- [ ] **Step 4: Collapse Team's detail identity to one row**

In `TeamDetailPane`, replace the `detHead` / `detMeta` / `actions` blocks (currently ~lines 927-948) with:

```tsx
        <View style={tabStyles.detHeadRow}>
          <View style={tabStyles.detIdent}>
            <Text style={tabStyles.detName}>{member.fullName ?? member.email ?? 'Staff member'}</Text>
            <Badge variant="bento" label={!member.active ? 'Disabled' : onLeave ? 'On leave' : 'Active'} tone={!member.active ? 'default' : onLeave ? 'warning' : 'success'} />
            <Text style={tabStyles.detMeta}>
              {member.roleName}
              {memberStores ? ` · ${memberStores}` : ''}
              {member.phone ? ` · ${member.phone}` : ''}
              {member.hireDate ? ` · joined ${new Date(member.hireDate).toLocaleDateString()}` : ''}
            </Text>
          </View>
          {/* Messaging isn't editing: a scheduler who can see the roster but not
              change it still needs to reach the person, so the WhatsApp button is
              outside the canManageRoster gate. */}
          <View style={tabStyles.detActions}>
            <WhatsAppButton phone={member.phone} name={member.fullName ?? 'this person'} variant="pill" />
            {canManageRoster && (
              <Pressable onPress={() => setEditingMember(true)} style={tabStyles.actionButton}>
                <Text style={tabStyles.actionButtonText}>Edit member</Text>
              </Pressable>
            )}
          </View>
        </View>
```

The `metricRow` of three tiles and the `activeLeaveRequest` `Caveat` below it stay exactly as they are.

- [ ] **Step 5: Split Team's detail into two columns**

As in Task 6, the code below reads a `fills` flag that the next step declares.
TypeScript will flag it until Step 6 lands.

Replace the `BentoGrid` holding Payroll and Access & permissions, and the "Recent shifts" `BentoCard` below it (currently ~lines 970-1032), with:

```tsx
      <DetailColumns
        left={
          <>
            <BentoCard
              title="Payroll"
              actions={
                canManagePayroll && !canManageRoster ? (
                  <Pressable onPress={() => setEditingPay(true)} style={tabStyles.actionButton}>
                    <Text style={tabStyles.actionButtonText}>Edit</Text>
                  </Pressable>
                ) : undefined
              }
            >
              <Text style={tabStyles.payrollValue}>
                {!canManagePayroll
                  ? 'Hidden'
                  : member.payType == null || member.payRateCents == null
                    ? 'Not set'
                    : formatPayRateLong(member.payType, member.payRateCents)}
              </Text>
              {!canManagePayroll && !noPayrollNote.dismissed && (
                <Caveat tone="partial" onDismiss={noPayrollNote.dismiss}>
                  You don&apos;t have payroll access, so this member&apos;s rate is hidden.
                </Caveat>
              )}
            </BentoCard>

            <BentoCard title="Access &amp; permissions">
              <View style={tabStyles.permGrid}>
                {PERMISSION_GROUPS.map((group) => {
                  const granted = groupHasAny(permissions, group);
                  return (
                    <View key={group.label} style={tabStyles.permTile}>
                      <View style={[tabStyles.permIcon, granted ? tabStyles.permIconOn : tabStyles.permIconOff]}>
                        <Text style={tabStyles.permIconText}>{granted ? '✓' : '🔒'}</Text>
                      </View>
                      <Text style={tabStyles.permLabel}>{group.label}</Text>
                    </View>
                  );
                })}
              </View>
            </BentoCard>
          </>
        }
        right={
          canViewHours ? (
            <BentoCard
              title="Recent shifts"
              scope="This period"
              style={fills ? detailCardStyles.fill : undefined}
              bodyStyle={fills ? detailCardStyles.fillBody : undefined}
            >
              {entries.length === 0 ? (
                <Text style={tabStyles.empty}>No shifts logged this period.</Text>
              ) : (
                <ScrollView showsVerticalScrollIndicator={false}>
                  {/* The cap goes: the card bounds itself to the column now, so
                      a long period scrolls inside it instead of being silently
                      truncated at eight. */}
                  {entries.map((e) => (
                    <View key={e.id} style={tabStyles.shiftRow}>
                      <Text style={tabStyles.shiftDate}>
                        {new Date(e.clockIn).toLocaleDateString()} · {new Date(e.clockIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        {e.clockOut ? `–${new Date(e.clockOut).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' (on shift)'}
                      </Text>
                      <Text style={tabStyles.shiftDuration}>{e.clockOut ? `${sumDurationHours([e]).toFixed(1)}h` : '—'}</Text>
                    </View>
                  ))}
                </ScrollView>
              )}
            </BentoCard>
          ) : null
        }
      />
```

Dropping `.slice(0, 8)` is deliberate and is a behaviour change: the cap existed only because an unbounded list grew the page. The card is now bounded by its column, so a full period is reachable by scrolling inside it rather than being cut off with nothing saying so.

- [ ] **Step 6: Add Team's `fills` flag and stack style**

At the top of `TeamDetailPane`'s body, beside the other hooks:

```tsx
  const fills = useDetailColumns() === 2;
```

And change its wrapper `View`:

```tsx
    <View style={[tabStyles.detailStack, fills && tabStyles.detailStackFills]}>
```

- [ ] **Step 7: Clean up now-unused imports**

`BentoGrid` and `BentoCell` are no longer used anywhere in this file. Remove them from the `@/components/ui/bento` import. If that leaves the import empty, delete the line.

```bash
npx tsc --noEmit
npm run lint
```

Expected: both clean.

- [ ] **Step 8: Verify in the running app**

```bash
npm run web
```

At ~1440×900, on the Team tab:
1. The strip is one low card, four dense tiles, no heading, all four hints readable.
2. The search sits above the panes and stays put when the roster scrolls.
3. A selected member shows name, badge, meta line and both buttons on one row.
4. Payroll and Access & permissions are stacked in the left column; Recent shifts fills the right and scrolls inside its own card.
5. Sign in as (or simulate) a member without timesheet access and confirm the strip's caveat still renders inside the card, and that Recent shifts is absent rather than empty.
6. Narrow to ~1000px: one column, scrolls as before. Narrow past 820px: bottom sheet, unchanged.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(admin)/(tabs)/people.tsx"
git commit -m "feat: two-column Team detail, dense strip, search out of the list pane"
```

---

### Task 8: Hide the blurb while someone is selected

"Who shops with you, and what they are worth." orients a reader arriving at the screen. It has nothing to say to a reader already looking at one person.

**Files:**
- Modify: `src/components/accounting/use-header-actions.ts`
- Modify: `src/app/(admin)/(tabs)/people.tsx` — the `PeopleScreen` shell (from ~line 130), `CustomersTab`, `TeamManagementTab`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DetailSelectionSetter = (selected: boolean) => void`
  - `useDetailSelection(setSelected: DetailSelectionSetter, selected: boolean): void` — publishes a tab's selection state upward, clearing on unmount.

- [ ] **Step 1: Add the hook**

Append to `src/components/accounting/use-header-actions.ts`:

```ts
export type DetailSelectionSetter = (selected: boolean) => void;

// Travels upward for the same reason the header actions do: the shell renders
// the title block before the tab that knows whether anything is selected.
//
// Only the boolean travels, not the id. The shell has no business knowing
// WHICH person is open -- it only decides whether the screen's blurb still has
// a job.
export function useDetailSelection(setSelected: DetailSelectionSetter, selected: boolean): void {
  useEffect(() => {
    setSelected(selected);
    // Cleared on unmount so a tab switch never leaves the blurb hidden.
    return () => setSelected(false);
  }, [setSelected, selected]);
}
```

- [ ] **Step 2: Hold the state in the shell**

In `PeopleScreen`, beside `const [headerActions, setHeaderActions] = useState<ReactNode>(null);`:

```tsx
  const [detailSelected, setDetailSelected] = useState(false);
```

Then make the blurb conditional in the header block:

```tsx
            <Text style={styles.eyebrow}>PEOPLE</Text>
            <Text style={styles.title}>{TAB_BLURBS[tab].label}</Text>
            {!detailSelected && <Text style={styles.blurb}>{TAB_BLURBS[tab].blurb}</Text>}
```

And pass the setter to the two tabs that have a detail pane:

```tsx
        {tab === 'customers' && canSeeCustomers ? <CustomersTab compact={compact} setHeaderActions={setHeaderActions} setDetailSelected={setDetailSelected} /> : null}
        {tab === 'team' && canSeeTeam ? <TeamManagementTab compact={compact} setHeaderActions={setHeaderActions} setDetailSelected={setDetailSelected} /> : null}
```

Schedule and Me are unchanged — they have no detail pane and no selection to publish.

- [ ] **Step 3: Consume it in both tabs**

Import the hook alongside the existing `useHeaderActions` import:

```tsx
import { useDetailSelection, useHeaderActions, type DetailSelectionSetter, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
```

Widen `CustomersTab`'s signature:

```tsx
function CustomersTab({
  compact,
  setHeaderActions,
  setDetailSelected,
}: {
  compact: boolean;
  setHeaderActions: HeaderActionsSetter;
  setDetailSelected: DetailSelectionSetter;
}) {
```

and `TeamManagementTab`'s the same way. In each, after `selectedId` is declared:

```tsx
  useDetailSelection(setDetailSelected, selectedId !== null);
```

- [ ] **Step 4: Typecheck and lint**

```bash
npx tsc --noEmit
npm run lint
npx jest
```

Expected: all clean.

- [ ] **Step 5: Verify in the running app**

```bash
npm run web
```

1. On Customers with nothing selected, the blurb reads "Who shops with you, and what they are worth."
2. Select a customer — the blurb disappears and the panes grow by its height.
3. Close the detail — the blurb returns.
4. Select someone, then switch to Team: the blurb for Team shows, because the cleanup ran.
5. Switch to Schedule: its blurb shows and never hides.

- [ ] **Step 6: Commit**

```bash
git add src/components/accounting/use-header-actions.ts "src/app/(admin)/(tabs)/people.tsx"
git commit -m "feat: hide the People blurb while a person is selected"
```

---

## Final verification

- [ ] **Full suite and typecheck**

```bash
npx tsc --noEmit
npm run lint
npx jest
```

- [ ] **Height check against the spec's budget**

At a browser window sized to exactly 900px tall, with a customer selected who has purchase history and a loyalty balance: the Customers detail pane must show the identity row, all four tiles, Notes, "Usually shops at", and both history cards without the pane itself scrolling. Individual history cards scrolling internally is correct and expected.

Repeat on Team with a member who has more than eight shift entries.

- [ ] **The known-tight case**

On Team, as a viewer without timesheet access at a 900px-tall window, the spec predicts the detail comes up ~55px short while the strip's caveat is showing. Confirm it is a short scroll and not a broken layout, and that dismissing the caveat resolves it. If it is worse than a short scroll, the spec names the fallback: move Team's search back into the list pane, recovering 54px.

- [ ] **Update the mockup's status**

Add a line at the top of `docs/design/people-density-mockup.html`'s lede noting it is now implemented, so the next reader knows it describes shipped behaviour rather than a proposal.
