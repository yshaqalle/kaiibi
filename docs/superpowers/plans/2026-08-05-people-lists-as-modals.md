# People: lists as modals, Team rebuild, staff photos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Supersedes** Tasks 7 and 8 of `docs/superpowers/plans/2026-08-05-people-detail-density.md`. Tasks 1–6 of that plan are complete and committed (`3f7d60b..041883f`). Do not re-run them.

**Goal:** Move the four unbounded People lists into modals, rebuild the Team tab to match Customers, and add photos to team members.

**Architecture:** One shared `ListCard` component owns both the compact card and its modal, and is used at four call sites. Because nothing in the detail pane then scrolls internally, `detailFills` and `detailCardStyles` become dead and are removed. Staff photos reuse the existing `uploadImage()` helper and its bucket; only a nullable column and a mapper field are new.

**Tech Stack:** Expo SDK 57, React Native, TypeScript, Supabase (Postgres + Storage), Jest with `jest-expo`.

**Mockup:** `docs/design/people-density-mockup.html` — section "Revision: the unbounded lists become modals".

## Global Constraints

- **Never hardcode a hex colour.** Every colour comes from `Colors.light` in `src/constants/theme.ts`. `const theme = Colors.light` at module scope; no dark mode.
- **Card radius is `BENTO_RADIUS` (26)** via `Card variant="bento"`. Never write `borderRadius: 26` on a `View`.
- **Do not change `StatTile`'s defaults** — Dashboard and Accounting render it too.
- **Do not fix the Notes field's save behaviour** (blur-only save, swallowed errors, no `canEdit` gate). Known separate defect.
- **Do not touch** Schedule, Me, Dashboard, Accounting, Inventory, or POS.
- Run Jest and every other command from the **repo root**. Running from inside `.claude/worktrees/` picks up stray worktrees and reports phantom failures.
- Baseline entering this plan: **39 suites / 698 tests**, tsc clean, lint 39 problems (all pre-existing).
- Expo docs are the versioned ones at https://docs.expo.dev/versions/v57.0.0/ (per `AGENTS.md`).
- Commit after every task. Do not push.

---

### Task 1: The `ListCard` component

A compact card that previews the first rows of a list and opens a modal holding all of them. Four call sites will use it: Purchase history, Points history, Recent shifts, Time off requests.

**Files:**
- Create: `src/components/ui/list-card.tsx`

**Interfaces:**
- Consumes: `BentoCard` from `@/components/ui/bento-card`, `Card` from `@/components/card`.
- Produces:
  ```tsx
  function ListCard<T>(props: {
    title: string;
    scope?: string;              // the pill: "4 orders", "148 balance", "2 pending"
    subtitle?: string;           // modal-only line, e.g. the person's name
    rows: T[];
    keyExtractor: (row: T) => string;
    renderRow: (row: T) => ReactNode;
    emptyLabel: string;
    previewCount?: number;       // default 2
    actions?: ReactNode;         // rendered in the card head, replacing the scope pill
    footer?: ReactNode;          // rendered inside the modal, below the list
  }): JSX.Element
  ```

- [ ] **Step 1: Create the component**

Create `src/components/ui/list-card.tsx`:

