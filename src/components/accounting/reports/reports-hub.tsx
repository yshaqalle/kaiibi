import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// Type-only, and it has to stay that way: this module is imported by the nav
// test, and a value import would drag the ledger hub's component in behind it.
// It is here so that renaming a ledger view breaks the three cards below that
// hand off to one, rather than shipping a card that opens the hub.
import type { LedgerView } from '@/components/accounting/ledger/ledger-hub';
import { Card } from '@/components/card';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import type { Permission } from '@/lib/permissions';

const theme = Colors.light;

export type ReportView =
  | 'hub'
  // The seven that read tables kaiibi already has.
  | 'sales'
  | 'item'
  | 'employee'
  | 'category'
  | 'inventory'
  | 'lowstock'
  | 'movement'
  // Not a card and not one of the seven -- see STATEMENTS_CARD below.
  | 'statements';

/**
 * The catalogue, in one place, for the same four readers `LEDGER_VIEWS` has:
 * the hub's cards, the shell's title row, the shell's "is this a view I know"
 * guard, and the nav test.
 *
 * This is the SEVEN REPORTS BUILT HERE and nothing else, which is why every
 * entry is `available`. The design drew eleven cards; the other four are not in
 * this list, and each says below why not. `available` stays as a field because
 * `VALUATION_CARD` still needs the dimmed rendering, and because the day an
 * eighth report is catalogued before its screen exists, this is the flag that
 * has to be set honestly rather than the list that has to be invented.
 *
 * `requires` is the permission the card's own door needs, and every one of the
 * seven buildable reports is `null` ON PURPOSE. The rule the ledger hub
 * established is that a card is gated when its door RAISES and left open when
 * its door returns nothing: `statement_lines()` is security definer and raises
 * P0001 without `ledger.view`, so its card is gated, while the Chart of
 * Accounts reads a table under RLS and answers a reader without the permission
 * with an honest empty state. All seven reports here are in the second family
 * -- they read `sales`, `sale_items`, `products`, `product_location_stock`,
 * `stock_receipts`, `stock_transfers` and `stock_counts` directly, with no RPC
 * anywhere -- so gating them would hide a report that would have worked. The
 * field exists so a later report over an RPC cannot be added without the
 * question being asked.
 *
 * `followsRange` says whether the screen behind the card honours the shell's
 * date picker. It drives the footer: a card that names a fixed window a screen
 * does not keep is a card that gets believed. Seven days is only the picker's
 * OPENING preset, so `scope` here is the fallback shown before the range has
 * been reported, and the live label replaces it.
 *
 * The hub itself is NOT in here, unlike `LEDGER_VIEWS`: every entry is a report
 * this hub routes to, and the hub is not one. Its title row reads out of
 * `HUB_META` instead.
 */
export const REPORT_VIEWS: {
  key: ReportView;
  label: string;
  blurb: string;
  group: string;
  icon: keyof typeof Ionicons.glyphMap;
  scope: string;
  action: string;
  /** False renders the card dimmed, with `waitingOn` and no press target. */
  available: boolean;
  /** Why it is not available. Rendered on the card, so it may not be blank. */
  waitingOn: string;
  followsRange: boolean;
  requires: Permission | null;
}[] = [
  {
    key: 'sales',
    label: 'Sales Reports',
    blurb: 'Revenue by day, payment method and store.',
    group: 'Sales',
    icon: 'pie-chart-outline',
    scope: '7 days',
    action: 'Run report',
    available: true,
    waitingOn: '',
    followsRange: true,
    requires: null,
  },
  {
    key: 'item',
    label: 'Item Performance',
    blurb: 'Top and bottom sellers by units and margin.',
    group: 'Sales',
    icon: 'grid-outline',
    scope: '7 days',
    action: 'Run report',
    available: true,
    waitingOn: '',
    followsRange: true,
    requires: null,
  },
  {
    key: 'employee',
    label: 'Sales by Employee',
    blurb: 'Revenue and baskets per cashier.',
    group: 'Sales',
    icon: 'people-outline',
    scope: '7 days',
    action: 'Run report',
    available: true,
    waitingOn: '',
    followsRange: true,
    requires: null,
  },
  {
    key: 'category',
    label: 'Sales by Category',
    blurb: 'Revenue and margin by product category.',
    group: 'Sales',
    icon: 'layers-outline',
    scope: '7 days',
    action: 'Run report',
    available: true,
    waitingOn: '',
    followsRange: true,
    requires: null,
  },
  {
    key: 'inventory',
    label: 'Inventory Balance',
    blurb: 'Stock on hand, and what it is worth at cost.',
    group: 'Inventory',
    icon: 'cube-outline',
    // Stock on hand is a position read at an instant. There is no such thing
    // as the stock a shop held over the last seven days, so this screen
    // ignores the picker and the card says so.
    scope: 'As of today',
    action: 'Run report',
    available: true,
    waitingOn: '',
    followsRange: false,
    requires: null,
  },
  {
    key: 'lowstock',
    label: 'Low Stock & Reorder',
    blurb: 'Items at or below their reorder point.',
    group: 'Inventory',
    icon: 'warning-outline',
    scope: 'As of today',
    action: 'Run report',
    available: true,
    waitingOn: '',
    followsRange: false,
    requires: null,
  },
  {
    key: 'movement',
    label: 'Stock Movement',
    blurb: 'Deliveries, transfers and stock-takes.',
    group: 'Inventory',
    icon: 'swap-horizontal-outline',
    scope: '7 days',
    action: 'Run report',
    available: true,
    waitingOn: '',
    followsRange: true,
    requires: null,
  },
];

