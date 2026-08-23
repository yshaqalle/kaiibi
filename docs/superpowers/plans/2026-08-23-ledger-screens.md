# Ledger Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the five ledger screens on the Accounting tab — a hub, the Chart of Accounts, the Journals list, the Trial Balance, the Audit Log, and the form that posts a manual entry — against the database that phase 1a already built.

**Architecture:** One new tab, `accounting`, added to the existing pill row in `accounting.tsx`. It renders a hub of launcher cards; picking one sets a **second URL param**, `view`, exactly as `tab` already works — no new routes, because the URL is what survives the shell's remount at `TABLET_BREAKPOINT`. Each view is its own component under `src/components/accounting/ledger/`, given a `dateRange` and a `setRefresh` like every other tab, and reads only `src/lib/ledger.ts` and `src/lib/ledger-math.ts`.

**Tech Stack:** Expo SDK 57, React Native, TypeScript, Jest + `react-test-renderer`. No new dependencies. No database work at all.

## Global Constraints

Every task's requirements implicitly include this section.

### Scope

This is **phase 1b** of [the accounting design](../specs/2026-08-22-accounting-standards-design.md), and it depends on [phase 1a](2026-08-23-ledger-foundations.md) (PR #63) being merged. It adds **no migration, no RPC, and no change to any existing tab.**

Explicitly not in this plan: cost layers, FIFO, any posting side on any existing RPC, the Reports hub, balance sheet, cash flow, income statement, period close, Create Bill, transfers, fixed assets, or depreciation. The P&L on the Reports tab is **not rewired** — it still reads `expenses`/`sales`, and will keep doing so until phase 2b.

### The one hazard this plan is designed against

**HAZARD — a second selector must not reset on a tab switch, and must survive a remount.**

`accounting.tsx:71-89` documents this at length: the web nav shell renders two different trees either side of `TABLET_BREAKPOINT`, so resizing a window or rotating a tablet **tears this screen down and builds a new one**. State does not survive; the URL does. `tab` is already mirrored into the URL for exactly this reason.

Therefore `view` is a URL param mirrored the same way, read once as an initial value, and **owned by the shell** — never by a tab component. A tab remounts on every switch; a `view` held inside one would send the reader back to the hub every time they came back from Reports.

### Baselines — green today, must be green at every commit

- `npx tsc --noEmit` → **clean, exit 0**
- `npm test` → **136 suites, 2097 tests, all passing**
- `npm run lint` → **76 problems (44 errors, 32 warnings)** at the start. Do not "fix" pre-existing ones in this plan's commits.

  **One expected exception, +1 per data-loading view, ending at 81.** Every screen that fetches needs `useEffect(() => { reload(); }, [reload])`, and `react-hooks` flags it as "Calling setState synchronously within an effect". That is not avoidable here: `use-refresh-on-focus.ts:28-31` states outright that it deliberately does *not* fetch on the focus that arrives with mounting, because **the screen's own effect has just fetched** — remove the effect and the view stays empty until its data goes stale. All five existing accounting tabs carry the same error (`receivables-tab.tsx:85`, `cash-budgets-tab.tsx:202`), and 68 instances of the rule already exist across the app.

  So the five new views take the count to **81**, and each commit's expected number is stated in its own verify step. Any increase beyond that is a real regression and must be fixed.
- `npm run test:db` → **16 checks pass.** Nothing here should touch it; run it once at the end to prove that.

### Bento rules — read [`.claude/skills/building-bento-screens/SKILL.md`](../../../.claude/skills/building-bento-screens/SKILL.md) before writing a screen

- **Never type a hex literal.** Every colour is a token on `Colors.light` — `bentoPage`, `bentoSurface`, `bentoSoft`, `bentoLine`, `bentoInk`, `bentoInk2`, `bentoMuted`, `bentoMuted2`, `bentoProfit`, `bentoLoss`. Every screen pins `const theme = Colors.light`; there is no dark mode.
- **Grid for glancing, flow for scanning.** A KPI strip goes in `BentoGrid`/`BentoCell`. A ledger, a journal list, a trial balance is read *down a column* — it gets a full-width `BentoCard` **outside** the grid, with `bodyStyle={{ paddingHorizontal: 10 }}` because `DataTable` brings its own gutters.
- **`DataTable` already scrolls horizontally inside its card.** Never wrap it in a `ScrollView horizontal` — that produces a table sliding inside a card inside a scrolling page.
- **`bentoProfit`/`bentoLoss` must always be paired with a sign or a glyph.** Green/red alone is ΔE 4.0 for deutan viewers.
- `Caveat` tones carry meaning: `wrong` means the number is wrong until something is fixed and **always needs an action**; `context` means the number is right and here is why it looks odd, and takes none.
- Use `BentoCard`, `StatementRow`, `DataTable` + `NameCell`/`ValueCell`, `Caveat`, `TabPills`. Do not rebuild them.

### Component contracts — checked against the source, get these right

Three of these were wrong in the first draft of this plan and would have failed to compile:

| | Actual signature |
|---|---|
| `DateRange` | **`{ since: Date; until?: Date }`** — not `start`/`end`. `until` is optional and means "through today". |
| `Caveat` | Takes its text as **`children`**, not a `text` prop: `<Caveat tone="context">…</Caveat>`. `action` is `{ label, onPress }` and is documented "omit when there is nothing to do". |
| `StatTile` | `{ value: string; label: string; hint?: string; … }` — `value` is a **pre-formatted string**, never a number. |

**A `Caveat` action must navigate somewhere real.** The skill's rule — a `wrong` with no fix trains people to ignore the whole family — is not satisfied by `onPress: () => {}`. Any view whose caveat offers to open another view takes an `onOpenView: (view: LedgerView) => void` prop and calls it.

**Known wart, deliberately repeated:** `StatTile` hardcodes the cream palette and has no `bento` variant, so it renders cream-bordered tiles on white bento cards. That is already live on the Dashboard and on Accounting's own Overview and Receivables tabs. This plan matches the existing screens rather than fixing it here — a `bento` variant for `StatTile` is a change across every converted screen and belongs in its own commit, not smuggled into this one.

### Everything else

- **Expo SDK 57.** Read <https://docs.expo.dev/versions/v57.0.0/> before writing any Expo-facing code rather than relying on memory. Nothing here is Expo-API-facing — every component used is plain React Native — so this is a guard, not a step.
- **Never import `Modal` directly.** `eslint.config.js` bans it outside `src/components/ui/app-modal.tsx`. The entry form in Task 6 is a **screen**, not a sheet, precisely so this never comes up.
- **A sheet opened from a sheet is dropped on iOS.** Nothing in this plan opens one. If a later change wants a modal here, it needs `useStagedSheet`.
- **Money is integer cents.** Format with `formatCents` / `formatCompactCents` from `src/lib/currency.ts`. Never divide by 100 in a component.
- Run `npm test`, `npm run lint` and `npx tsc --noEmit` before every commit.

### Test hygiene — read before writing any test step

This repo has shipped tests that could not fail, including two in phase 1a's own plan that passed against deliberately broken code. Therefore:

1. **Every test step below names the mutation that must turn it red.** After a test passes, apply that mutation, watch it fail, revert. Not optional, and not "run the suite".
2. **Assert at the boundary that matters.** A test about what a screen sends asserts on `postJournalEntry.mock.calls`, not on rendered text.
3. **`textFrom` recurses.** React Native's `Text` wraps content in a host-level `Text`, so a node's immediate `.children` is that nested instance and never the raw string. Reuse the existing helper in `src/components/__tests__/stock-count-modal.test.tsx:110-113`; do not rewrite it.
4. **A test asserting a total must use numbers that cannot coincide.** Phase 1a's reversal check summed a pair that balanced independently, so it was zero either way. Pick fixtures where the wrong implementation gives a visibly different number.

## File Structure

| File | Responsibility |
|---|---|
| `src/app/(admin)/(tabs)/accounting.tsx` | **Modify.** Adds the `accounting` tab, owns the `view` URL param, routes to the five views |
| `src/components/accounting/ledger/ledger-hub.tsx` | The four grouped launcher cards |
| `src/components/accounting/ledger/chart-of-accounts-view.tsx` | Accounts table + the A = L + E strip |
| `src/components/accounting/ledger/journals-view.tsx` | Entry list, filters, expandable lines |
| `src/components/accounting/ledger/trial-balance-view.tsx` | Debit/credit table + the proof strip |
| `src/components/accounting/ledger/audit-log-view.tsx` | Activity table |
| `src/components/accounting/ledger/journal-entry-view.tsx` | The posting form |
| `src/components/accounting/ledger/ledger-crumb.tsx` | The one-line "← Accounting" row every non-hub view shows |
| `src/lib/ledger-view.ts` | Pure helpers the views share: grouping accounts by type, the accounting-equation check, entry-line drafting |
| `src/lib/__tests__/ledger-view.test.ts` | Jest tests for the above |
| `src/lib/ledger.ts` | **Modify.** Adds `listAuditLog` and `listAccountingPeriods`, which phase 1a did not need |

Seven small components rather than one large screen, because each is a different question — "what accounts exist" and "what happened in the books" share a data source and nothing else. Pure logic goes in `ledger-view.ts` for the reason `expense-reporting.ts` sits apart from `expenses.ts`: anything importing a module that imports the Supabase client cannot load under Jest.

---

### Task 1: The `view` param and the tab

**Files:**
- Modify: `src/app/(admin)/(tabs)/accounting.tsx`
- Create: `src/components/accounting/ledger/ledger-hub.tsx`
- Create: `src/components/accounting/ledger/ledger-crumb.tsx`
- Test: `src/components/__tests__/accounting-ledger-nav.test.tsx`

**Interfaces:**
- Consumes: `TabPills`, `BentoCard` from `ui/`.
- Produces: `LedgerView = 'hub' | 'accounts' | 'entry' | 'journals' | 'trial' | 'audit'`, exported from `ledger-hub.tsx`; and `<LedgerCrumb onBack={() => void} />`. Tasks 2–6 render inside the routing this task adds.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/accounting-ledger-nav.test.tsx`:

```tsx
import { LEDGER_VIEWS, type LedgerView } from '@/components/accounting/ledger/ledger-hub';

describe('the ledger hub catalogue', () => {
  it('lists exactly the six views the shell can route to', () => {
    expect(LEDGER_VIEWS.map((v) => v.key)).toEqual(['hub', 'accounts', 'entry', 'journals', 'trial', 'audit']);
  });

  it('gives every non-hub view a group, so none can be added without a home on the hub', () => {
    for (const view of LEDGER_VIEWS) {
      if (view.key === 'hub') continue;
      expect(view.group).toBeTruthy();
    }
  });

  it('gives every view a label and a blurb, because the shell renders both in the title row', () => {
    for (const view of LEDGER_VIEWS) {
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.blurb.length).toBeGreaterThan(0);
    }
  });

  it('resolves an unknown view back to the hub rather than rendering nothing', () => {
    const resolve = (raw: string | undefined): LedgerView =>
      LEDGER_VIEWS.some((v) => v.key === raw) ? (raw as LedgerView) : 'hub';
    expect(resolve('trial')).toBe('trial');
    expect(resolve('nonsense')).toBe('hub');
    expect(resolve(undefined)).toBe('hub');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/components/__tests__/accounting-ledger-nav.test.tsx`
Expected: FAIL with `Cannot find module '@/components/accounting/ledger/ledger-hub'`.

- [ ] **Step 3: Write the crumb**

Create `src/components/accounting/ledger/ledger-crumb.tsx`:

```tsx
import { Pressable, StyleSheet, Text } from 'react-native';

import { Colors } from '@/constants/theme';

const theme = Colors.light;

// The one row every non-hub ledger view shows above the title.
//
// A back affordance rather than a second pill row: seven pills across the top
// and six more beneath them is two navigations competing for the same glance,
// and on a phone the second row would push the first thing worth reading off
// the screen.
export function LedgerCrumb({ onBack }: { onBack: () => void }) {
  return (
    <Pressable onPress={onBack} style={styles.row} role="link" accessibilityLabel="Back to Accounting">
      <Text style={styles.text}>← Accounting</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { alignSelf: 'flex-start', paddingVertical: 4, marginBottom: 6 },
  text: { fontSize: 12.5, fontWeight: '700', color: theme.bentoMuted },
});
```

- [ ] **Step 4: Write the hub**

Create `src/components/accounting/ledger/ledger-hub.tsx`:

```tsx
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Colors } from '@/constants/theme';

const theme = Colors.light;

export type LedgerView = 'hub' | 'accounts' | 'entry' | 'journals' | 'trial' | 'audit';

// The catalogue, in one place, because three things read it: the hub's cards,
// the shell's title row, and the shell's "is this a view I know" guard. Three
// copies of a list of six is how a seventh gets added to two of them.
//
// `group` is what the hub renders as a heading. A view with no group would
// appear nowhere and be reachable only by typing the URL.
export const LEDGER_VIEWS: { key: LedgerView; label: string; blurb: string; group: string | null }[] = [
  { key: 'hub', label: 'Accounting', blurb: 'The books themselves — accounts, entries and the trail behind them.', group: null },
  { key: 'accounts', label: 'Chart of Accounts', blurb: 'Every account the books can post to, and what is in each right now.', group: 'Ledger and journals' },
  { key: 'entry', label: 'General Journal Entry', blurb: "Record something the app can't post for you. It has to balance before it saves.", group: 'Ledger and journals' },
  { key: 'journals', label: 'Journals', blurb: 'Every entry that reached the books, newest first.', group: 'Ledger and journals' },
  { key: 'trial', label: 'Trial Balance', blurb: 'Proof the books balance, account by account.', group: 'Ledger and journals' },
  { key: 'audit', label: 'Audit Log', blurb: 'Who changed what, when — and what it looked like before.', group: 'Oversight' },
];

export function LedgerHub({ onOpen }: { onOpen: (view: LedgerView) => void }) {
  const groups = LEDGER_VIEWS.filter((v) => v.group).reduce<Record<string, typeof LEDGER_VIEWS>>((acc, view) => {
    const key = view.group as string;
    acc[key] = [...(acc[key] ?? []), view];
    return acc;
  }, {});

  return (
    <BentoCard>
      {Object.entries(groups).map(([group, views]) => (
        <View key={group}>
          <Text style={styles.group}>{group}</Text>
          <View style={styles.tiles}>
            {views.map((view) => (
              <Pressable key={view.key} style={styles.tile} onPress={() => onOpen(view.key)} role="button">
                <Text style={styles.tileTitle}>{view.label}</Text>
                <Text style={styles.tileBlurb}>{view.blurb}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  group: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk, marginBottom: 10, marginTop: 4 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 18 },
  // 260 rather than a fraction: the cards wrap to one column on a phone and to
  // as many as fit on a tablet, without the screen having to know which it is.
  tile: { flexGrow: 1, flexBasis: 260, backgroundColor: theme.bentoSoft, borderRadius: 18, padding: 14 },
  tileTitle: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk },
  tileBlurb: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 4, lineHeight: 16 },
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/components/__tests__/accounting-ledger-nav.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Prove the test can fail**

Mutation: in `LEDGER_VIEWS`, change `group: 'Oversight'` on the `audit` entry to `group: null`. Run the suite. Expected: `gives every non-hub view a group` fails. Revert.

Second mutation: reorder `LEDGER_VIEWS` so `trial` comes before `journals`. Expected: `lists exactly the six views` fails. Revert.

- [ ] **Step 7: Wire it into the shell**

In `src/app/(admin)/(tabs)/accounting.tsx`:

Add to the imports:

```tsx
import { LedgerCrumb } from '@/components/accounting/ledger/ledger-crumb';
import { LedgerHub, LEDGER_VIEWS, type LedgerView } from '@/components/accounting/ledger/ledger-hub';
```

Extend the tab union and the options list — `accounting` sits between `cash` and `reports`, because the books are what the day-to-day tabs feed and the reports read:

```tsx
type AccountingTab = 'overview' | 'transactions' | 'receivables' | 'invoices' | 'expenses' | 'payroll' | 'cash' | 'accounting' | 'reports';
```

```tsx
  { key: 'accounting', label: 'Accounting', blurb: 'The books themselves — accounts, entries and the trail behind them.' },
```

Read `view` alongside `tab`, and mirror it back the same way. **This is the hazard**: state does not survive the shell's remount at `TABLET_BREAKPOINT`, the URL does.

```tsx
  const { tab: tabParam, view: viewParam, session: sessionParam } = useLocalSearchParams<{ tab?: string; view?: string; session?: string }>();
```

```tsx
  // Owned by the shell for the same reason `tab` is: a tab component remounts
  // on every switch, so a `view` held inside one would drop the reader back on
  // the hub every time they came back from Reports. Unknown values resolve to
  // the hub rather than rendering nothing.
  const [view, setViewState] = useState<LedgerView>(
    LEDGER_VIEWS.some((v) => v.key === viewParam) ? (viewParam as LedgerView) : 'hub'
  );
  const setView = useCallback(
    (next: LedgerView) => {
      setViewState(next);
      router.setParams({ view: next });
    },
    [router]
  );
```

The title row shows the *view's* label once inside the ledger, not the tab's — otherwise every one of the six screens is titled "Accounting":

```tsx
  const ledgerView = LEDGER_VIEWS.find((v) => v.key === view);
  const inLedger = tab === 'accounting' && view !== 'hub';
  const title = inLedger ? ledgerView?.label : TAB_OPTIONS.find((t) => t.key === tab)?.label;
  const blurb = inLedger ? ledgerView?.blurb : TAB_OPTIONS.find((t) => t.key === tab)?.blurb;
```

Replace the two `TAB_OPTIONS.find(...)` calls in the header with `{title}` and `{blurb}`, put the crumb directly above the title, and render the tab:

```tsx
            {inLedger && <LedgerCrumb onBack={() => setView('hub')} />}
```

```tsx
            {tab === 'accounting' && view === 'hub' && <LedgerHub onOpen={setView} />}
```

- [ ] **Step 8: Verify and commit**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: exit 0; **137 suites, 2101 tests**; **76** lint problems — this task adds no data-loading view.

```bash
git add src/app/\(admin\)/\(tabs\)/accounting.tsx src/components/accounting/ledger/ src/components/__tests__/accounting-ledger-nav.test.tsx
git commit -m "feat(accounting): an Accounting tab, and a hub behind it"
```

---

### Task 2: The shared pure logic

**Files:**
- Create: `src/lib/ledger-view.ts`
- Create: `src/lib/__tests__/ledger-view.test.ts`

**Interfaces:**
- Consumes: `Account`, `JournalEntry` from `@/types/models`; `PostedLine`, `TrialBalanceRow` from `@/lib/ledger-math`.
- Produces:
  ```ts
  export type AccountGroup = { type: AccountType; label: string; accounts: Account[]; subtotalCents: number };
  export function groupAccountsByType(accounts: Account[], lines: PostedLine[]): AccountGroup[];
  export function accountingEquation(groups: AccountGroup[]): { assetsCents: number; liabilitiesCents: number; equityCents: number; differenceCents: number };
  export type DraftLine = { code: string; amountText: string; isCredit: boolean };
  export function draftToLines(draft: DraftLine[]): { code: string; amountCents: number }[];
  export function draftDifferenceCents(draft: DraftLine[]): number;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/ledger-view.test.ts`:

```ts
import { accountingEquation, draftDifferenceCents, draftToLines, groupAccountsByType } from '@/lib/ledger-view';
import type { Account } from '@/types/models';

const acct = (id: string, code: string, type: Account['type'], isContra = false): Account => ({
  id, shopId: 'shop', code, name: `Account ${code}`, type, isContra, archivedAt: null,
});

describe('groupAccountsByType', () => {
  const accounts = [
    acct('a', '1000', 'asset'),
    acct('b', '2000', 'liability'),
    acct('c', '3000', 'equity'),
    acct('d', '1590', 'asset', true),
  ];

  it('returns the six sections in statement order, not alphabetical', () => {
    const groups = groupAccountsByType(accounts, []);
    expect(groups.map((g) => g.type)).toEqual([
      'asset', 'liability', 'equity', 'revenue', 'cost_of_sales', 'expense',
    ]);
  });

  it('subtotals each section from the posted lines', () => {
    const groups = groupAccountsByType(accounts, [
      { accountId: 'a', amountCents: 500000 },
      { accountId: 'b', amountCents: -300000 },
    ]);
    expect(groups.find((g) => g.type === 'asset')?.subtotalCents).toBe(500000);
    // Liabilities carry credit balances. The section subtotal is reported as a
    // POSITIVE figure, because "you owe 3,000" is the sentence, not "-3,000".
    expect(groups.find((g) => g.type === 'liability')?.subtotalCents).toBe(300000);
  });

  it('nets a contra account against its own section rather than giving it one', () => {
    const groups = groupAccountsByType(accounts, [
      { accountId: 'a', amountCents: 500000 },
      { accountId: 'd', amountCents: -80000 },
    ]);
    expect(groups.find((g) => g.type === 'asset')?.subtotalCents).toBe(420000);
    expect(groups.map((g) => g.type)).not.toContain('contra');
  });
});

describe('accountingEquation', () => {
  it('is satisfied when assets equal liabilities plus equity', () => {
    const accounts = [acct('a', '1000', 'asset'), acct('b', '2000', 'liability'), acct('c', '3000', 'equity')];
    const eq = accountingEquation(groupAccountsByType(accounts, [
      { accountId: 'a', amountCents: 900000 },
      { accountId: 'b', amountCents: -400000 },
      { accountId: 'c', amountCents: -500000 },
    ]));
    expect(eq).toMatchObject({ assetsCents: 900000, liabilitiesCents: 400000, equityCents: 500000, differenceCents: 0 });
  });

  it('reports the gap when they do not, rather than hiding it', () => {
    const accounts = [acct('a', '1000', 'asset'), acct('b', '2000', 'liability')];
    const eq = accountingEquation(groupAccountsByType(accounts, [
      { accountId: 'a', amountCents: 900000 },
      { accountId: 'b', amountCents: -400000 },
    ]));
    // 900000 assets against 400000 liabilities and no equity. Deliberately
    // asymmetric numbers: 500000 could not arise by accident from these.
    expect(eq.differenceCents).toBe(500000);
  });
});

describe('draftToLines', () => {
  it('turns a debit and a credit row into one signed amount each', () => {
    expect(draftToLines([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '1200', amountText: '840.00', isCredit: true },
    ])).toEqual([
      { code: '5100', amountCents: 84000 },
      { code: '1200', amountCents: -84000 },
    ]);
  });

  it('drops rows with no account and rows with no amount, so a blank row is not an error', () => {
    expect(draftToLines([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '', amountText: '', isCredit: false },
      { code: '1200', amountText: '', isCredit: true },
    ])).toEqual([{ code: '5100', amountCents: 84000 }]);
  });

  it('refuses an unreadable amount rather than treating it as zero', () => {
    expect(() => draftToLines([{ code: '5100', amountText: 'abc', isCredit: false }])).toThrow(/840|amount/i);
  });
});

describe('draftDifferenceCents', () => {
  it('is zero when the two sides match', () => {
    expect(draftDifferenceCents([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '1200', amountText: '840.00', isCredit: true },
    ])).toBe(0);
  });

  it('reports the signed gap so the form can say which side is short', () => {
    expect(draftDifferenceCents([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '1200', amountText: '100.00', isCredit: true },
    ])).toBe(74000);
  });

  it('treats an unreadable amount as zero rather than throwing while somebody types', () => {
    // draftToLines throws on save; this runs on every keystroke and must not.
    expect(draftDifferenceCents([{ code: '5100', amountText: 'ab', isCredit: false }])).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/lib/__tests__/ledger-view.test.ts`
Expected: FAIL with `Cannot find module '@/lib/ledger-view'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ledger-view.ts`:

```ts
import { creditOf, debitOf, type PostedLine } from '@/lib/ledger-math';
import type { Account, AccountType } from '@/types/models';

// What the ledger screens need that is arithmetic rather than rendering. Kept
// out of the components so it can be tested without a render, and out of
// ledger.ts so it can be tested without a runtime.

// Statement order, not alphabetical and not enum order. This is the sequence a
// balance sheet and a P&L are read in, and every screen that groups by type
// wants the same one.
const SECTIONS: { type: AccountType; label: string }[] = [
  { type: 'asset', label: 'Assets' },
  { type: 'liability', label: 'Liabilities' },
  { type: 'equity', label: 'Equity' },
  { type: 'revenue', label: 'Revenue' },
  { type: 'cost_of_sales', label: 'Cost of sales' },
  { type: 'expense', label: 'Expenses' },
];

export type AccountGroup = {
  type: AccountType;
  label: string;
  accounts: Account[];
  subtotalCents: number;
};

// Assets and expenses carry debit balances; the other four carry credit
// balances. Reporting each section as a POSITIVE number is what lets the screen
// say "Liabilities 31,905.40" rather than "-31,905.40", which is the sentence
// an owner would say out loud.
//
// A contra account is netted into its own section rather than given one. A
// section called "Contra" would leave the reader adding it back by hand, and
// there is no statement anywhere that has such a section.
const DEBIT_SIDE: AccountType[] = ['asset', 'cost_of_sales', 'expense'];

export function groupAccountsByType(accounts: Account[], lines: PostedLine[]): AccountGroup[] {
  const balances = new Map<string, number>();
  for (const line of lines) {
    balances.set(line.accountId, (balances.get(line.accountId) ?? 0) + line.amountCents);
  }

  return SECTIONS.map(({ type, label }) => {
    const inSection = accounts.filter((a) => a.type === type);
    const signed = inSection.reduce((sum, a) => sum + (balances.get(a.id) ?? 0), 0);
    return {
      type,
      label,
      accounts: inSection,
      subtotalCents: DEBIT_SIDE.includes(type) ? debitOf(signed) - creditOf(signed) : creditOf(signed) - debitOf(signed),
    };
  });
}

export function accountingEquation(groups: AccountGroup[]): {
  assetsCents: number;
  liabilitiesCents: number;
  equityCents: number;
  differenceCents: number;
} {
  const of = (type: AccountType) => groups.find((g) => g.type === type)?.subtotalCents ?? 0;
  const assetsCents = of('asset');
  const liabilitiesCents = of('liability');
  const equityCents = of('equity');
  return {
    assetsCents,
    liabilitiesCents,
    equityCents,
    differenceCents: assetsCents - (liabilitiesCents + equityCents),
  };
}

export type DraftLine = { code: string; amountText: string; isCredit: boolean };

// The field holds the raw string and is classified once, from the whole string.
// Never normalise inside onChangeText on a controlled TextInput -- three silent
// 100x cost bugs on the Restock branch came from exactly that.
function readCents(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

// Throws on an unreadable amount, because this runs on SAVE and a row reading
// "abc" is a mistake rather than a decision. Blank is different: a blank row is
// one nobody filled in, and is dropped.
export function draftToLines(draft: DraftLine[]): { code: string; amountCents: number }[] {
  const out: { code: string; amountCents: number }[] = [];
  for (const row of draft) {
    if (!row.code) continue;
    if (row.amountText.trim().length === 0) continue;
    const cents = readCents(row.amountText);
    if (cents === null) {
      throw new Error(`"${row.amountText}" is not an amount. Use digits, like 840.00.`);
    }
    out.push({ code: row.code, amountCents: row.isCredit ? -cents : cents });
  }
  return out;
}

// Runs on every keystroke, so an unreadable amount counts as zero rather than
// throwing. The Post button is gated on draftToLines succeeding, which is where
// "abc" is caught.
export function draftDifferenceCents(draft: DraftLine[]): number {
  return draft.reduce((sum, row) => {
    if (!row.code) return sum;
    const cents = readCents(row.amountText);
    if (cents === null) return sum;
    return sum + (row.isCredit ? -cents : cents);
  }, 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/lib/__tests__/ledger-view.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Prove the tests can fail**

Mutation: in `groupAccountsByType`, drop the ternary and always use `debitOf(signed) - creditOf(signed)`. Run the suite. Expected: `subtotals each section from the posted lines` fails on the liability case. Revert.

Second mutation: in `readCents`, return `0` instead of `null` for an unreadable string. Expected: `refuses an unreadable amount rather than treating it as zero` fails. Revert.

Third mutation: in `draftDifferenceCents`, drop the `row.isCredit ? -cents : cents` and always add `cents`. Expected: `is zero when the two sides match` fails. Revert.

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: exit 0; **138 suites, 2112 tests**; **76** lint problems — `ledger-view.ts` is pure and fetches nothing.

```bash
git add src/lib/ledger-view.ts src/lib/__tests__/ledger-view.test.ts
git commit -m "feat(accounting): the ledger screens' arithmetic, without a render"
```

---

### Task 3: Chart of Accounts

**Files:**
- Create: `src/components/accounting/ledger/chart-of-accounts-view.tsx`
- Modify: `src/app/(admin)/(tabs)/accounting.tsx`

**Interfaces:**
- Consumes: `listAccounts`, `listPostedLines` from `@/lib/ledger`; `groupAccountsByType`, `accountingEquation` from `@/lib/ledger-view`; `RefreshSetter` from `use-header-actions`.
- Produces: `<ChartOfAccountsView setRefresh={...} onOpenView={...} />`. `onOpenView` is the shell's `setView` — the caveat's action needs somewhere real to go.

- [ ] **Step 1: Write the component**

Create `src/components/accounting/ledger/chart-of-accounts-view.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatCents, formatCompactCents } from '@/lib/currency';
import { listAccounts, listPostedLines } from '@/lib/ledger';
import { type LedgerView } from '@/components/accounting/ledger/ledger-hub';
import { accountingEquation, groupAccountsByType, type AccountGroup } from '@/lib/ledger-view';
import type { Account } from '@/types/models';

const theme = Colors.light;

type Row = { kind: 'account'; account: Account; balanceCents: number } | { kind: 'section'; group: AccountGroup };

const COLUMNS: Column<Row>[] = [
  {
    key: 'code',
    header: 'Code',
    width: 74,
    render: (row) => (row.kind === 'section' ? <Text style={styles.section}>{row.group.label}</Text> : <ValueCell value={row.account.code} tone="muted" />),
  },
  {
    key: 'name',
    header: 'Account',
    render: (row) =>
      row.kind === 'section' ? null : (
        <NameCell
          title={row.account.name}
          // The flag is what tells a reader why 1590 subtracts. Without it the
          // row reads as an asset that happens to be negative.
          meta={row.account.isContra ? 'reduces its section' : undefined}
        />
      ),
  },
  {
    key: 'balance',
    header: 'Balance',
    numeric: true,
    render: (row) =>
      row.kind === 'section' ? (
        <ValueCell value={formatCents(row.group.subtotalCents)} strong />
      ) : (
        <ValueCell value={formatCents(row.balanceCents)} />
      ),
  },
];

export function ChartOfAccountsView({ setRefresh, onOpenView }: { setRefresh: RefreshSetter; onOpenView: (view: LedgerView) => void }) {
  const { shop } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState(new Map<string, number>());
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    const today = new Date().toISOString().slice(0, 10);
    const [rows, lines] = await Promise.all([listAccounts(shop.id), listPostedLines(shop.id, today)]);
    const map = new Map<string, number>();
    for (const line of lines) map.set(line.accountId, (map.get(line.accountId) ?? 0) + line.amountCents);
    setAccounts(rows);
    setBalances(map);
    setLoaded(true);
  }, [shop]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const groups = useMemo(
    () => groupAccountsByType(accounts, [...balances].map(([accountId, amountCents]) => ({ accountId, amountCents }))),
    [accounts, balances]
  );
  const equation = useMemo(() => accountingEquation(groups), [groups]);

  // Section headers are rows rather than separate cards. Six cards each holding
  // four rows is six tables to scan; one table with six rules down it is a
  // chart of accounts, which is what an accountant is expecting to see.
  const rows = useMemo<Row[]>(
    () =>
      groups.flatMap((group) => [
        { kind: 'section' as const, group },
        ...group.accounts
          .filter((a) => a.archivedAt === null)
          .map((account) => ({ kind: 'account' as const, account, balanceCents: balances.get(account.id) ?? 0 })),
      ]),
    [groups, balances]
  );

  return (
    <View style={styles.wrap}>
      <BentoCard title="Right now" scope="As of today">
        <View style={styles.tiles}>
          <StatTile value={formatCompactCents(equation.assetsCents)} label="Assets" />
          <StatTile value={formatCompactCents(equation.liabilitiesCents)} label="Liabilities" />
          <StatTile value={formatCompactCents(equation.equityCents)} label="Equity" />
          <StatTile
            value={equation.differenceCents === 0 ? 'A = L + E' : formatCompactCents(equation.differenceCents)}
            label="Check"
            hint={equation.differenceCents === 0 ? 'the books balance' : 'they do not'}
          />
        </View>
        {equation.differenceCents !== 0 && (
          <Caveat tone="wrong" action={{ label: 'Open the trial balance', onPress: () => onOpenView('trial') }}>
            {`Assets are out by ${formatCents(equation.differenceCents)} against liabilities plus equity. Every entry balances individually, so this means an account is typed into the wrong section.`}
          </Caveat>
        )}
      </BentoCard>

      {/* Out of the grid: a chart of accounts is read down a column. */}
      <BentoCard title="Accounts" bodyStyle={styles.tableBody}>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          keyExtractor={(row) => (row.kind === 'section' ? `section-${row.group.type}` : row.account.id)}
          emptyLabel={loaded ? 'No accounts yet.' : 'Loading…'}
        />
      </BentoCard>

      <Caveat tone="context">
        An account that has been posted to can be renamed or archived, but never deleted or re-typed — that would silently change every past statement it appears in.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },
  section: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase', color: theme.bentoMuted },
});
```

- [ ] **Step 2: Route to it**

In `accounting.tsx`, alongside the hub line added in Task 1:

```tsx
            {tab === 'accounting' && view === 'accounts' && <ChartOfAccountsView setRefresh={setTabRefresh} onOpenView={setView} />}
```

and import it.

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: exit 0; 138 suites / 2112 tests; **77** lint problems — +1, the unavoidable mount-effect rule described in the constraints.

No new Jest test: every decision this component makes lives in `ledger-view.ts` and is tested there. What remains is rendering, and a test of it would assert that a `Text` contains what was passed to it.

```bash
git add src/components/accounting/ledger/chart-of-accounts-view.tsx src/app/\(admin\)/\(tabs\)/accounting.tsx
git commit -m "feat(accounting): the chart of accounts, on screen"
```

---

### Task 4: Trial Balance

**Files:**
- Create: `src/components/accounting/ledger/trial-balance-view.tsx`
- Modify: `src/app/(admin)/(tabs)/accounting.tsx`

**Interfaces:**
- Consumes: `listAccounts`, `listPostedLines`; `trialBalance` from `@/lib/ledger-math`.
- Produces: `<TrialBalanceView setRefresh={...} onOpenView={...} />`.

- [ ] **Step 1: Write the component**

Create `src/components/accounting/ledger/trial-balance-view.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatCents, formatCompactCents } from '@/lib/currency';
import { listAccounts, listPostedLines } from '@/lib/ledger';
import { type LedgerView } from '@/components/accounting/ledger/ledger-hub';
import { trialBalance, type TrialBalanceRow } from '@/lib/ledger-math';

const COLUMNS: Column<TrialBalanceRow>[] = [
  { key: 'code', header: 'Code', width: 74, render: (row) => <ValueCell value={row.code} tone="muted" /> },
  { key: 'name', header: 'Account', render: (row) => <NameCell title={row.name} /> },
  {
    key: 'debit',
    header: 'Debit',
    numeric: true,
    // An em dash, not 0.00. A trial balance has one figure per row and the
    // empty side is empty; printing zeroes down both columns doubles the ink
    // and halves the speed of finding the number that matters.
    render: (row) => <ValueCell value={row.debitCents === 0 ? '—' : formatCents(row.debitCents)} tone={row.debitCents === 0 ? 'muted' : undefined} />,
  },
  {
    key: 'credit',
    header: 'Credit',
    numeric: true,
    render: (row) => <ValueCell value={row.creditCents === 0 ? '—' : formatCents(row.creditCents)} tone={row.creditCents === 0 ? 'muted' : undefined} />,
  },
];

export function TrialBalanceView({ setRefresh, onOpenView }: { setRefresh: RefreshSetter; onOpenView: (view: LedgerView) => void }) {
  const { shop } = useAuth();
  const [rows, setRows] = useState<TrialBalanceRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    const today = new Date().toISOString().slice(0, 10);
    const [accounts, lines] = await Promise.all([listAccounts(shop.id), listPostedLines(shop.id, today)]);
    setRows(trialBalance(accounts, lines));
    setLoaded(true);
  }, [shop]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({ debitCents: acc.debitCents + row.debitCents, creditCents: acc.creditCents + row.creditCents }),
        { debitCents: 0, creditCents: 0 }
      ),
    [rows]
  );
  const differenceCents = totals.debitCents - totals.creditCents;

  return (
    <View style={styles.wrap}>
      <BentoCard title="As of today" scope="Every posted entry">
        <View style={styles.tiles}>
          <StatTile value={formatCompactCents(totals.debitCents)} label="Total debits" />
          <StatTile value={formatCompactCents(totals.creditCents)} label="Total credits" />
          <StatTile
            value={differenceCents === 0 ? 'Balanced' : formatCompactCents(differenceCents)}
            label="Difference"
            hint={differenceCents === 0 ? 'debits = credits' : 'this should be impossible'}
          />
        </View>
      </BentoCard>

      <BentoCard title="Accounts" bodyStyle={styles.tableBody}>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          keyExtractor={(row) => row.accountId}
          emptyLabel={loaded ? 'Nothing has been posted yet.' : 'Loading…'}
        />
      </BentoCard>

      {differenceCents === 0 ? (
        <Caveat tone="context">
          This cannot fail to balance: the database refuses an entry whose debits and credits differ, so the proof is shown rather than computed. A trial balance that does not show its own proof is not one.
        </Caveat>
      ) : (
        <Caveat tone="wrong" action={{ label: 'Check the audit log', onPress: () => onOpenView('audit') }}>
          {`Debits and credits differ by ${formatCents(differenceCents)}. Every entry is checked at the database, so this means a row was written by something that bypassed it.`}
        </Caveat>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },
});
```

- [ ] **Step 2: Route to it**

In `accounting.tsx`, add the import:

```tsx
import { TrialBalanceView } from '@/components/accounting/ledger/trial-balance-view';
```

and the route line, beneath the `accounts` line from Task 3:

```tsx
            {tab === 'accounting' && view === 'trial' && <TrialBalanceView setRefresh={setTabRefresh} onOpenView={setView} />}
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: exit 0; 138 suites / 2112 tests; **78** lint problems — +1 for the Trial Balance view's mount effect.

```bash
git add src/components/accounting/ledger/trial-balance-view.tsx src/app/\(admin\)/\(tabs\)/accounting.tsx
git commit -m "feat(accounting): a trial balance that shows its own proof"
```

---

### Task 5: Journals and the Audit Log

**Files:**
- Create: `src/components/accounting/ledger/journals-view.tsx`
- Create: `src/components/accounting/ledger/audit-log-view.tsx`
- Modify: `src/lib/ledger.ts`
- Modify: `src/app/(admin)/(tabs)/accounting.tsx`

**Interfaces:**
- Consumes: `listJournalEntries`; the shell's `dateRange`.
- Produces: `listAuditLog(shopId, limit)` on `@/lib/ledger` returning `AuditRow[]`; `<JournalsView dateRange={...} setRefresh={...} />`; `<AuditLogView setRefresh={...} />`.

- [ ] **Step 1: Add the audit-log reader**

Append to `src/lib/ledger.ts`:

```ts
export type AuditRow = {
  id: string;
  actorId: string | null;
  action: 'insert' | 'update' | 'delete';
  subjectTable: string;
  subjectId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
};

// Newest first, capped. The log is append-only and grows without bound, so a
// screen that fetched all of it would get slower every day it worked.
export async function listAuditLog(shopId: string, limit = 200): Promise<AuditRow[]> {
  const { data, error } = await supabase
    .from('accounting_audit_log')
    .select('id, actor_id, action, subject_table, subject_id, before, after, created_at')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    actorId: row.actor_id ?? null,
    action: row.action,
    subjectTable: row.subject_table,
    subjectId: row.subject_id,
    before: row.before ?? null,
    after: row.after ?? null,
    createdAt: row.created_at,
  }));
}
```

- [ ] **Step 2: Write the journals view**

Create `src/components/accounting/ledger/journals-view.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { type DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatCents } from '@/lib/currency';
import { debitOf } from '@/lib/ledger-math';
import { listJournalEntries } from '@/lib/ledger';
import type { JournalEntry } from '@/types/models';

const theme = Colors.light;

// The entry's size is the sum of its debits, not of all its lines -- which is
// zero for every entry ever written. An "amount" column reading 0.00 down the
// whole table is the first thing a reader would report as broken.
function entrySizeCents(entry: JournalEntry): number {
  return entry.lines.reduce((sum, line) => sum + debitOf(line.amountCents), 0);
}

const COLUMNS: Column<JournalEntry>[] = [
  { key: 'ref', header: 'Ref', width: 96, render: (row) => <ValueCell value={row.reference ?? '—'} tone="muted" /> },
  {
    key: 'date',
    header: 'Date',
    width: 84,
    render: (row) => <ValueCell value={new Date(row.entryDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} tone="muted" />,
  },
  {
    key: 'description',
    header: 'Entry',
    render: (row) => (
      <NameCell
        title={row.description}
        meta={row.status === 'reversed' ? 'reversed — see the mirror entry' : `${row.lines.length} lines · ${row.source}`}
      />
    ),
  },
  { key: 'amount', header: 'Amount', numeric: true, render: (row) => <ValueCell value={formatCents(entrySizeCents(row))} strong /> },
];

export function JournalsView({ dateRange, setRefresh }: { dateRange: DateRange; setRefresh: RefreshSetter }) {
  const { shop } = useAuth();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    const from = dateRange.since.toISOString().slice(0, 10);
    // `until` is optional and means "through today" -- range-selector.tsx:22.
    const to = (dateRange.until ?? new Date()).toISOString().slice(0, 10);
    setEntries(await listJournalEntries(shop.id, from, to));
    setLoaded(true);
  }, [shop, dateRange]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const manual = useMemo(() => entries.filter((e) => e.source === 'manual').length, [entries]);
  const reversed = useMemo(() => entries.filter((e) => e.status === 'reversed').length, [entries]);

  return (
    <View style={styles.wrap}>
      <BentoCard title="In this range">
        <View style={styles.tiles}>
          <StatTile value={String(entries.length)} label="Entries" />
          <StatTile value={String(manual)} label="Entered by hand" hint="the rest post themselves" />
          <StatTile value={String(reversed)} label="Reversed" hint="each linked to its mirror" />
        </View>
      </BentoCard>

      <BentoCard title="Journal entries" bodyStyle={styles.tableBody}>
        <DataTable
          columns={COLUMNS}
          rows={entries}
          keyExtractor={(row) => row.id}
          emptyLabel={loaded ? 'No entries in this range.' : 'Loading…'}
        />
      </BentoCard>

      <Caveat tone="context">
        Nothing posts here automatically yet. Sales, bills, payments and stock will write their own entries once the posting phase lands; until then this shows what has been entered by hand.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },
});
```

- [ ] **Step 3: Write the audit log view**

Create `src/components/accounting/ledger/audit-log-view.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { listAuditLog, type AuditRow } from '@/lib/ledger';

// "journal_entries" is what the column holds and not what a person calls it.
const SUBJECT_LABELS: Record<string, string> = {
  journal_entries: 'Journal entry',
  journal_lines: 'Entry line',
  accounts: 'Account',
  accounting_periods: 'Period',
};

const ACTION_LABELS: Record<AuditRow['action'], string> = {
  insert: 'Created',
  update: 'Changed',
  delete: 'Deleted',
};

const COLUMNS: Column<AuditRow>[] = [
  {
    key: 'when',
    header: 'When',
    width: 132,
    render: (row) => (
      <ValueCell
        value={new Date(row.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        tone="muted"
      />
    ),
  },
  {
    key: 'what',
    header: 'What',
    render: (row) => (
      <NameCell
        title={`${ACTION_LABELS[row.action]} ${(SUBJECT_LABELS[row.subjectTable] ?? row.subjectTable).toLowerCase()}`}
        meta={describe(row)}
      />
    ),
  },
  {
    key: 'who',
    header: 'Who',
    width: 110,
    // Null actor is a real answer, not missing data: a migration or a
    // maintenance script wrote it, and saying "System" is more honest than a
    // blank cell that reads as a bug.
    render: (row) => <ValueCell value={row.actorId ? 'A person' : 'System'} tone="muted" />,
  },
];

// The one field a reader actually wants out of the before/after blobs. Showing
// the whole jsonb would be a wall nobody reads; showing nothing would make the
// log a list of timestamps.
function describe(row: AuditRow): string | undefined {
  const after = row.after ?? {};
  const before = row.before ?? {};
  if (typeof after.reference === 'string') return after.reference;
  if (typeof after.status === 'string' && typeof before.status === 'string' && after.status !== before.status) {
    return `${before.status} → ${after.status}`;
  }
  if (typeof after.code === 'string') return `${after.code} ${after.name ?? ''}`.trim();
  return undefined;
}

export function AuditLogView({ setRefresh }: { setRefresh: RefreshSetter }) {
  const { shop } = useAuth();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    setRows(await listAuditLog(shop.id));
    setLoaded(true);
  }, [shop]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  return (
    <View style={styles.wrap}>
      <BentoCard title="Activity" scope="Last 200" bodyStyle={styles.tableBody}>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          keyExtractor={(row) => row.id}
          emptyLabel={loaded ? 'Nothing has happened in the books yet.' : 'Loading…'}
        />
      </BentoCard>

      <Caveat tone="context">
        Written by the database, not the app — so a change made through any route lands here. There is no way to edit or delete a row, including for the shop owner.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tableBody: { paddingHorizontal: 10 },
});
```

- [ ] **Step 4: Route to both**

In `accounting.tsx`, add the imports:

```tsx
import { AuditLogView } from '@/components/accounting/ledger/audit-log-view';
import { JournalsView } from '@/components/accounting/ledger/journals-view';
```

and the two route lines:

```tsx
            {tab === 'accounting' && view === 'journals' && <JournalsView dateRange={dateRange} setRefresh={setTabRefresh} />}
            {tab === 'accounting' && view === 'audit' && <AuditLogView setRefresh={setTabRefresh} />}
```

`JournalsView` takes `dateRange` because a journal is read a period at a time. `AuditLogView` does not: the log is "everything, newest first, capped at 200", and a range control over it would let a reader filter away the change they came to find.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: exit 0; 138 suites / 2112 tests; **80** lint problems — +2, one for each of the two views this task adds.

```bash
git add src/components/accounting/ledger/journals-view.tsx src/components/accounting/ledger/audit-log-view.tsx src/lib/ledger.ts src/app/\(admin\)/\(tabs\)/accounting.tsx
git commit -m "feat(accounting): the journals list, and the trail behind it"
```

---

### Task 6: The posting form

**Files:**
- Create: `src/components/accounting/ledger/journal-entry-view.tsx`
- Create: `src/components/__tests__/journal-entry-view.test.tsx`
- Modify: `src/app/(admin)/(tabs)/accounting.tsx`

**Interfaces:**
- Consumes: `postJournalEntry`, `listAccounts`; `draftToLines`, `draftDifferenceCents` from `@/lib/ledger-view`.
- Produces: `<JournalEntryView onPosted={() => void} setRefresh={...} />`.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/journal-entry-view.test.tsx`:

```tsx
import { draftDifferenceCents, draftToLines, type DraftLine } from '@/lib/ledger-view';

// The form's own rules, asserted at the boundary the screen calls rather than
// through a render: what it SENDS is the thing that must be right, and a render
// test of a form asserts that a TextInput holds what was typed into it.
describe('what the entry form is allowed to post', () => {
  const canPost = (draft: DraftLine[]): boolean => {
    try {
      const lines = draftToLines(draft);
      return lines.length >= 2 && draftDifferenceCents(draft) === 0;
    } catch {
      return false;
    }
  };

  it('allows a balanced two-line entry', () => {
    expect(canPost([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '1200', amountText: '840.00', isCredit: true },
    ])).toBe(true);
  });

  it('refuses an entry that is out by a cent', () => {
    expect(canPost([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '1200', amountText: '839.99', isCredit: true },
    ])).toBe(false);
  });

  it('refuses a single line even when the other row is blank', () => {
    expect(canPost([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '', amountText: '', isCredit: true },
    ])).toBe(false);
  });

  it('refuses an unreadable amount rather than silently dropping the row', () => {
    // Blank is permissive because nobody filled it in. "abc" is a mistake, and
    // dropping it would post a one-sided entry the database then rejects.
    expect(canPost([
      { code: '5100', amountText: 'abc', isCredit: false },
      { code: '1200', amountText: '840.00', isCredit: true },
    ])).toBe(false);
  });

  it('allows more than two lines as long as they balance', () => {
    expect(canPost([
      { code: '1000', amountText: '126.40', isCredit: false },
      { code: '4000', amountText: '120.00', isCredit: true },
      { code: '2100', amountText: '6.40', isCredit: true },
    ])).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/components/__tests__/journal-entry-view.test.tsx`
Expected: PASS — `ledger-view.ts` already exists from Task 2, and this test asserts its composition rather than new code. **This is deliberate**: it pins the rule the form must obey before the form exists, so Step 4 has something to be checked against.

- [ ] **Step 3: Prove the test can fail**

Mutation: in `ledger-view.ts`, make `draftToLines` return `[]` for an unreadable amount instead of throwing. Run the suite. Expected: `refuses an unreadable amount` fails. Revert.

- [ ] **Step 4: Write the form**

Create `src/components/accounting/ledger/journal-entry-view.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { listAccounts, postJournalEntry } from '@/lib/ledger';
import { draftDifferenceCents, draftToLines, type DraftLine } from '@/lib/ledger-view';
import type { Account } from '@/types/models';

const theme = Colors.light;

const BLANK: DraftLine = { code: '', amountText: '', isCredit: false };

export function JournalEntryView({ onPosted, setRefresh }: { onPosted: () => void; setRefresh: RefreshSetter }) {
  const { shop } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [description, setDescription] = useState('');
  // Two rows to start, because an entry needs two. Starting at one would put
  // the reader one tap from a state the database refuses.
  const [draft, setDraft] = useState<DraftLine[]>([{ ...BLANK }, { ...BLANK, isCredit: true }]);
  const [posting, setPosting] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    setAccounts((await listAccounts(shop.id)).filter((a) => a.archivedAt === null));
  }, [shop]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useTabRefresh(setRefresh, reload);

  const differenceCents = useMemo(() => draftDifferenceCents(draft), [draft]);
  const canPost = useMemo(() => {
    if (description.trim().length === 0) return false;
    try {
      return draftToLines(draft).length >= 2 && differenceCents === 0;
    } catch {
      return false;
    }
  }, [draft, description, differenceCents]);

  const setRow = (index: number, patch: Partial<DraftLine>) =>
    setDraft((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const submit = async () => {
    if (!shop || !canPost || posting) return;
    setPosting(true);
    let lines: { code: string; amountCents: number }[];
    try {
      lines = draftToLines(draft);
    } catch (error) {
      setPosting(false);
      Alert.alert('Check the amounts', error instanceof Error ? error.message : 'One of the amounts cannot be read.');
      return;
    }

    // Only the call is inside the try, and the try ends the moment it resolves.
    // On the Restock branch a failed reload left a full basket under a live
    // button and pressing again committed twice.
    try {
      await postJournalEntry({
        shopId: shop.id,
        entryDate: new Date().toISOString().slice(0, 10),
        description: description.trim(),
        lines,
      });
    } catch (error) {
      setPosting(false);
      Alert.alert('Not posted', error instanceof Error ? error.message : 'The entry was refused.');
      return;
    }

    setDescription('');
    setDraft([{ ...BLANK }, { ...BLANK, isCredit: true }]);
    setPosting(false);
    onPosted();
  };

  return (
    <View style={styles.wrap}>
      <BentoCard title="The entry">
        <Text style={styles.label}>Description</Text>
        <TextInput
          style={styles.input}
          value={description}
          onChangeText={setDescription}
          placeholder="What is this entry for?"
          placeholderTextColor={theme.bentoMuted2}
        />

        <Text style={[styles.label, styles.linesLabel]}>Lines</Text>
        {draft.map((row, index) => (
          <View key={index} style={styles.row}>
            <TextInput
              style={[styles.input, styles.code]}
              value={row.code}
              onChangeText={(code) => setRow(index, { code })}
              placeholder="Code"
              placeholderTextColor={theme.bentoMuted2}
            />
            <Pressable
              style={[styles.side, row.isCredit && styles.sideOn]}
              onPress={() => setRow(index, { isCredit: !row.isCredit })}
              role="button"
              accessibilityLabel={row.isCredit ? 'Credit — tap for debit' : 'Debit — tap for credit'}
            >
              <Text style={[styles.sideText, row.isCredit && styles.sideTextOn]}>{row.isCredit ? 'Credit' : 'Debit'}</Text>
            </Pressable>
            <TextInput
              style={[styles.input, styles.amount]}
              value={row.amountText}
              // The field holds the raw string. Never normalise inside
              // onChangeText on a controlled input -- three silent 100x cost
              // bugs on the Restock branch came from exactly that.
              onChangeText={(amountText) => setRow(index, { amountText })}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={theme.bentoMuted2}
            />
          </View>
        ))}

        <Pressable onPress={() => setDraft((rows) => [...rows, { ...BLANK }])} style={styles.addRow} role="button">
          <Text style={styles.addRowText}>+ Another line</Text>
        </Pressable>

        <View style={styles.balance}>
          <Text style={styles.balanceLabel}>Difference</Text>
          <Text style={[styles.balanceValue, { color: differenceCents === 0 ? theme.bentoProfit : theme.bentoLoss }]}>
            {differenceCents === 0 ? '✓ balanced' : formatCents(differenceCents)}
          </Text>
        </View>

        <Pressable
          onPress={submit}
          disabled={!canPost || posting}
          style={[styles.post, (!canPost || posting) && styles.postOff]}
          role="button"
        >
          <Text style={styles.postText}>{posting ? 'Posting…' : 'Post entry'}</Text>
        </Pressable>
      </BentoCard>

      <Caveat tone="wrong" action={{ label: 'See the journals', onPress: onPosted }}>
        Posting is final. A posted entry cannot be edited or deleted — if it is wrong, you reverse it, which leaves both the mistake and the correction on the record.
      </Caveat>
      <Caveat tone="context">
        {`${accounts.length} accounts are available. Type the code — 5100 for shrinkage, 1200 for inventory, 1000 for cash.`}
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  label: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase', color: theme.bentoMuted, marginBottom: 6 },
  linesLabel: { marginTop: 16 },
  input: {
    borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 10,
    fontSize: 13.5, color: theme.bentoInk, backgroundColor: theme.bentoSurface,
  },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8, alignItems: 'center' },
  code: { width: 88 },
  amount: { flex: 1, textAlign: 'right' },
  side: { borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 9 },
  sideOn: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  sideText: { fontSize: 12, fontWeight: '700', color: theme.bentoInk2 },
  sideTextOn: { color: theme.bentoSurface },
  addRow: { alignSelf: 'flex-start', paddingVertical: 8 },
  addRowText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoMuted },
  balance: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: theme.bentoSoft, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 13, marginTop: 10,
  },
  balanceLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase', color: theme.bentoMuted },
  balanceValue: { fontSize: 17, fontWeight: '800' },
  post: { backgroundColor: theme.bentoInk, borderRadius: 999, paddingVertical: 13, alignItems: 'center', marginTop: 12 },
  postOff: { opacity: 0.4 },
  postText: { color: theme.bentoSurface, fontSize: 13.5, fontWeight: '800' },
});
```

- [ ] **Step 5: Route to it**

In `accounting.tsx`:

```tsx
            {tab === 'accounting' && view === 'entry' && <JournalEntryView onPosted={() => setView('journals')} setRefresh={setTabRefresh} />}
```

Posting lands the reader on the journals list, where the entry they just wrote is the top row — the confirmation is the record itself rather than a toast that disappears.

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: exit 0; **139 suites, 2117 tests**; **81** lint problems — +1 for the form's account-list fetch. This is the final figure.

```bash
git add src/components/accounting/ledger/journal-entry-view.tsx src/components/__tests__/journal-entry-view.test.tsx src/app/\(admin\)/\(tabs\)/accounting.tsx
git commit -m "feat(accounting): posting an entry by hand, and it has to balance first"
```

---

### Task 7: Prove it on a device

**Files:** none — this task changes no code unless it finds something.

- [ ] **Step 1: Confirm the database is reachable**

The screens read tables that phase 1a created. If `npx supabase db push` has not been run against the project in `.env`, every view will error rather than render empty.

Run: `npx supabase migration list --linked`
Expected: the six `20260904*` migrations shown as applied remotely. If they are not, **stop** — this is not a code problem and the owner has to run `db push`.

- [ ] **Step 2: Run the app on web**

Run: `npx expo start --web`

Open `/accounting?tab=accounting`. Check, in order:

1. The **Accounting** pill appears between Cash & Budgets and Reports, and the hub renders four launcher cards under two group headings.
2. Opening **Chart of Accounts** shows 31 accounts under six section headings, and the Check tile reads `A = L + E`.
3. **Trial Balance** shows "Nothing has been posted yet" and Difference reads `Balanced`.
4. **General Journal Entry**: type `5100` / debit / `840.00` and `1200` / credit / `840.00`. Difference goes to `✓ balanced` and Post enables. Post it — you land on Journals with the entry at the top.
5. **Trial Balance** now shows two rows totalling 840.00 on each side.
6. **Audit Log** shows the entry's creation.

- [ ] **Step 3: Prove the view survives a remount**

This is the hazard the plan is built around, and it cannot be checked by reading.

With **Trial Balance** open, resize the browser window across the tablet breakpoint (roughly 900px) and back. The screen must still be on Trial Balance. If it drops to the hub, `view` is not reaching the URL — check `router.setParams` in `setView`.

- [ ] **Step 4: Check a phone width**

Narrow the window to ~390px. The hub cards stack to one column; the tables scroll **inside** their cards, and the page itself never scrolls sideways. If the whole page slides, something wrapped a `DataTable` in a horizontal scroller.

- [ ] **Step 5: Run the whole suite one last time and commit anything found**

Run: `npx tsc --noEmit && npm test && npm run lint && npm run test:db`
Expected: exit 0; 139 suites / 2117 tests; **81** lint problems; 16 database checks.

`test:db` is run here to prove this plan touched nothing it should not have.

---

## What phase 2a picks up

FIFO cost layers — `inventory_cost_layers`, `inventory_cost_consumption`, the opening-balance migration, the basis setting, and the concurrency work in `complete_sale` and `save_stock_count`. It must land **before** any existing RPC gains a posting side, or the ledger records weighted-average COGS for a few weeks and FIFO after, with a discontinuity nothing explains.

Nothing in this plan constrains it. The screens here read the ledger and do not care how COGS was computed.