```tsx
import { useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Colors } from '@/constants/theme';

const theme = Colors.light;

// A list that is usually short and occasionally very long.
//
// Four cards on the People screen are like this -- purchase history, points
// history, recent shifts, time off requests -- and they share a problem: the
// fields around them are a fixed size while they are not, so one customer with
// forty orders decides the height of a pane that everyone else reads.
//
// The card shows the first `previewCount` rows and opens the rest in a modal.
// A preview rather than a bare count because the common case IS the preview: a
// customer with one order has their whole history on the card and never sees a
// "View all" at all. Only the long tail costs a tap.
export function ListCard<T>({
  title,
  scope,
  subtitle,
  rows,
  keyExtractor,
  renderRow,
  emptyLabel,
  previewCount = 2,
  actions,
  footer,
}: {
  title: string;
  /** The pill in the card head -- "4 orders", "148 balance". */
  scope?: string;
  /** Shown under the title in the MODAL only. Whose list this is. */
  subtitle?: string;
  rows: T[];
  keyExtractor: (row: T) => string;
  renderRow: (row: T) => ReactNode;
  emptyLabel: string;
  previewCount?: number;
  /** Replaces the scope pill in the card head when the card needs a control. */
  actions?: ReactNode;
  /** Rendered inside the modal, below the list. For a caveat about the list. */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const preview = rows.slice(0, previewCount);
  const hidden = rows.length - preview.length;

  return (
    <BentoCard title={title} scope={actions ? undefined : scope} actions={actions}>
      {rows.length === 0 ? (
        <Text style={styles.empty}>{emptyLabel}</Text>
      ) : (
        <>
          {preview.map((row) => (
            <View key={keyExtractor(row)}>{renderRow(row)}</View>
          ))}
          {/* Only when there IS more. A card showing everything it has should
              not invite a tap that reveals the same thing again. */}
          {hidden > 0 && (
            <Pressable onPress={() => setOpen(true)} style={({ pressed }) => [styles.viewAll, pressed && styles.pressed]}>
              <Text style={styles.viewAllText}>{`View all ${rows.length} →`}</Text>
            </Pressable>
          )}
        </>
      )}

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.head}>
              <View style={styles.headTitles}>
                <Text style={styles.modalTitle}>{title}</Text>
                {/* Whose list this is. "Purchase history" alone is ambiguous
                    the moment two people have been open in one session. */}
                {subtitle ? <Text style={styles.modalSub}>{subtitle}</Text> : null}
              </View>
              <Pressable onPress={() => setOpen(false)} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
            <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
              {rows.map((row) => (
                <View key={keyExtractor(row)}>{renderRow(row)}</View>
              ))}
              {footer}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  empty: { fontSize: 13, color: theme.bentoMuted },
  viewAll: { paddingTop: 10 },
  viewAllText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk },
  pressed: { opacity: 0.6 },
  overlay: { flex: 1, backgroundColor: 'rgba(11,11,13,0.45)', justifyContent: 'flex-end' },
  // The page grey, not white: the sheet is a ground, and giving it the card's
  // own fill would flatten the two into one surface.
  sheet: { backgroundColor: theme.bentoSurface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 18, maxHeight: '85%' },
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 },
  headTitles: { flexShrink: 1 },
  modalTitle: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4, color: theme.bentoInk },
  modalSub: { fontSize: 12.5, color: theme.bentoMuted, marginTop: 2 },
  close: { backgroundColor: theme.bentoSoft, paddingVertical: 7, paddingHorizontal: 14, borderRadius: 999 },
  closeText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
  body: { flexGrow: 0 },
});
```

- [ ] **Step 2: Write the test**

The preview/hidden arithmetic is the one piece of logic here and it has an off-by-one that matters: a list of exactly `previewCount` must show NO "View all". Extract nothing — test through the rendered output, the way `stat-tile.test.tsx` does.

Create `src/components/__tests__/list-card.test.tsx`:

```tsx
import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';
import { Text } from 'react-native';

import { ListCard } from '@/components/ui/list-card';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function renderCard(count: number) {
  const rows = Array.from({ length: count }, (_, i) => ({ id: String(i), label: `row-${i}` }));
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(
      <ListCard
        title="Purchase history"
        rows={rows}
        keyExtractor={(r) => r.id}
        renderRow={(r) => <Text>{r.label}</Text>}
        emptyLabel="No purchases yet."
      />
    );
  });
  return textsIn(tree!.toJSON() as ReactTestRendererJSON);
}

describe('ListCard preview', () => {
  it('shows the empty label and no View all when there are no rows', () => {
    const texts = renderCard(0);
    expect(texts).toContain('No purchases yet.');
    expect(texts.some((t) => t.startsWith('View all'))).toBe(false);
  });

  // The load-bearing case: a list that exactly fills the preview is COMPLETE.
  // Offering "View all 2" there shows the reader the same two rows again.
  it('shows no View all when the rows exactly fill the preview', () => {
    const texts = renderCard(2);
    expect(texts).toContain('row-0');
    expect(texts).toContain('row-1');
    expect(texts.some((t) => t.startsWith('View all'))).toBe(false);
  });

  it('shows View all with the FULL count once there is more than the preview', () => {
    const texts = renderCard(5);
    expect(texts).toContain('View all 5 →');
  });

  // The count names the whole list, not the hidden remainder -- "View all 5"
  // on a 5-row list, never "View all 3".
  it('does not name the hidden remainder', () => {
    const texts = renderCard(5);
    expect(texts.some((t) => t.startsWith('View all 3'))).toBe(false);
  });

  it('renders only the preview rows on the card, not the whole list', () => {
    const texts = renderCard(5);
    expect(texts).toContain('row-1');
    // row-2 onwards exist only inside the closed Modal. react-test-renderer
    // renders Modal children even when not visible, so assert on the CARD's
    // preview count instead: row-0 and row-1 each appear twice (card + modal),
    // row-2 only once (modal only).
    expect(texts.filter((t) => t === 'row-1')).toHaveLength(2);
    expect(texts.filter((t) => t === 'row-2')).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test**

```bash
npx jest src/components/__tests__/list-card.test.tsx
```

Expected: PASS, 5 tests. If the last test's counts differ, react-test-renderer is handling `Modal` differently than assumed — report the actual counts rather than adjusting the numbers to whatever passes, because an assertion tuned to its own output proves nothing.

- [ ] **Step 4: Full check and commit**

```bash
npx tsc --noEmit && npm run lint && npx jest
```

Expected: tsc clean, lint 39, 40 suites / 703 tests.

```bash
git add src/components/ui/list-card.tsx src/components/__tests__/list-card.test.tsx
git commit -m "feat: add ListCard, a short card over a long list"
```

---

### Task 2: Customers histories move into ListCard

Reworks what Task 6 of the previous plan built, now that the design has changed.

**Files:**
- Modify: `src/app/(admin)/(tabs)/people.tsx` — `CustomerDetailPane`

**Interfaces:**
- Consumes: `ListCard` from Task 1.
- Produces: nothing.

- [ ] **Step 1: Import `ListCard`, drop the fill imports**

Add `import { ListCard } from '@/components/ui/list-card';`.

In `CustomerDetailPane`, delete the `fills` declaration and every use of `detailCardStyles.fill` / `detailCardStyles.fillBody`, and change the wrapper `View` back to `style={tabStyles.detailStack}` with no conditional. Change the import of `@/components/ui/detail-columns` to `import { DetailColumns } from '@/components/ui/detail-columns';` — `detailCardStyles` and `useDetailColumns` are no longer needed here.

- [ ] **Step 2: Replace both history cards**

Replace the `right={...}` prop of `DetailColumns` with:

```tsx
        right={
          <>
            <ListCard
              title="Purchase history"
              scope={stats ? `${stats.visitCount} orders` : undefined}
              subtitle={`${customer.firstName} ${customer.lastName ?? ''}`.trim()}
              rows={purchases}
              keyExtractor={(p) => p.saleItemId}
              emptyLabel="No purchases yet."
              renderRow={(p) => (
                <View style={tabStyles.histRow}>
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
              )}
            />

            {/* What answers "why is my balance 148" at the counter. The ledger is
                append-only, so a correction shows up as its own row rather than
                quietly changing an old one. */}
            {loyaltyOn && (
              <ListCard
                title="Points history"
                scope={`${customer.pointsBalance.toLocaleString()} balance`}
                subtitle={`${customer.firstName} ${customer.lastName ?? ''}`.trim()}
                rows={pointsHistory}
                keyExtractor={(entry) => entry.id}
                emptyLabel="No points activity yet."
                renderRow={(entry) => (
                  <View style={tabStyles.histRow}>
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
                )}
                footer={
                  pointsHistory.length > 0 && !ledgerNote.dismissed ? (
                    <Caveat tone="context" onDismiss={ledgerNote.dismiss}>
                      The ledger is append-only — a correction arrives as its own row rather than quietly changing an old
                      one, which is what answers &quot;why is my balance what it is&quot; at the counter.
                    </Caveat>
                  ) : undefined
                }
              />
            )}
          </>
        }