/**
 * Three of the four cards the design drew as "not yet". They are not waiting on
 * anything: posting shipped in 2b (#74) and all three statements shipped in 3a
 * (#80), and they have been rendering on the Accounting tab ever since. The
 * cards said "Needs the posting phase" only because the mockup was drawn before
 * either landed and its copy shipped verbatim.
 *
 * So they are DOORS, not corrected signposts. The argument is the one
 * `STATEMENTS_CARD` makes below -- a route nothing links to is a deleted screen
 * with extra steps -- and it is stronger here, because the alternative is a
 * dimmed card saying "over there somewhere" about a screen that is one press
 * away. A reader who wants a balance sheet on the Reports tab should get one,
 * not a footnote.
 *
 * They are deliberately NOT in `REPORT_VIEWS`: that list is the reports this
 * hub routes to, its `available` set is pinned to the seven built here, and
 * these three are not reports this hub owns at all. `key` is the LEDGER's view
 * key, typed as `LedgerView`, because the key IS the destination.
 *
 * `requires: 'ledger.view'` for the same reason `LEDGER_VIEWS` gates them:
 * `statement_lines()`, `balance_sheet()` and `cash_flow()` are security definer
 * and RAISE P0001 without it, and the seeded Manager role holds `sales.view`
 * and not `ledger.view`. A door that refuses is worse than no door, so the
 * card is dropped rather than dimmed -- the hub's dimming already means
 * "nothing to show", and one appearance cannot mean two things.
 *
 * `scope` and `followsRange` are copied from `LEDGER_VIEWS` rather than
 * reworded, because the shell owns ONE date range across every tab: press one
 * of these and the range you picked on Reports is the range the statement runs
 * for. Two names for one window is how a reader stops believing either.
 */
export const LEDGER_STATEMENT_CARDS: {
  key: LedgerView;
  label: string;
  blurb: string;
  group: string;
  icon: keyof typeof Ionicons.glyphMap;
  scope: string;
  action: string;
  available: boolean;
  waitingOn: string;
  followsRange: boolean;
  requires: Permission | null;
}[] = [
  {
    key: 'income',
    // "Profit & Loss" is the name the design drew and the name a shopkeeper
    // uses; "Income Statement" is what the screen it opens is titled. The blurb
    // carries both so the title change on arrival is not a surprise.
    label: 'Profit & Loss',
    blurb: 'Revenue, cost of sales and expenses, down to net profit. Opens the Income Statement in Accounting.',
    group: 'Financial statements',
    icon: 'cash-outline',
    scope: 'The chosen range',
    // Says where the press lands BEFORE it lands. A card that silently moves
    // the reader to another tab reads as the app losing its place.
    action: 'Open in Accounting',
    available: true,
    waitingOn: '',
    followsRange: true,
    requires: 'ledger.view',
  },
  {
    key: 'balance',
    label: 'Balance Sheet',
    blurb: "What the shop owns, what it owes, and what's left over. Opens in Accounting.",
    group: 'Financial statements',
    icon: 'business-outline',
    // A position read at an instant, and the instant is the range's END, not
    // today -- exactly as the ledger hub's own card says.
    scope: 'As at the range end',
    action: 'Open in Accounting',
    available: true,
    waitingOn: '',
    followsRange: false,
    requires: 'ledger.view',
  },
  {
    key: 'cashflow',
    label: 'Cash Flow',
    blurb: 'Where cash actually came from and went. Profit and cash are not the same thing. Opens in Accounting.',
    group: 'Financial statements',
    icon: 'water-outline',
    scope: 'The chosen range',
    action: 'Open in Accounting',
    available: true,
    waitingOn: '',
    followsRange: true,
    requires: 'ledger.view',
  },
];

