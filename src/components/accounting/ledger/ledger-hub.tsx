import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { Colors } from '@/constants/theme';
import type { Permission } from '@/lib/permissions';

const theme = Colors.light;

export type LedgerView =
  | 'hub'
  | 'accounts'
  | 'entry'
  | 'journals'
  | 'trial'
  | 'audit'
  | 'backfill'
  | 'income'
  | 'balance'
  | 'cashflow';

// The catalogue, in one place, because four things read it: the hub's cards,
// the shell's title row, the shell's "is this a view I know" guard, and the nav
// test. Four copies of a list of six is how a seventh gets added to two.
//
// `group` is what the hub renders as a heading. A view with no group would
// appear nowhere and be reachable only by typing the URL.
//
// `scope` and `action` are the card's footer row. The scope is the part that
// carries meaning rather than polish: Trial Balance is "as of today" and
// Journals is "7 days", and a reader who does not know which is which will
// misread one of them. A card whose action CREATES something gets the filled
// button and a plus; a card you only read gets the quiet one.
//
// `requires` is the permission the card's own door needs. Null means the tab's
// own gate is the whole gate. It exists for the cards whose RPC REFUSES rather
// than returning nothing:
//
//   * Post History      backfill_shop_ledger raises without ledger.close.
//   * the three
//     statements        statement_lines(), balance_sheet() and cash_flow() are
//                       security definer and RAISE P0001 without ledger.view.
//
// That distinction is the whole rule, and it is worth stating because the six
// older cards look like counter-examples and are not. Chart of Accounts,
// Journals, the Trial Balance and the Audit Log read TABLES under RLS: a reader
// without ledger.view gets an empty result and an honest empty state. The three
// statements are the first screens in Accounting whose door raises.
//
// /accounting itself is gated on `sales.view` (permissions.ts), and the SEEDED
// Manager role holds sales.view and not ledger.view -- so this is not a corner
// case, it is the default second role in every shop on day one. A card that
// opens a screen saying "you do not have permission" is worse than a card that
// is not offered.
//
// The screens still handle the refusal themselves. This gate stops an honest
// reader reaching a dead end; it is not the enforcement, and it cannot be --
// the view is reachable by its ?view= parameter and a role can change while a
// session is open.
export const LEDGER_VIEWS: {
  key: LedgerView;
  label: string;
  blurb: string;
  group: string | null;
  icon: keyof typeof Ionicons.glyphMap;
  scope: string;
  action: string;
  creates: boolean;
  requires: Permission | null;
}[] = [
  {
    key: 'hub',
    label: 'Accounting',
    blurb: 'The books themselves — accounts, entries and the trail behind them.',
    group: null,
    icon: 'book-outline',
    scope: '',
    action: '',
    creates: false,
    requires: null,
  },
  {
    key: 'accounts',
    label: 'Chart of Accounts',
    blurb: 'Assets, liabilities, equity, revenue and expense accounts.',
    group: 'Ledger and journals',
    icon: 'list-outline',
    scope: 'As of today',
    action: 'View accounts',
    creates: false,
    requires: null,
  },
  {
    key: 'entry',
    label: 'General Journal Entry',
    blurb: 'Post a manual debit/credit entry to the ledger.',
    group: 'Ledger and journals',
    icon: 'create-outline',
    scope: 'Manual entry',
    action: '+ New entry',
    creates: true,
    requires: null,
  },
  {
    key: 'journals',
    label: 'Journals',
    blurb: 'Every journal entry recorded, in order.',
    group: 'Ledger and journals',
    icon: 'reader-outline',
    scope: '7 days',
    action: 'View list',
    creates: false,
    requires: null,
  },
  {
    key: 'trial',
    label: 'Trial Balance',
    blurb: "Every account's debit and credit balance, side by side.",
    group: 'Ledger and journals',
    icon: 'swap-horizontal-outline',
    scope: 'As of today',
    action: 'Run report',
    creates: false,
    requires: null,
  },
  {
    key: 'backfill',
    label: 'Post History',
    blurb: 'Replay past sales, refunds, deliveries and bills into the ledger.',
    group: 'Ledger and journals',
    icon: 'refresh-outline',
    // The static fallback, shown while the live count is still null. Never a
    // guessed "0 unposted" -- a shop with two years of trading outside the
    // books would read that as "nothing to do" and close the card.
    scope: 'Past trading',
    action: '+ Post history',
    // It writes to the books, so it takes the solid button beside General
    // Journal Entry. Reading a report and rewriting a shop's history must not
    // look like the same act.
    creates: true,
    // The same permission backfill_shop_ledger itself demands. ledger.post is
    // NOT enough: replaying a whole history is heavier than posting one entry,
    // and the RPC says so in its own first ten lines.
    requires: 'ledger.close',
  },
  // The three statements, in the group the design names them in. They share one
  // ledger, so the profit on the income statement, the profit-this-period line
  // on the balance sheet and the opening line of the cash flow are guaranteed
  // to agree -- each of the latter two CALLS statement_lines() rather than
  // re-deriving it.
  {
    key: 'income',
    label: 'Income Statement',
    blurb: 'Revenue, cost of sales and expenses, down to net profit.',
    group: 'Financial statements',
    icon: 'trending-up-outline',
    // "The chosen range", not "7 days". Seven days is only the range
    // selector's OPENING preset -- it also offers 30 days and a custom pair of
    // dates, and the screen follows whichever is chosen. A card that promises
    // a window the screen does not honour is a card that will be believed.
    scope: 'The chosen range',
    action: 'Run report',
    creates: false,
    requires: 'ledger.view',
  },
  {
    key: 'balance',
    // A balance sheet is a POSITION read at an instant -- there is no such
    // thing as one for the last seven days -- and the card has to say so,
    // because a reader who assumes it follows the range will misread it. But
    // the instant is the range's END, not today: pick a custom window ending
    // last month and the sheet is as at last month. It said "As of today",
    // which was true only of the default.
    label: 'Balance Sheet',
    blurb: "What the shop owns, what it owes, and what's left over.",
    group: 'Financial statements',
    icon: 'scale-outline',
    scope: 'As at the range end',
    action: 'Run report',
    creates: false,
    requires: 'ledger.view',
  },
  {
    key: 'cashflow',
    label: 'Cash Flow',
    blurb: 'Where cash actually came from and went. Profit and cash are not the same thing.',
    group: 'Financial statements',
    icon: 'water-outline',
    scope: 'The chosen range',
    action: 'Run report',
    creates: false,
    requires: 'ledger.view',
  },
  {
    key: 'audit',
    label: 'Audit Log',
    blurb: 'Who changed what, and when.',
    group: 'Oversight',
    icon: 'time-outline',
    scope: 'All time',
    action: 'View log',
    creates: false,
    requires: null,
  },
];