```

The `loyaltyOn` guard on Points history and the `ledgerNote.dismissed` guard on the caveat both survive — the caveat moves into the modal's `footer`, where the ledger it explains actually is.

- [ ] **Step 3: Stop the pane filling**

On `TwoPaneListDetail` in `CustomersTab`, remove `detailFills={detailColumns === 2}`, and remove the now-unused `const detailColumns = useDetailColumns();` and its import if nothing else in `CustomersTab` uses it.

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit && npm run lint && npx jest
```

Expected: tsc clean, lint 39, 40 suites / 703 tests.

```bash
git add "src/app/(admin)/(tabs)/people.tsx"
git commit -m "feat: Customers histories become short cards over modals"
```

---

### Task 3: Rebuild the Team tab

**Files:**
- Modify: `src/app/(admin)/(tabs)/people.tsx` — `TeamManagementTab`, `TeamDetailPane`

**Interfaces:**
- Consumes: `GlanceStrip`, `DetailColumns`, `ListCard`, `StatTile`'s `density`.
- Produces: nothing.

- [ ] **Step 1: Replace Team's glance strip**

Replace the `BentoCard title="The team at a glance"` block with a `GlanceStrip` carrying the same four `StatTile`s at `density="dense"`, and the timesheet `Caveat` passed as the `caveat` prop. Every value, label and hint expression stays exactly as it is today — copy them across unchanged:

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

- [ ] **Step 2: Move the search into the fixed chrome**

Delete the `View style={tabStyles.search}` block from the top of the `list` node, so `list` begins:

```tsx
  const list = (
    <>
      {error && <Text style={tabStyles.errorText}>{error}</Text>}
      {canApproveTimeOff && <TimeOffRequestsPanel requests={timeOff} staff={staff} onChange={reload} />}
```

Add it above `TwoPaneListDetail`, directly after the `GlanceStrip`:

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

- [ ] **Step 3: Collapse the detail identity to one row**

Replace the `detHead` / `detMeta` / `actions` blocks in `TeamDetailPane` with the shared one-row treatment Task 6 of the previous plan added for Customers. `tabStyles.detHeadRow`, `detIdent` and `detActions` already exist:

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

The three-tile `metricRow` and the `activeLeaveRequest` `Caveat` below it stay exactly as they are.

- [ ] **Step 4: Two columns, with Recent shifts as a ListCard**

Replace the `BentoGrid` holding Payroll and Access & permissions, and the "Recent shifts" `BentoCard`, with a `DetailColumns`. Left keeps Payroll and Access & permissions **exactly as they are today**, including the `canManagePayroll`/`canManageRoster` action gate and the `noPayrollNote` caveat — copy those two `BentoCard` blocks across unchanged. Right becomes:

```tsx
        right={
          canViewHours ? (
            <ListCard
              title="Recent shifts"
              scope="This period"
              subtitle={member.fullName ?? member.email ?? 'Staff member'}
              rows={entries}
              keyExtractor={(e) => e.id}
              emptyLabel="No shifts logged this period."
              renderRow={(e) => (
                <View style={tabStyles.shiftRow}>
                  <Text style={tabStyles.shiftDate}>
                    {new Date(e.clockIn).toLocaleDateString()} · {new Date(e.clockIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    {e.clockOut ? `–${new Date(e.clockOut).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' (on shift)'}
                  </Text>
                  <Text style={tabStyles.shiftDuration}>{e.clockOut ? `${sumDurationHours([e]).toFixed(1)}h` : '—'}</Text>
                </View>
              )}
            />
          ) : null
        }