/**
 * The fourth card the design drew as "not yet", and the only one still dimmed.
 * It is a DIFFERENT case from the three above and must not be read with them.
 *
 * What it said -- "Needs cost layers" -- names a thing that will never land.
 * FIFO cost layers are parked and superseded (ACCOUNTING-ROADMAP.md): step 2a
 * (#73) made `receive_stock` compute a moving weighted average, which IAS 2
 * permits, so there are no layers to break a valuation into and there is not
 * going to be a second valuation basis to reconcile against.
 *
 * So this is a signpost and not a door, because unlike the three above there is
 * no screen behind it: what stock is worth at cost is a figure on Inventory
 * Balance, which is a card in this same hub. A door to a screen that does not
 * exist yet is the defect this whole change is fixing.
 *
 * Outside `REPORT_VIEWS` for the same reason the three above are: it is not a
 * report this hub routes to, and leaving it in that list made `available` mean
 * two things at once.
 */
export const VALUATION_CARD = {
  key: 'valuation' as const,
  label: 'Inventory Valuation',
  blurb:
    'Stock is valued at a moving weighted average cost, not in layers — so what it is worth is a figure on Inventory Balance rather than a report of its own.',
  group: 'Financial statements',
  icon: 'scale-outline' as keyof typeof Ionicons.glyphMap,
  // Not "Not yet". The basis is decided and shipped; naming it is the useful
  // thing this card can say, and it stays true after Inventory Balance lands.
  scope: 'Weighted average',
  action: '',
  available: false,
  waitingOn: 'See Inventory Balance',
  followsRange: false,
  requires: null as Permission | null,
};

/**
 * The existing Reports tab, which this hub is placed in front of rather than
 * on top of.
 *
 * It is a card, because a route nothing links to is a deleted screen with extra
 * steps -- and what it holds is a sales-tax summary and a labour ratio that
 * nothing else in the app shows. Its profit and loss is no longer the only one
 * (the ledger's shipped in 3a, and `LEDGER_STATEMENT_CARDS` above opens it),
 * but the two are not the same number and its blurb says which is which: this
 * one reads sales and expenses directly, the ledger's reads posted entries.
 *
 * It is deliberately NOT in `REPORT_VIEWS`: that list is the reports this hub
 * routes to and its `available` set is pinned to the seven built here. An
 * eighth available key in it would mean a card whose report does not exist.
 */
export const STATEMENTS_CARD = {
  key: 'statements' as const,
  label: 'P&L, tax and labour',
  blurb: 'The Reports tab this hub replaced. It reads sales and expenses directly, not the ledger.',
  group: 'Until the ledger takes over',
  icon: 'document-text-outline' as keyof typeof Ionicons.glyphMap,
  scope: '7 days',
  action: 'Open',
  available: true,
  waitingOn: '',
  followsRange: true,
  requires: null as Permission | null,
};

/** The hub's own title row. It is not one of its own cards. */
export const HUB_META = {
  label: 'Reports',
  blurb: 'Sales, stock and the statements — everything the shop can be asked about.',
};

/**
 * Where pressing a card lands. Three of this hub's cards do not open a screen
 * on this hub at all, so the render loop cannot infer the destination from the
 * key -- it has to be told, and told in a shape tsc can check.
 *
 * Null is a card with no door: it renders dimmed with its reason in place of
 * the action pill, and gets no press target at all rather than one that
 * refuses. A door is present exactly when `available` is true.
 */
