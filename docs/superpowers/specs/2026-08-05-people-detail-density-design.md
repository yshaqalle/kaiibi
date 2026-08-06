# People detail density — design

**Date:** 2026-08-05
**Status:** Approved, ready for planning
**Scope:** The Customers and Team tabs of the People screen. Chrome above the
two panes, the detail pane's layout, and the height budget that connects them.
Nothing touches Schedule, Me, Dashboard, Accounting, or Inventory.

**Mockup:** `docs/design/people-density-mockup.html`

## Problem

Selecting a person on either People tab produces a detail pane that is already
scrolled past its own content. You read the top of a customer, then scroll down
inside a short window to find the rest, then scroll back up to read the name
again.

The cause is a height budget nobody has added up. Measured from the stylesheet
rather than a screenshot:

| Band | Style | Height |
|---|---|---|
| Body padding, top | `styles.body` | 18 |
| Eyebrow + title + blurb | `styles.headerRow` | 88 |
| Tab pills | `styles.tabBar` | 56 |
| "Customers at a glance" | `tabStyles.strip` + `BentoCard` | 174 |
| Search | `tabStyles.search` | 54 |
| Segment chips | `tabStyles.filterScroll` | 56 |
| **Chrome** | | **446** |

On a 900px-tall laptop, after browser chrome and the app's own nav shell, that
leaves the two panes roughly 340px. `CustomerDetailPane` needs about 830px to
draw itself: identity card 238, Notes 132, "Usually shops at" 108, and the two
history cards below that.

Team is the same disease with different numbers, and not — as an earlier draft
of this spec claimed — a worse case. Its chrome is 336px: no segment chips, and
its search is not chrome at all because it sits *inside* the scrolling list pane
(`people.tsx:747`), which is its own problem but does not cost the detail pane
anything. That leaves the panes ~450px, about 110px more than Customers gets.

It still does not fit. `TeamDetailPane` needs ~700px: identity 238, Payroll and
Access & permissions side by side ~180, Recent shifts up to 8 rows ~300. And
when the viewer lacks timesheet access the glance strip carries a `Caveat`
explaining the two blank figures, taking chrome to ~398 and the panes to ~388.

The page shell is deliberately not a `ScrollView` (`people.tsx:183`) so the two
panes can scroll independently under fixed chrome. That structure is right. The
problem is how much the chrome takes before the panes get a say.

## What this builds

1. A denser glance strip on both tabs — same figures, same hints, less height.
2. The screen blurb hidden while someone is selected.
3. The detail identity block collapsed from four stacked bands to one row.
4. A two-column detail layout on both tabs.
5. History lists bounded to the pane instead of growing without limit.
6. Team's search moved into the fixed chrome, matching Customers.

## Decisions

### The glance strip keeps its tiles, at reduced scale

Three treatments were mocked and compared: smaller tiles (B), a single inline
row of figures (C), and deleting the strip (D).

**B wins.** C and D both win more height by dropping the per-figure hints —
"clocked in at some point", "since the 1st", "tagged vip", "across every
store". Those hints are not decoration. `StatTile`'s own comment makes the case
better than this one can:

> The hint is where the DEFINITION goes [...] a figure that doesn't say what is
> in and out of it invites an argument.

"In today: 3" without "clocked in at some point" reads as a count of who is on
the floor right now, which it is not. Team is the tab where that matters most
and also the tab under the most height pressure — exactly where the temptation
to cut is strongest and the cost is highest.

B gets its height back from two places that cost nothing:

- **The card's title goes.** "Customers at a glance" / "The team at a glance"
  says nothing the tile labels don't already say. −27.
- **The tiles get a dense variant.** Padding 14 → 9, value 24 → 20,
  `minHeight` 92 → 74, hint `lineHeight` 15 → 14. −52.

Net 174 → ~118.

### Density is a new `StatTile` prop, not a change to its defaults

`StatTile` is rendered by Dashboard and Accounting as well. Changing `padding`
and `fontSize` in `styles.tile` would silently re-scale two converted screens
to fix a third.

Add `density?: 'default' | 'dense'`, orthogonal to the existing `variant`.
People passes `density="dense"`; nothing else changes.

`minWidth: 148` stays. It is what makes the surrounding `flexWrap` row actually
wrap on a phone, and the existing comment says so.

### The blurb hides while someone is selected

"Who shops with you, and what they are worth." orients a reader arriving at the
screen. It has nothing to say to a reader who has already arrived and is
looking at one person. −21 when it matters, and 0 cost when nothing is
selected.

This lives in the shell (`people.tsx`, the `headerRow`), so the shell needs to
know whether the active tab has a selection. Rather than lift `selectedId` out
of two tabs, the tabs publish it the same way they already publish header
actions — `useHeaderActions` has established that pattern and it does not
remount anything.

### The detail identity collapses to one row

Today `detHead` (name + badge), `detMeta` (role/phone/stores/joined), and
`actions` (WhatsApp, Edit, Mark VIP) are three stacked bands, and `actions`
carries `marginTop: 14` and `marginBottom: 14` of its own.

They become one row: name, badge and meta on the left, buttons pushed right.
~238 → ~178. On a long name the row wraps rather than clipping — the buttons
drop to a second line, which costs back the height only in the case that needs
it.

### The detail becomes two columns

**Customers** — left: identity + tiles, Notes, Usually shops at. Right:
Purchase history, Points history.

**Team** — left: identity + tiles, Payroll, Access & permissions. Right:
Recent shifts.

