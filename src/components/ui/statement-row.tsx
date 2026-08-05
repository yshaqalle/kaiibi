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
}: {
  label: string;
  hint?: string;
  amountCents?: number;
  value?: string;
  variant?: StatementVariant;
  tone?: 'default' | 'positive';
}) {
  const text = value ?? (amountCents === undefined ? '' : formatAccountingCents(amountCents));
  const negative = amountCents !== undefined && amountCents < 0;

  return (
    <View
      style={[
        styles.row,
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
          tone === 'positive' && !negative && styles.amountPositive,
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, paddingVertical: 9 },
  rowEmphasis: { borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 11 },
  // 2px and the text colour rather than the border colour: the bottom line of
  // a statement should read as a rule under everything above it, not as one
  // more divider.
  rowTotal: { borderTopWidth: 2, borderTopColor: theme.text, marginTop: 4, paddingTop: 12 },

  labelWrap: { flex: 1, minWidth: 0 },
  labelWrapSub: { paddingLeft: 16 },
  label: { fontSize: 13, color: theme.text },
  labelSub: { color: theme.textSecondary },
  labelStrong: { fontWeight: '800' },
  labelTotal: { fontSize: 14 },
  hint: { fontSize: 11, color: theme.textSecondary, marginTop: 2, lineHeight: 15 },

  amount: {
    fontSize: 13.5,
    fontWeight: '700',
    color: theme.text,
    // Digits line up down the column. Ignored on native, honoured on web,
    // which is where these tables are actually read side by side.
    fontVariant: ['tabular-nums'],
  },
  amountSub: { fontWeight: '600', color: theme.textSecondary },
  amountStrong: { fontWeight: '800' },
  amountTotal: { fontSize: 19, letterSpacing: -0.5 },
  amountNegative: { color: theme.danger },
  amountPositive: { color: theme.success },
});