type CardDoor = { tab: 'reports'; view: ReportView } | { tab: 'accounting'; view: LedgerView } | null;

type HubCard = {
  key: string;
  label: string;
  blurb: string;
  group: string;
  icon: keyof typeof Ionicons.glyphMap;
  scope: string;
  action: string;
  available: boolean;
  waitingOn: string;
  followsRange: boolean;
  requires: Permission | null;
  door: CardDoor;
};

/**
 * Every card the hub renders, in the order it renders them. Group headings are
 * created by first appearance, so this order is also the order of the bands:
 * Sales, Inventory, Financial statements, and the tab this hub replaced.
 */
const HUB_CARDS: HubCard[] = [
  ...REPORT_VIEWS.map((v) => ({ ...v, door: { tab: 'reports' as const, view: v.key } })),
  ...LEDGER_STATEMENT_CARDS.map((v) => ({ ...v, door: { tab: 'accounting' as const, view: v.key } })),
  // Last in its band on purpose: three doors, then the one card explaining why
  // there is no fourth.
  { ...VALUATION_CARD, door: null },
  { ...STATEMENTS_CARD, door: { tab: 'reports' as const, view: STATEMENTS_CARD.key } },
];

/**
 * True for anything the reports shell can route to: the hub, the seven
 * catalogued reports, and the legacy statements view. Anything else -- including
 * a ledger view that arrived on `?view=` while the Reports tab is open --
 * resolves to the hub rather than to a blank body.
 */
export function isReportView(raw: string | undefined): raw is ReportView {
  return raw === 'hub' || raw === 'statements' || REPORT_VIEWS.some((v) => v.key === raw);
}

/** The title row's label and blurb for a report view, hub included. */
export function reportViewMeta(view: ReportView): { label: string; blurb: string } {
  if (view === 'hub') return HUB_META;
  const found = view === 'statements' ? STATEMENTS_CARD : REPORT_VIEWS.find((v) => v.key === view);
  return { label: found?.label ?? HUB_META.label, blurb: found?.blurb ?? HUB_META.blurb };
}

/**
 * The cards this user may actually open, on the same rule the ledger hub uses:
 * a card whose door refuses them is dropped, not greyed, because the hub's only
 * greying already means "no data yet" and one appearance cannot mean two
 * things. None of the seven reports is gated -- they read tables under RLS --
 * and the three ledger statements all are, because their RPCs raise.
 */
export function visibleReportViews(can: (permission: Permission) => boolean): typeof HUB_CARDS {
  return HUB_CARDS.filter((view) => view.requires === null || can(view.requires));
}