Team's Payroll and Access & permissions are currently a `BentoGrid` of two
`span={6}` cells. They move into the left column stacked. Permissions gains
room to render `permGrid` as a real grid rather than four tiles crushed into a
half-cell.

The split is not arbitrary: the left column is who the person is and what you
would change about them; the right is what they have done. That also puts every
editable control in one column, so the eye does not hunt between two for the
next action.

**Breakpoints.** Two columns above 1100px. Between the two-pane breakpoint
(`TABLET_BREAKPOINT`, 820) and 1100, one column — at 1024 the detail pane is
~660px and two 320px columns force the stat tiles to wrap 2×2, which is
survivable but not better than stacking. Below 820 the detail is already a
bottom-sheet modal and is unchanged.

1100 is a new constant in `src/constants/layout.ts` beside `TABLET_BREAKPOINT`.

### History lists are bounded by the pane, not by a magic number

The alternative was a "See all N" modal. Rejected: it puts a click between a
person and a purchase, and the modal has to re-render the same list anyway.

A fixed `maxHeight` was the next candidate and is also wrong — the right value
depends on the window, and any number picked here is wrong on a 1440×900 laptop
or wrong on a 27" monitor.

Instead the detail pane on wide becomes a flex column that fills the pane, and
the history cards flex to share what is left. Each card's list scrolls
internally. The card stops growing when the pane runs out, whatever the pane is.

**This requires a change to `TwoPaneListDetail`.** Its wide branch currently
wraps `detail` in a `ScrollView` with `contentContainerStyle: { flexGrow: 1 }`.
A flex child inside a `ScrollView` has unbounded height by definition, so
nothing can flex against the pane. The wide detail pane becomes a plain
`View` with `flex: 1`; the caller's content owns its own scrolling.

That is a behaviour change for any wide-pane caller whose detail is taller than
the pane and does not scroll internally — currently only these two tabs, both
of which this spec is changing. The list pane keeps its `ScrollView`. The
compact branch is untouched.

Scrolling inside a card whose top and bottom are both visible is a different
act from scrolling a page to find a card. That is the whole point of the change.

### Team's search moves into the fixed chrome

Today it is the first element of Team's `list` node (`people.tsx:747`), so it
scrolls away with the roster. Customers puts its search above
`TwoPaneListDetail` where it stays put. Nothing about a search field wants to
scroll away from the list it filters.

**This move costs height rather than saving it**, and the budget table below
shows it plainly: Team's chrome goes 336 → 313, a net gain of only 23px,
because the 54px the search now occupies used to come out of the list pane
alone. On the tab under the most pressure, this is the one change here that
makes the detail pane's arithmetic harder.

It is still right. Team fits after the two-column change regardless — that is
what closes Team's gap, not the chrome work — and a filter control that slides
off the top of a long roster is a defect, not a saving. But if the 7px of
margin proves too thin in practice, leaving Team's search in the list pane
recovers 54px and is the first thing to give up.

`TimeOffRequestsPanel` stays in the list pane. It is a queue you work through,
not a control you reach for.

### The timesheet-access caveat keeps its full height

Team's glance strip renders a `Caveat tone="partial"` when the viewer lacks
timesheet access, explaining why two of the four figures are blank. It is
already dismissible, so it costs its height once per viewer.

Shrinking an explanation to win pixels is how a screen ends up with figures
nobody trusts. It stays as it is.

## Height budget after

Body height available at a 900px-tall window, after browser chrome, is taken as
810px throughout.

| | Customers | Team | Team, caveat shown |
|---|---|---|---|
| Chrome before | 446 | 336 | 398 |
| Chrome after | 315 | 313 | 375 |
| Panes before | 340 | 450 | 388 |
| Panes after | 471 | 473 | 411 |
| Tallest detail column after | ~446 | ~466 | ~466 |

Customers fits with 25px to spare. Team fits with 7px to spare — and does
**not** fit when the timesheet caveat is showing, where it is ~55px short.

That last case is accepted rather than designed around. It affects only viewers
without timesheet access, who are already seeing "—" in two of the four figures;
the caveat is dismissible, so it costs them that 55px once; and the alternative
is shrinking the explanation, which the decision above rejects on principle. A
short scroll for a dismissible one-time notice is the cheapest thing on the
table.

Above 900px tall everything is headroom, and the flexing history cards spend it
on more visible rows rather than on white space.

## Not in this change

- **The Notes field's save behaviour.** It commits on blur only, so switching
  customer while the field is focused unmounts it and drops the edit; failures
  are swallowed by `onSave(...).catch(() => setDraft(...))` with no message; and
  it renders regardless of `canEdit` while the RLS policy admits
  `customers.edit`, `pos.access` *or* `sales.edit`. Three separate bugs, none of
  them layout. Tracked separately.
- **The remount on crossing `TABLET_BREAKPOINT`**, which resets search, filters
  and selection. `people.tsx:153-160` already documents it and says the fix
  belongs in the nav shell.
- Schedule and Me tabs.
- Dashboard, Accounting, Inventory, POS.

## Testing

The layout itself is not unit-testable in this codebase — there is no
render-test setup for these screens, and adding one is out of scope.

What is testable and worth testing:

- `StatTile` renders its hint in both densities. The regression this guards is
  the whole argument for B over C.
- The two-column breakpoint helper is a pure function of width. Three cases:
  below 820, between 820 and 1100, above 1100.

Everything else is verified against the mockup at three window heights: 900px
(must fit), 1080px, and the compact sheet below 820px wide.
