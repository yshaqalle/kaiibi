import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { formatAccountingCents } from '@/lib/currency';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// One line of a financial statement.
//
// Money that reconciles is READ DOWN A COLUMN, not scanned as cards, so this
// deliberately looks like a statement rather than a dashboard tile: figures
// right-aligned and tabular so digits stack, a hairline above a subtotal, a
// heavier rule above the final total.
//
// The `hint` is not decoration. It carries the DEFINITION of the figure —
// "net of sales tax and refunds", "excludes stock purchases and owner draws" —
// which is exactly where an argument about a number starts. Accounting's code
// is already careful to say these things; this makes the UI say them too.
//
// Generalised from reports-tab.tsx's local PnlRow so the P&L, the sales-tax
// block, labour and the payroll totals stop each having their own version.

export type StatementVariant =
  /** A plain line item. */
  | 'item'
  /** Indented, quieter — a breakdown of the line above it. */
  | 'sub'
  /** A subtotal: hairline above, heavier text. */
  | 'emphasis'
  /** The bottom line: strong rule above, largest figure on the card. */
  | 'total';

export function StatementRow({
  label,
  hint,
  amountCents,
  /** Overrides the formatted amount — for a count, a percentage, a dash. */
  value,
  variant = 'item',
  /** Tints the figure green when positive is good and it is. Totals only. */
  tone,
  /**
   * Last row of its group — drops the trailing hairline.
   *
   * Rows are loose siblings rather than a list, so nothing can work out on its
   * own that it is last, and a rule hanging under the final row with only card
   * padding beneath it reads as a group that got cut off. `total` never needs
   * this: it is a filled panel and carries no rule either way.
   */
  last = false,
}: {
  label: string;
  hint?: string;
  amountCents?: number;
  value?: string;
  variant?: StatementVariant;
  tone?: 'default' | 'positive';
  last?: boolean;
}) {
  const text = value ?? (amountCents === undefined ? '' : formatAccountingCents(amountCents));
  const negative = amountCents !== undefined && amountCents < 0;
  // The bottom line is always coloured — green when the shop made money, red
  // when it lost it. Everywhere else colour is opt-in via `tone`, but a net
  // profit printed in plain ink is the one figure on the card a reader is
  // looking for, and it should not take a second read to see which way it went.
  // The signed figure is right there beside it, so the colour is reinforcing
  // something already stated rather than carrying it alone.
  const totalPositive = variant === 'total' && !negative;

  return (
    <View
      style={[
        styles.row,
        last && styles.rowLast,
        variant === 'emphasis' && styles.rowEmphasis,
        variant === 'total' && styles.rowTotal,
      ]}
    >
      <View style={[styles.labelWrap, variant === 'sub' && styles.labelWrapSub]}>
        <Text
          style={[
            styles.label,
            variant === 'sub' && styles.labelSub,
            (variant === 'emphasis' || variant === 'total') && styles.labelStrong,
            variant === 'total' && styles.labelTotal,
          ]}
        >
          {label}
        </Text>
        {/* Ternary, not `hint && …`: an empty string would render as a bare
            text node inside a View, which is a hard error on RN Web. */}
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>

      <Text
        style={[
          styles.amount,
          variant === 'sub' && styles.amountSub,
          (variant === 'emphasis' || variant === 'total') && styles.amountStrong,
          variant === 'total' && styles.amountTotal,
          negative && styles.amountNegative,
          (tone === 'positive' || totalPositive) && !negative && styles.amountPositive,
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // A hairline under every row, so the statement reads as ruled lines rather
  // than as floating pairs of text.
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.bentoLine,
  },
  rowLast: { borderBottomWidth: 0 },
  // `bentoRule`, not `bentoLine`: a subtotal's rule has to be legible AS a
  // stronger line than the ones dividing the items above it, or the two read
  // as the same kind of break and the subtotal stops looking like one.
  rowEmphasis: { borderTopWidth: 1, borderTopColor: theme.bentoRule, paddingTop: 12 },
  // A filled panel, not a rule. The bottom line is the one figure a reader
  // came to the card for, and a heavy black rule above it was doing the job by
  // shouting — it read as a divider between two halves of the card rather than
  // as the card's conclusion. The soft fill separates it without adding weight,
  // and it needs no rules of its own.
  rowTotal: {
    borderTopWidth: 0,
    borderBottomWidth: 0,
    backgroundColor: theme.bentoSoft,
    borderRadius: 14,
    marginTop: 8,
    paddingVertical: 13,
    paddingHorizontal: 16,
  },

  labelWrap: { flex: 1, minWidth: 0 },
  labelWrapSub: { paddingLeft: 16 },
  label: { fontSize: 13.5, fontWeight: '600', color: theme.bentoInk },
  labelSub: { color: theme.bentoMuted },
  labelStrong: { fontWeight: '800' },
  labelTotal: { fontSize: 14.5 },
  hint: { fontSize: 11, fontWeight: '400', color: theme.bentoMuted, marginTop: 2, lineHeight: 15 },

  amount: {
    fontSize: 15,
    fontWeight: '800',
    color: theme.bentoInk,
    // Digits line up down the column. Ignored on native, honoured on web,
    // which is where these tables are actually read side by side.
    fontVariant: ['tabular-nums'],
  },
  amountSub: { fontWeight: '600', color: theme.bentoMuted },
  amountStrong: { fontWeight: '800' },
  amountTotal: { fontSize: 19, letterSpacing: -0.4 },
  amountNegative: { color: theme.bentoLoss },
  amountPositive: { color: theme.bentoProfit },
});