export function ReportsHub({
  onOpen,
  onOpenLedgerView,
  rangeLabel,
  can,
}: {
  onOpen: (view: ReportView) => void;
  /**
   * Opens a screen on the ACCOUNTING tab, switching tab and view together. A
   * second callback rather than a smarter `onOpen`, because the two are not the
   * same act: one moves within a hub, the other leaves it, and only the shell
   * knows how to change tabs.
   */
  onOpenLedgerView: (view: LedgerView) => void;
  /**
   * What the shell's date picker is actually set to, e.g. "7 days" or
   * "1–14 Aug". Null before the picker has reported, which is why every card
   * carries a static `scope` to fall back on.
   */
  rangeLabel: string | null;
  /**
   * From the shell's useAuth, passed rather than read here: this module is
   * imported by the nav test, and reaching for the auth context would drag the
   * Supabase client in behind it and make the catalogue untestable.
   */
  can: (permission: Permission) => boolean;
}) {
  const groups = visibleReportViews(can).reduce<Record<string, typeof HUB_CARDS>>((acc, view) => {
    acc[view.group] = [...(acc[view.group] ?? []), view];
    return acc;
  }, {});

  const openDoor = (door: NonNullable<CardDoor>) =>
    door.tab === 'accounting' ? onOpenLedgerView(door.view) : onOpen(door.view);

  return (
    <View style={styles.wrap}>
      {Object.entries(groups).map(([group, views]) => (
        <View key={group}>
          <Text style={styles.group}>
            {group}
            {/* The design puts the reason on the heading as well as the cards,
                so a reader who skims the headings still learns that a whole
                band of the hub is waiting rather than broken. READ OFF THE
                CARDS, not written here: the hardcoded version said "waiting on
                the posting phase" and outlived the posting phase by two
                releases. No band is uniformly waiting today, so it renders on
                none of them. */}
            {views.every((v) => !v.available) && <Text style={styles.groupNote}> — {views[0].waitingOn}</Text>}
          </Text>
          {/* BentoGrid, not a flex-wrap row: a wrapping row gives every card
              flexGrow, so a group holding one card stretches it across the
              whole band. A cell takes its span and no more. */}
          {/* `stretch` + `fill` on the Card, NOT `height: '100%'` on the
              card's style. That was the original, copied from ledger-hub, and
              on iPhone it made every card a viewport tall with the rest of the
              hub pushed below the fold -- the exact failure bento.tsx's own
              comment on `cellInnerFill` documents: Yoga resolves a percentage
              height against the owner height, and inside a ScrollView that
              chain ends at the ScrollView's frame. It is invisible on web,
              where CSS resolves the same percentage to `auto`, which is why
              the browser pass did not catch it. */}
          <BentoGrid rowAlign="stretch">
            {views.map((view) => {
              const scope = view.followsRange ? (rangeLabel ?? view.scope) : view.scope;
              // Pulled out of the JSX so tsc narrows it: `view.door` is a
              // property access and narrowing would be lost inside the arrow.
              const door = view.door;
              const card = (
                <Card variant="bento" fill style={!view.available && styles.cardDimmed}>
                  <View style={styles.iconTile}>
                    <Ionicons name={view.icon} size={15} color={theme.bentoInk2} />
                  </View>
                  <Text style={styles.title}>{view.label}</Text>
                  <Text style={styles.blurb}>{view.blurb}</Text>
                  <View style={styles.footer}>
                    <Text style={styles.scope} numberOfLines={1}>
                      {scope}
                    </Text>
                    {view.available ? (
                      <View style={styles.action}>
                        <Text style={styles.actionText}>{view.action}</Text>
                      </View>
                    ) : (
                      // No pill, because a pill reads as a button and there is
                      // nothing to press. The reason takes the button's place.
                      <Text style={styles.waitingOn} numberOfLines={1}>
                        {view.waitingOn}
                      </Text>
                    )}
                  </View>
                </Card>
              );
              return (
                <BentoCell key={view.key} span={3}>
                  {door ? (
                    <Pressable style={styles.cell} onPress={() => openDoor(door)} role="button">
                      {card}
                    </Pressable>
                  ) : (
                    // Deliberately not a disabled Pressable: a press target that
                    // refuses reads as a broken card. There is no target at all.
                    <View style={styles.cell}>{card}</View>
                  )}
                </BentoCell>
              );
            })}
          </BentoGrid>
        </View>
      ))}

      {/* `context`, not `wrong`: nothing here is broken and nothing here needs
          fixing. It explains why one band of cards leaves the tab and why the
          last one does not open at all. */}
      <Caveat tone="context">
        The three statements read the ledger rather than the sales tables, so they live on the Accounting
        tab — these cards open them there, for the same dates you picked here. Inventory Valuation is the
        one card that opens nothing: stock is valued at a moving weighted average cost, so what it is worth
        is a figure on Inventory Balance rather than a report of its own.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 18 },
  group: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk, marginBottom: 10 },
  groupNote: { fontSize: 11.5, fontWeight: '500', color: theme.bentoMuted },
  cell: { width: '100%' },
  // The design's `.hubcard.soon { opacity:.5 }`. Half-strength rather than a
  // different fill, so it reads as "not yet" rather than as a fifth card style.
  cardDimmed: { opacity: 0.5 },
  iconTile: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: theme.bentoSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  title: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk },
  blurb: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 4, lineHeight: 16 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 14 },
  scope: { fontSize: 11, color: theme.bentoMuted2, flexShrink: 1 },
  action: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.bentoSoft },
  actionText: { fontSize: 11.5, fontWeight: '800', color: theme.bentoInk2 },
  waitingOn: { fontSize: 11.5, fontWeight: '800', color: theme.bentoMuted2, flexShrink: 1 },
});