```

The old `.slice(0, 8)` cap goes. It existed only because an unbounded list grew the page; `ListCard` previews two and the modal holds the rest, so a full period is now reachable instead of silently truncated.

- [ ] **Step 5: Remove the dead `BentoGrid`/`BentoCell` import**

Neither is used anywhere in the file now. Remove them from the `@/components/ui/bento` import; delete the line if it becomes empty.

- [ ] **Step 6: Verify and commit**

```bash
npx tsc --noEmit && npm run lint && npx jest
```

Expected: tsc clean, lint 39, 40 suites / 703 tests.

```bash
git add "src/app/(admin)/(tabs)/people.tsx"
git commit -m "feat: two-column Team detail, dense strip, shifts in a modal"
```

---

### Task 4: Time off requests becomes a ListCard

**Files:**
- Modify: `src/components/time-off-requests-panel.tsx`

**Interfaces:**
- Consumes: `ListCard` from Task 1.
- Produces: nothing.

- [ ] **Step 1: Read the file first**

This is the only task here operating on a component the plan has not already quoted in full. Read `src/components/time-off-requests-panel.tsx` (184 lines) before editing. It differs from the other three lists in two ways that must survive:

1. Its rows carry **Approve/Deny actions**, not just text. Those handlers and their permission gating must work identically inside the modal.
2. Its scope pill is meaningful state: `pending.length > 0 ? `${pending.length} pending` : 'All clear'`. That count is the reason to open the card at all — keep it exactly.

- [ ] **Step 2: Convert the panel's body to `ListCard`**

Keep the component's own props, data fetching, and every handler. Replace only its `BentoCard` + row-mapping body with a `ListCard`, passing:
- `title="Time off requests"`
- `scope` — the existing pending-count/All-clear expression, unchanged
- `rows` — whatever list it renders today, in the same order
- `keyExtractor` — the request's `id`
- `renderRow` — the existing row JSX, including the Approve/Deny controls and their gating, moved verbatim
- `emptyLabel` — the existing empty copy

Do not change any handler, any permission check, or any copy.

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit && npm run lint && npx jest
```

Expected: tsc clean, lint 39, 40 suites / 703 tests.

```bash
git add src/components/time-off-requests-panel.tsx
git commit -m "feat: time off requests becomes a short card over a modal"
```

---

### Task 5: Remove the now-dead fill machinery

`detailFills` and `detailCardStyles` exist only to let a card flex against a bounded pane. With every long list in a modal, nothing does. Leaving them would be dead code carrying a subtle "clipped, not scrolled" contract that the next reader would trust.

**Files:**
- Modify: `src/components/two-pane-list-detail.tsx`
- Modify: `src/components/ui/detail-columns.tsx`

- [ ] **Step 1: Confirm they are unused**

```bash
grep -rn "detailFills\|detailCardStyles\|detailStackFills" src
```

Expected: hits only in the two definition files. If any call site remains, stop and report BLOCKED — something in Tasks 2–4 was missed.

- [ ] **Step 2: Revert `TwoPaneListDetail` to its single wide branch**

Remove the `detailFills` prop, its destructured default, the ternary, and the `paneFill` style, restoring the wide detail pane to the `ScrollView` it was before. `useDetailColumns` and `DetailColumns` stay — the two-column layout is still in use.

- [ ] **Step 3: Remove `detailCardStyles`**

Delete the exported `detailCardStyles` StyleSheet and its JSDoc from `src/components/ui/detail-columns.tsx`. Leave `useDetailColumns` and `DetailColumns` untouched.

