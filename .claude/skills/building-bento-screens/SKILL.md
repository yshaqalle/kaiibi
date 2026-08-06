---
name: building-bento-screens
description: Use when building, restyling, or converting any kaiibi screen — POS, Inventory, People, Settings — or adding a card, table, stat tile, chart, filter control, or caveat to Dashboard or Accounting. Also when a screen reads cream instead of grey, a card has a border or the wrong radius, or you are about to write a hex color into a screen.
---

# Building bento screens

## Overview

Bento is kaiibi's surface system: a grey page, borderless 26px white cards, a cool-grey ink
ramp, and a fixed control vocabulary. **The grid is the least important part of it** — most
screens take the surfaces and keep the layout they already have.

**The core rule: grid for glancing, flow for scanning.**

Converted: Dashboard, Accounting. Not yet: POS, Inventory, People, Settings — those still
read `background` / `surface` / `border`. Two palettes coexist on purpose; don't half-apply
tokens to an unconverted screen.

## The one decision

Ask: **does the reader take this in at a glance, or read down it?**

| Glancing | Scanning |
|---|---|
| KPI strips, charts, a P&L, detail-pane tiles | Ledgers, rosters, transaction lists, tables |
| `BentoGrid` + `BentoCell` | Plain flow, one full-width card |
| Cells side by side is the whole value | A table in a cell spans all 12 columns anyway and loses 36px of padding for nothing |

Getting this wrong costs a nested scroll: on a phone the table slides sideways inside a card
that is itself inside a scrolling page. `DataTable` already scrolls horizontally **inside**
the card — never wrap it in another horizontal scroller.

## Worked example — both halves of one tab

```tsx
// Expenses: a strip you glance at, then a ledger you read down.
<BentoGrid>
  <BentoCell span={12}>
    <BentoCard title="This period" scope={rangeLabel}>
      <View style={styles.metricRow}>
        <StatTile value={formatCompactCents(operatingCents)} label="Operating" hint="feeds net profit" />
        <StatTile value={formatCompactCents(excludedCents)} label="Stock & owner draws" hint="excluded from profit" />
      </View>
    </BentoCard>
  </BentoCell>
</BentoGrid>

{/* Out of the grid entirely — a ledger is read down a column, so it gets the
    full width and manages its own gutters. */}
<BentoCard title="Logged expenses" actions={<AddButton />} bodyStyle={styles.tableBody}>
  <DataTable
    columns={EXPENSE_COLUMNS}
    rows={expenses}
    keyExtractor={(expense) => expense.id}
    emptyLabel="No expenses in this range."
  />
</BentoCard>
```

`tableBody` is `{ paddingHorizontal: 10 }`, not the card's usual 18 — the table has its own.

## Tokens — [src/constants/theme.ts](src/constants/theme.ts)

Never hardcode a hex. Every screen pins `const theme = Colors.light` (no dark mode yet).

| Token | Use |
|---|---|
| `bentoPage` | The grey the cards float on. `SafeAreaView` background, nothing else |
| `bentoSurface` | Card fill |
| `bentoSoft` | Tiles, selected rows, inset panels |
| `bentoLine` | Row rules and pill hairlines |
| `bentoInk` / `bentoInk2` | Headings and values / secondary text |
| `bentoMuted` / `bentoMuted2` | Labels / hints |
| `bentoSeries1-4` | Categorical chart series only — never status |
| `bentoProfit` / `bentoLoss` | Status only. **Must be paired with a sign or glyph** — green/red is ΔE 4.0 for deutan viewers |
| `BENTO_RADIUS` | 26. The stock `Card` stays at 12 |

## Components — use these, don't rebuild them

| Need | Component |
|---|---|
| A card with a title and a scope pill | `BentoCard` ([ui/bento-card.tsx](src/components/ui/bento-card.tsx)) |
| A bare card | `Card variant="bento"` |
| Grid | `BentoGrid` / `BentoCell span={n}` — `span` is in **twelfths always**; the cell halves it at 6 columns and ignores it at 1 |
| A qualification on a figure | `Caveat` |
| A money line that reconciles | `StatementRow` — `variant="item" \| "emphasis" \| "total"` |
| A table | `DataTable` + `NameCell` / `ValueCell` |
| Date range + store picker | `BentoControlBar` — hides the store pill for single-store shops itself |
| Tab buttons on the title row | `useHeaderActions` |

## Screen shell recipe

Copy [accounting.tsx](<src/app/(admin)/(tabs)/accounting.tsx>). In order:

1. `SafeAreaView` — `backgroundColor: theme.bentoPage`
2. `ScrollView` — `padding: 18, paddingBottom: 60`
3. Header row — eyebrow (10.5px/800, 1 letter-spacing, `bentoMuted`), title (26px/800, −1),
   blurb (13px, `bentoMuted`), and `BentoControlBar` on the right
4. Pill tab row, if the screen has tabs
5. Body

The shell owns the title, the range and the store filter. **Never move them into a tab** — a
tab remounts on every switch and silently resets the reader's filter.

## Caveat tones — the tone *is* the meaning

| Tone | Means | Action |
|---|---|---|
| `wrong` | The number is wrong until something is fixed | **Always** give one |
| `context` | The number is right; here is why it looks surprising | None, and none implied |
| `partial` | Permissions hide part of it | None |

A `wrong` with no fix, or a `context` that actually needs action, trains people to ignore the
whole family.

## Red flags — stop and reach for the system instead

- About to type a hex literal into a screen → it's a token, or it doesn't belong
- About to write `borderRadius: 26` on a `View` → that's `Card variant="bento"`
- A `DataTable` in a `BentoCell span={7}` → give it 12, or take it out of the grid
- Wrapping a `DataTable` in `<ScrollView horizontal>` → it already scrolls
- Moving the range or store picker inside a tab → it will reset on every switch
- `Caveat tone="wrong"` with no `action` → either find the fix or it's `context`
- A figure in `bentoProfit`/`bentoLoss` with no sign or arrow → colour alone isn't the signal
- Dropping `StatTile`, `Badge` or `CategoryChip` on a bento card and calling it done → they
  hardcode the cream palette and each need a `bento` variant. This is currently live on
  Dashboard and Accounting: cream-bordered tiles on white cards

## Converting a whole screen

Build a mockup first — `docs/design/<screen>-mockup.html`, following the three already there.
Publish it as an Artifact and get it judged before writing code. Every screen converted so
far was seen before it was planned.

Then update the token comment in [theme.ts](src/constants/theme.ts) to drop that screen from
the still-cream list, so the next reader knows what is left.
