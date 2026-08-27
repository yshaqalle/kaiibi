import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

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
  // The four that are cards and nothing else, until their data exists.
  | 'pl'
  | 'balancesheet'
  | 'cashflow'
  | 'valuation'
  // Not a card and not one of the eleven -- see STATEMENTS_CARD below.
  | 'statements';

/**
 * The catalogue, in one place, for the same four readers `LEDGER_VIEWS` has:
 * the hub's cards, the shell's title row, the shell's "is this a view I know"
 * guard, and the nav test.
 *
 * `available` is the whole point of this list. Four of the eleven cards on the
 * design have no data behind them, and the design's decision -- which this
 * ships verbatim -- is that they render dimmed, saying what they wait for,
 * rather than being hidden. They are the only place in the app that answers
 * "why is there no balance sheet here?", and deleting them only moves that
 * question to support.
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
 * The hub itself is NOT in here, unlike `LEDGER_VIEWS`, and cannot be: every
 * entry is either available (and so a report that exists) or unavailable (and
 * so owes a `waitingOn` the card renders), and the hub is neither. Its title
 * row reads out of `HUB_META` instead.
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
  {
    key: 'pl',
    label: 'Profit & Loss',
    blurb: 'Available once sales and bills post to the ledger.',
    group: 'Financial statements',
    icon: 'cash-outline',
    scope: 'Not yet',
    action: '',
    available: false,
    waitingOn: 'Needs the posting phase',
    followsRange: false,
    requires: null,
  },
  {
    key: 'balancesheet',
    label: 'Balance Sheet',
    blurb: 'Available once sales and bills post to the ledger.',
    group: 'Financial statements',
    icon: 'business-outline',
    scope: 'Not yet',
    action: '',
    available: false,
    waitingOn: 'Needs the posting phase',
    followsRange: false,
    requires: null,
  },
  {
    key: 'cashflow',
    label: 'Cash Flow',
    blurb: 'Available once sales and bills post to the ledger.',
    group: 'Financial statements',
    icon: 'water-outline',
    scope: 'Not yet',
    action: '',
    available: false,
    waitingOn: 'Needs the posting phase',
    followsRange: false,
    requires: null,
  },
  {
    key: 'valuation',
    label: 'Inventory Valuation',
    blurb: 'Available once cost layers land.',
    group: 'Financial statements',
    icon: 'scale-outline',
    scope: 'Not yet',
    action: '',
    available: false,
    waitingOn: 'Needs cost layers',
    followsRange: false,
    requires: null,
  },
];

/**
 * The existing Reports tab, which this hub is placed in front of rather than
 * on top of.
 *
 * It is a card, because a route nothing links to is a deleted screen with extra
 * steps -- and what it holds is a working profit and loss, a sales-tax summary
 * and a labour ratio that the four dimmed cards above cannot show yet. Taking
 * that away to replace it with a card saying "not yet" is the one outcome this
 * phase must not produce.
 *
 * It is deliberately NOT in `REPORT_VIEWS`: that list is the eleven cards the
 * design draws, and its `available` set is pinned to the seven built here. An
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

/** Every card the hub renders, in the order it renders them. */
const HUB_CARDS = [...REPORT_VIEWS, STATEMENTS_CARD];

/**
 * True for anything the reports shell can route to: the hub, the eleven
 * catalogued views, and the legacy statements view. Anything else resolves to
 * the hub rather than to a blank body.
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
 * things. Nothing here is gated today -- see `requires` above.
 */
export function visibleReportViews(can: (permission: Permission) => boolean): typeof HUB_CARDS {
  return HUB_CARDS.filter((view) => view.requires === null || can(view.requires));
}

export function ReportsHub({
  onOpen,
  rangeLabel,
  can,
}: {
  onOpen: (view: ReportView) => void;
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

  return (
    <View style={styles.wrap}>
      {Object.entries(groups).map(([group, views]) => (
        <View key={group}>
          <Text style={styles.group}>
            {group}
            {/* The design puts the reason on the heading as well as the cards,
                so a reader who skims the headings still learns that a whole
                band of the hub is waiting rather than broken. */}
            {views.every((v) => !v.available) && <Text style={styles.groupNote}> — waiting on the posting phase</Text>}
          </Text>
          {/* BentoGrid, not a flex-wrap row: a wrapping row gives every card
              flexGrow, so a group holding one card stretches it across the
              whole band. A cell takes its span and no more. */}
          <BentoGrid>
            {views.map((view) => {
              const scope = view.followsRange ? (rangeLabel ?? view.scope) : view.scope;
              const card = (
                <Card variant="bento" style={[styles.card, !view.available && styles.cardDimmed]}>
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
                  {view.available ? (
                    <Pressable style={styles.cell} onPress={() => onOpen(view.key)} role="button">
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

      <Caveat tone="context">
        The dimmed cards are deliberate. They say what they are waiting for rather than opening an empty
        screen — and they are the only place in the app that explains why a statement is missing. Delete
        them and the question just moves to support.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 18 },
  group: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk, marginBottom: 10 },
  groupNote: { fontSize: 11.5, fontWeight: '500', color: theme.bentoMuted },
  cell: { width: '100%' },
  card: { height: '100%' },
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