- [ ] **Step 4: Remove `detailStackFills`**

Delete that entry from `tabStyles` in `src/app/(admin)/(tabs)/people.tsx` if Task 2 did not already.

- [ ] **Step 5: Verify and commit**

```bash
npx tsc --noEmit && npm run lint && npx jest
grep -rn "detailFills\|detailCardStyles\|detailStackFills" src
```

Expected: tsc clean, lint 39, 40 suites / 703 tests, and the grep returns nothing.

```bash
git add src/components/two-pane-list-detail.tsx src/components/ui/detail-columns.tsx "src/app/(admin)/(tabs)/people.tsx"
git commit -m "refactor: drop the fill machinery the modals made unnecessary"
```

---

### Task 6: Hide the blurb while someone is selected

Unchanged from Task 8 of the previous plan. Reproduced here in full so this plan stands alone.

**Files:**
- Modify: `src/components/accounting/use-header-actions.ts`
- Modify: `src/app/(admin)/(tabs)/people.tsx` — `PeopleScreen`, `CustomersTab`, `TeamManagementTab`

**Interfaces:**
- Produces: `type DetailSelectionSetter = (selected: boolean) => void` and `useDetailSelection(setSelected, selected): void`.

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

Make the blurb conditional:

```tsx
            {!detailSelected && <Text style={styles.blurb}>{TAB_BLURBS[tab].blurb}</Text>}
```

Pass the setter to the two tabs that have a detail pane:

```tsx
        {tab === 'customers' && canSeeCustomers ? <CustomersTab compact={compact} setHeaderActions={setHeaderActions} setDetailSelected={setDetailSelected} /> : null}
        {tab === 'team' && canSeeTeam ? <TeamManagementTab compact={compact} setHeaderActions={setHeaderActions} setDetailSelected={setDetailSelected} /> : null}
```

Schedule and Me are unchanged — no detail pane, no selection to publish.

- [ ] **Step 3: Consume it in both tabs**

Widen the import:

```tsx
import { useDetailSelection, useHeaderActions, type DetailSelectionSetter, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
```

Widen both tab signatures with `setDetailSelected: DetailSelectionSetter`, and in each, after `selectedId` is declared:

```tsx
  useDetailSelection(setDetailSelected, selectedId !== null);
```

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit && npm run lint && npx jest
```

Expected: tsc clean, lint 39, 40 suites / 703 tests.

```bash
git add src/components/accounting/use-header-actions.ts "src/app/(admin)/(tabs)/people.tsx"
git commit -m "feat: hide the People blurb while a person is selected"
```

---

### Task 7: Staff photos — database and model

Team members have no photo anywhere: not on `StaffMember`, not in the database. Customers do not either; this task adds it for staff only, which is what was asked.

**Files:**
- Create: `supabase/migrations/<timestamp>_staff_photo.sql`
- Modify: `src/types/models.ts`
- Modify: `src/lib/staff.ts`

**Interfaces:**
- Produces: `StaffMember.photoUrl: string | null`, populated by the staff row mapper.

- [ ] **Step 1: Read how an existing nullable column reaches the model**

Before writing anything, read `src/lib/staff.ts` and find the row→model mapper. Follow how an existing nullable text field (`phone`, or `hire_date`) is selected, named and mapped. Your column must travel the same path — including being added to any explicit `select(...)` column list, which is the step most easily missed and fails silently as `undefined`.

- [ ] **Step 2: Write the migration**

Name the file with a timestamp later than every existing migration (`ls supabase/migrations | tail -3` to check). Content:

```sql
-- Staff photos. Nullable: a shop that never uploads one is not incomplete,
-- and the roster falls back to initials.
--
-- The URL is public, like product images: it points into the same
-- `product-images` bucket, whose RLS is keyed off the first path segment
-- being the shop id rather than the kind of image (migration 0002), so no
-- new bucket or policy is needed.
alter table public.shop_members add column if not exists photo_url text;
```

Check whether the existing `update shop_members` RLS policy is column-scoped. If it is, extend it to include `photo_url`; if it grants the whole row, nothing more is needed. State which you found in your report.

- [ ] **Step 3: Add the field to the model**

In `src/types/models.ts`, add to `StaffMember`, after `phone`:

```ts
  // Optional. Falls back to initials on the roster; a shop that never uploads
  // one is not incomplete.
  photoUrl: string | null;