/**
 * The cards this user may actually open.
 *
 * A card whose door refuses them is dropped, not greyed. The hub has no
 * vocabulary for a locked card, and inventing one would ask "why can't I?" on
 * every visit while answering nothing. The permission is still enforced in the
 * database -- this only stops an honest reader reaching a button that raises.
 *
 * Dropping a whole GROUP is possible and correct: a reader without ledger.view
 * loses all three statements, and 'Financial statements' disappears with them
 * rather than leaving an empty heading. That falls out of the grouping below,
 * which only sees the views that survive this filter.
 */
export function visibleLedgerViews(can: (permission: Permission) => boolean): typeof LEDGER_VIEWS {
  return LEDGER_VIEWS.filter((view) => view.requires === null || can(view.requires));
}

/**
 * Post History's footer, which is the one that moves.
 *
 * With rows waiting it is a create: the solid button, a plus, and the count in
 * place of a period, because "3,973 unposted" answers the same question "7
 * days" does on the card beside it. With none it goes quiet and loses the plus
 * -- opening it then creates nothing. The card stays either way, because "is
 * everything posted?" is a question worth being able to ask.
 */
export function backfillFooter(unpostedRows: number | null): { scope: string; action: string; creates: boolean } {
  // Null is "not known yet", not "none". Falls back to the static scope.
  if (unpostedRows === null) return { scope: 'Past trading', action: '+ Post history', creates: true };
  if (unpostedRows === 0) return { scope: 'Nothing unposted', action: 'Check', creates: false };
  return { scope: `${unpostedRows.toLocaleString()} unposted`, action: '+ Post history', creates: true };
}