```

- [ ] **Step 4: Map it**

Add `photoUrl: row.photo_url ?? null` to the staff row mapper, and add `photo_url` to the explicit select list if there is one.

- [ ] **Step 5: Verify and commit**

```bash
npx tsc --noEmit && npx jest
```

`tsc` will fail if any construction of a `StaffMember` literal now misses the field — fix each at its source rather than making the field optional. Expected once clean: 40 suites / 703 tests.

```bash
git add supabase/migrations "src/types/models.ts" src/lib/staff.ts
git commit -m "feat: add a photo_url column for staff"
```

---

### Task 8: Staff photos — upload and display

**Files:**
- Modify: `src/app/(admin)/(tabs)/people.tsx` — `TeamAddModal`, `TeamDetailPane`, the roster rows

**Interfaces:**
- Consumes: `uploadImage` from `@/lib/storage`, `StaffMember.photoUrl` from Task 7.

- [ ] **Step 1: Read the product image picker first**

`uploadImage(path, localUri)` in `src/lib/storage.ts` already handles the web/native split (web goes through `fetch().blob()`, native through `expo-file-system`'s `File`, because RN's Blob polyfill has no `arrayBuffer()`). Do not reimplement any of that.

Find the product form's image picker (`src/components/product-form.tsx`) and follow how it calls `expo-image-picker` and then `uploadImage`. Reuse that flow — same permission handling, same error handling, same loading state.

Path convention: `${shopId}/staff/${memberId}`. The bucket's RLS requires the FIRST path segment to be the shop id; getting that wrong fails the upload with a policy error, not a 404.

- [ ] **Step 2: Add the picker to the add/edit staff form**

Above the existing FULL NAME field, matching the mockup: a circular preview of the current photo (or a placeholder) beside a dashed "Click to upload a photo" target. Label it `PHOTO` in the same uppercase style the other field labels use.

A member being **created** has no id yet to build the path from. Upload after the member row is created, then patch `photo_url` — or generate the id client-side if the insert already does. Read the existing create flow and follow whichever it does; state which in your report.

- [ ] **Step 3: Show it on the roster and the detail pane**

- Roster row: a small circular avatar before the name, falling back to the person's initials on `bentoSoft` when `photoUrl` is null.
- Detail pane: the same avatar in the identity row, before the name.

Extract the avatar as one small component rather than writing the fallback twice — it appears in at least three places counting the form's preview.

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit && npm run lint && npx jest
```

```bash
git add "src/app/(admin)/(tabs)/people.tsx" src/components
git commit -m "feat: staff photos on the roster, detail and add form"
```

---

## Final verification

- [ ] `npx tsc --noEmit && npm run lint && npx jest` — tsc clean, lint 39 (baseline), 40 suites / 703 tests.
- [ ] `grep -rn "detailFills\|detailCardStyles\|detailStackFills" src` returns nothing.
- [ ] At a 900px-tall window, a customer with purchase history and a loyalty balance shows identity, four tiles, Notes, "Usually shops at", and both history cards without the pane scrolling. Same on Team for a member with more than eight shifts.
- [ ] Each of the four lists opens its modal, scrolls inside it, and closes. Time off requests' Approve/Deny still work from inside the modal.
- [ ] A list of exactly two rows shows no "View all".
- [ ] Staff photo: upload on create, upload on edit, and the initials fallback for a member with no photo.
- [ ] Update the mockup's lede to note it describes shipped behaviour.