export function LedgerHub({
  onOpen,
  accountCount,
  unpostedRows,
  can,
}: {
  onOpen: (view: LedgerView) => void;
  /** Null while the shell is still fetching. */
  accountCount: number | null;
  /** How many rows are waiting to reach the ledger. Null while unknown. */
  unpostedRows: number | null;
  /**
   * From the shell's useAuth, passed rather than read here. This module is
   * imported by the nav test, and reaching for the auth context would drag the
   * Supabase client in behind it and make the catalogue untestable without a
   * runtime — the same split ledger-math.ts draws.
   */
  can: (permission: Permission) => boolean;
}) {
  const groups = visibleLedgerViews(can)
    .filter((v) => v.group)
    .reduce<Record<string, typeof LEDGER_VIEWS>>((acc, view) => {
      const key = view.group as string;
      acc[key] = [...(acc[key] ?? []), view];
      return acc;
    }, {});

  return (
    <View style={styles.wrap}>
      {Object.entries(groups).map(([group, views]) => (
        <View key={group}>
          <Text style={styles.group}>{group}</Text>
          {/* BentoGrid, not a flex-wrap row. A wrapping row gives every card
              flexGrow, so a group holding ONE card stretched it across the
              whole band -- Audit Log rendered 1344px wide beside four 327px
              siblings. A cell takes its span and no more, however few there
              are in the row. */}
          <BentoGrid>
            {views.map((view) => {
              // The live footer where there is one, so the card says what is
              // behind it rather than only what it is. Both fall back to the
              // static scope while the count is still null, rather than
              // flashing "0 accounts" at a shop that has 31 -- or, worse,
              // "Nothing unposted" at one with two years outside its books.
              const footer =
                view.key === 'backfill'
                  ? backfillFooter(unpostedRows)
                  : {
                      scope: view.key === 'accounts' && accountCount !== null ? `${accountCount} accounts` : view.scope,
                      action: view.action,
                      creates: view.creates,
                    };
              return (
              <BentoCell key={view.key} span={3}>
              <Pressable style={styles.cell} onPress={() => onOpen(view.key)} role="button">
                <Card variant="bento" style={styles.card}>
                  <View style={styles.iconTile}>
                    <Ionicons name={view.icon} size={15} color={theme.bentoInk2} />
                  </View>
                  <Text style={styles.title}>{view.label}</Text>
                  <Text style={styles.blurb}>{view.blurb}</Text>
                  <View style={styles.footer}>
                    <Text
                      style={[styles.scope, view.key === 'backfill' && (unpostedRows ?? 0) > 0 && styles.scopeWaiting]}
                      numberOfLines={1}
                    >
                      {footer.scope}
                    </Text>
                    <View style={[styles.action, footer.creates && styles.actionSolid]}>
                      <Text style={[styles.actionText, footer.creates && styles.actionTextSolid]}>{footer.action}</Text>
                    </View>
                  </View>
                </Card>
              </Pressable>
              </BentoCell>
              );
            })}
          </BentoGrid>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 18 },
  group: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk, marginBottom: 10 },
  // The cell owns the width now -- span={3} is a quarter of the band, widened
  // to a third, a half and then the full row as the screen narrows, which is
  // BentoCell's own rule. The Pressable just fills whatever it is given.
  cell: { width: '100%' },
  // The Pressable owns the width, the Card owns the surface. Full height so
  // cards in a row line up when one blurb wraps to three lines and another
  // takes two.
  card: { height: '100%' },
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
  // Only while something is actually waiting, and only on Post History. A shop
  // that has never backfilled is in a normal state rather than an alarming one,
  // so this is emphasis on a fact, not a warning.
  scopeWaiting: { color: theme.warning, fontWeight: '800' },
  action: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.bentoSoft },
  actionSolid: { backgroundColor: theme.bentoInk },
  actionText: { fontSize: 11.5, fontWeight: '800', color: theme.bentoInk2 },
  actionTextSolid: { color: theme.bentoSurface },
});
