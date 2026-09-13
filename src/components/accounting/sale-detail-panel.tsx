import { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { refundedQtyFor } from '@/components/refund-modal';
import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { lineDiscount, type SaleDiscountSummary } from '@/lib/sale-discounts';
import { type saleProfit } from '@/lib/sales-reporting';
import type { Sale } from '@/types/models';

const theme = Colors.light;

// An opened sale in Accounting → Transactions.
//
// The old pane was one column of identical grey capitals over a label on the
// far left and a value on the far right -- 1,900px apart on a desktop, so
// "Profit" and "$3.71" had to be matched by eye across the screen. Now: who and
// the actions first, four tiles for the figures a reader checks before
// anything else, then three narrow cards so every number sits beside its label.
// See docs/design/transaction-detail-redesign-mockup.html.

type Profit = ReturnType<typeof saleProfit>;

const paymentLabels: Record<string, string> = { cash: 'Cash', zaad: 'ZAAD', edahab: 'e-Dahab', other: 'Other', unpaid: 'Unpaid' };
const paymentLabel = (method: string): string => paymentLabels[method] ?? method;

function Tile({ label, value, hint, tone = 'default' }: { label: string; value: string; hint: string; tone?: 'default' | 'blue' | 'good' | 'bad' | 'dim' }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, TILE_TONE[tone]]} numberOfLines={1}>{value}</Text>
      <Text style={styles.tileHint} numberOfLines={2}>{hint}</Text>
    </View>
  );
}

function Line({ label, hint, value, tone, rule, total }: { label: string; hint?: string | null; value: string; tone?: 'blue' | 'bad' | 'good'; rule?: boolean; total?: boolean }) {
  return (
    <View style={[styles.line, rule && styles.lineRule, total && styles.lineTotal]}>
      <Text style={[styles.lineKey, total && styles.lineTotalText]}>
        {label}
        {hint ? <Text style={styles.lineHint}>{`  ${hint}`}</Text> : null}
      </Text>
      <Text style={[styles.lineValue, total && styles.lineTotalText, tone && LINE_TONE[tone]]}>{value}</Text>
    </View>
  );
}

export function SaleDetailPanel({
  sale,
  compact,
  discounts,
  profit,
  storeName,
  actions,
  footer,
}: {
  sale: Sale;
  compact: boolean;
  discounts: SaleDiscountSummary;
  profit: Profit;
  // Only when the shop has more than one store -- a single-store shop has
  // nothing to tell apart.
  storeName: string | null;
  actions: ReactNode;
  footer?: ReactNode;
}) {
  const payments = sale.payments ?? [];
  const refunds = sale.refunds ?? [];
  const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
  const owedCents = Math.max(0, sale.totalCents - paidCents);
  const refundedCents = refunds.reduce((sum, r) => sum + r.totalCents, 0);
  const methods = [...new Set(payments.map((p) => paymentLabel(p.method)))].join(' + ') || 'Nothing paid yet';
  const unitCount = (sale.items ?? []).reduce((sum, item) => sum + item.quantity, 0);
  const lineCount = sale.items?.length ?? 0;
  const hasCustomer = Boolean(sale.customerName || sale.customerPhone || sale.customerEmail);
  const marginWidth = profit.marginPercent === null ? 0 : Math.max(0, Math.min(100, profit.marginPercent));

  const paidHint = refundedCents > 0
    ? `${methods} · kept ${formatCents(profit.keptCents)} after refund`
    : owedCents > 0
      ? `${methods} · ${formatCents(owedCents)} still owed`
      : `${methods} · in full`;

  const offHint = discounts.totalOffCents > 0
    ? [discounts.totalOffPercent, discounts.onlyPromotion ?? (discounts.saleDiscountCents > 0 && discounts.itemDiscountCents === 0 ? 'sale discount' : null)].filter(Boolean).join(' · ')
    : 'no discount';

  const taxHint = sale.taxCents > 0
    ? `${sale.taxRatePercent !== null ? `${sale.taxRatePercent}% · ` : ''}${discounts.taxIncluded ? 'included in the price' : 'added on top'}`
    : 'no tax';

  const profitHint = [
    profit.marginPercent !== null ? `${profit.marginPercent.toFixed(0)}% margin` : null,
    refundedCents > 0 ? 'after refund' : null,
    profit.uncostedItemCount > 0 ? 'at most — cost missing' : null,
  ].filter(Boolean).join(' · ') || '—';

  const itemsCard = (
    <View style={[styles.box, !compact && styles.itemsCol]}>
      <View style={styles.boxHead}>
        <Text style={styles.boxTitle}>Items</Text>
        <Text style={styles.boxMeta}>{lineCount} line{lineCount === 1 ? '' : 's'} · {unitCount} unit{unitCount === 1 ? '' : 's'}</Text>
      </View>
      {!compact && (
        <View style={[styles.itemRow, styles.itemHeadRow]}>
          <Text style={[styles.itemHead, { width: 30 }]} />
          <Text style={[styles.itemHead, { flex: 1 }]}>ITEM</Text>
          <Text style={[styles.itemHead, styles.moneyCol]}>LIST</Text>
          <Text style={[styles.itemHead, styles.moneyCol]}>OFF</Text>
          <Text style={[styles.itemHead, styles.moneyCol]}>PAID</Text>
        </View>
      )}
      {sale.items?.map((item) => {
        const refundedQty = refundedQtyFor(sale, item.id);
        const line = lineDiscount(item, sale.cashierName);
        const back = refundedQty > 0 ? (
          <View style={styles.backPill}><Text style={styles.backPillText}>{refundedQty} back</Text></View>
        ) : null;
        if (compact) {
          return (
            <View key={item.id} style={styles.stackItem}>
              <View style={styles.stackTop}>
                <Text style={styles.qty}>{item.quantity}×</Text>
                <Text style={[styles.itemName, { flex: 1 }]} numberOfLines={2}>{item.productName}</Text>
                {back}
                <Text style={styles.paid}>{formatCents(line.paidCents)}</Text>
              </View>
              <View style={styles.stackTop}>
                <Text style={[styles.sub, { flex: 1 }]}>
                  {line.offCents > 0 ? `List ${formatCents(line.listCents)} · ${line.reason}` : `${formatCents(item.unitPriceCents)} each`}
                </Text>
                {line.offCents > 0 && <Text style={styles.off}>−{formatCents(line.offCents)}{line.percent ? ` · ${line.percent}` : ''}</Text>}
              </View>
            </View>
          );
        }
        return (
          <View key={item.id} style={styles.itemRow}>
            <Text style={[styles.qty, { width: 30 }]}>{item.quantity}×</Text>
            <View style={{ flex: 1, marginRight: 8 }}>
              <View style={styles.nameRow}>
                <Text style={styles.itemName} numberOfLines={2}>{item.productName}</Text>
                {back}
              </View>
              <Text style={styles.sub}>{formatCents(item.unitPriceCents)} each{line.reason ? ` · ${line.reason}` : ''}</Text>
            </View>
            <Text style={[styles.moneyCol, styles.list]}>{formatCents(line.listCents)}</Text>
            <View style={styles.moneyCol}>
              {line.offCents > 0 ? (
                <>
                  <Text style={[styles.off, styles.right]}>−{formatCents(line.offCents)}</Text>
                  {line.percent ? <Text style={[styles.sub, styles.right]}>{line.percent}</Text> : null}
                </>
              ) : (
                <Text style={[styles.none, styles.right]}>—</Text>
              )}
            </View>
            <Text style={[styles.moneyCol, styles.paid]}>{formatCents(line.paidCents)}</Text>
          </View>
        );
      })}
    </View>
  );

  const moneyCard = (
    <View style={[styles.box, !compact && styles.sideCol]}>
      <View style={styles.boxHead}><Text style={styles.boxTitle}>Money</Text></View>
      <Line label="Items at list price" value={formatCents(discounts.listCents)} />
      {discounts.itemDiscountCents > 0 && (
        <Line
          label="Item discounts"
          hint={[discounts.itemDiscountPercent, `${discounts.discountedItemCount} item${discounts.discountedItemCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
          value={`−${formatCents(discounts.itemDiscountCents)}`}
          tone="blue"
        />
      )}
      {discounts.saleDiscountCents > 0 && (
        <Line
          label="Sale discount"
          hint={discounts.saleDiscountPercent ? `${discounts.saleDiscountPercent} of ${formatCents(discounts.listCents - discounts.itemDiscountCents)}` : null}
          value={`−${formatCents(discounts.saleDiscountCents)}`}
          tone="blue"
        />
      )}
      {discounts.pointsRedeemedCents > 0 && <Line label="Points redeemed" value={`−${formatCents(discounts.pointsRedeemedCents)}`} />}
      {(discounts.totalOffCents > 0 || discounts.pointsRedeemedCents > 0) && sale.taxCents > 0 && !discounts.taxIncluded && (
        <Line label="Subtotal" value={formatCents(discounts.subtotalCents)} rule />
      )}
      {sale.taxCents > 0 && !discounts.taxIncluded && (
        <Line label="Tax" hint={sale.taxRatePercent !== null ? `${sale.taxRatePercent}%` : null} value={formatCents(sale.taxCents)} />
      )}
      <Line label="Total" value={formatCents(sale.totalCents)} total />
      {/* Tax already inside the price is named under the total, not added
          above it -- "$12.00 + $0.29 = $12.00" was the sum this replaced. */}
      {sale.taxCents > 0 && discounts.taxIncluded && (
        <Text style={styles.includes}>includes {formatCents(sale.taxCents)} tax{sale.taxRatePercent !== null ? ` (${sale.taxRatePercent}%)` : ''}</Text>
      )}

      {payments.map((payment, index) => (
        <View key={payment.id}>
          <Line
            label={`${paymentLabel(payment.method)}${payment.isSettlement ? ' · balance paid' : ''}`}
            hint={payment.customerName ?? null}
            value={formatCents(payment.amountCents)}
            rule={index === 0}
          />
          {payment.tenderedCents !== null && (
            <Text style={styles.subLine}>Tendered {formatCents(payment.tenderedCents)} · change {formatCents(payment.tenderedCents - payment.amountCents)}</Text>
          )}
        </View>
      ))}
      {owedCents > 0 && <Line label="Still owed" value={formatCents(owedCents)} tone="bad" rule={payments.length === 0} />}

      {refunds.map((refund) => (
        <Line
          key={refund.id}
          label={`Refunded ${new Date(refund.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
          value={`−${formatCents(refund.totalCents)}`}
          tone="bad"
        />
      ))}
      {refunds.length > 0 && profit.refundedTaxCents > 0 && (
        <Text style={styles.subLine}>of which sales tax {formatCents(profit.refundedTaxCents)}</Text>
      )}
      {refunds.length > 0 && (
        // Can go negative on a sale over-refunded under the old maths -- see
        // saleProfit -- so it is coloured when it does rather than left plain.
        <Line label="Kept" value={formatCents(profit.keptCents)} total tone={profit.keptCents < 0 ? 'bad' : undefined} />
      )}

      {discounts.totalOffCents > 0 && (
        <Text style={styles.saved}>
          Customer saved {formatCents(discounts.totalOffCents)}{discounts.totalOffPercent ? ` · ${discounts.totalOffPercent} off list` : ''}
          {discounts.onlyPromotion ? ` · ${discounts.onlyPromotion}` : ''}
        </Text>
      )}
    </View>
  );

  const profitCard = (
    <View style={[styles.box, !compact && styles.sideCol]}>
      <View style={styles.boxHead}>
        <Text style={styles.boxTitle}>Profit</Text>
        {refundedCents > 0 && <Text style={styles.boxMeta}>after refund</Text>}
      </View>
      {/* Tax excluded (not the shop's money) and refunds netted out of both
          revenue and cost -- the same terms as the period figures. */}
      <Line label="Revenue" hint={sale.taxCents > 0 ? 'excl. tax' : null} value={formatCents(profit.netRevenueCents)} />
      <Line label="Cost of goods" value={`−${formatCents(profit.costCents)}`} tone="bad" />
      <Line
        label="Profit"
        value={`${profit.profitCents >= 0 ? '+' : '−'}${formatCents(Math.abs(profit.profitCents))}`}
        tone={profit.profitCents >= 0 ? 'good' : 'bad'}
        total
      />
      {profit.marginPercent !== null && (
        <>
          <View style={styles.meter}>
            <View style={[styles.meterFill, { width: `${marginWidth}%` }, profit.profitCents < 0 && { backgroundColor: theme.bentoLoss }]} />
          </View>
          <Text style={styles.subLine}>{profit.marginPercent.toFixed(0)}% of revenue kept as profit</Text>
        </>
      )}
      {profit.uncostedItemCount > 0 && (
        <Text style={styles.caveat}>
          {`${profit.uncostedItemCount} ${profit.uncostedItemCount === 1 ? 'item has' : 'items have'} no cost price on file (${formatCents(profit.uncostedRevenueCents)}), so this is the most the sale could have made — set the cost in Inventory.`}
        </Text>
      )}
    </View>
  );

  return (
    <View style={styles.panel}>
      <View style={[styles.top, compact && styles.topCompact]}>
        <View style={styles.chips}>
          {hasCustomer ? (
            <View style={styles.chip}>
              <Text style={styles.chipStrong}>{sale.customerName ?? 'Customer'}</Text>
              {sale.customerPhone ? <Text style={styles.chipMuted}>{sale.customerPhone}</Text> : null}
              {sale.customerEmail ? <Text style={styles.chipMuted}>{sale.customerEmail}</Text> : null}
            </View>
          ) : (
            <View style={styles.chip}><Text style={styles.chipMuted}>Customer</Text><Text style={styles.chipText}>walk-in</Text></View>
          )}
          {storeName && <View style={styles.chip}><Text style={styles.chipMuted}>Store</Text><Text style={styles.chipText}>{storeName}</Text></View>}
          <View style={styles.chip}>
            <Text style={styles.chipMuted}>Cashier</Text>
            <Text style={sale.cashierName ? styles.chipStrong : styles.chipText}>{sale.cashierName ?? 'not recorded'}</Text>
          </View>
        </View>
        <View style={styles.actions}>{actions}</View>
      </View>

      <View style={styles.tiles}>
        <Tile label="PAID" value={formatCents(paidCents)} hint={paidHint} tone={paidCents === 0 ? 'dim' : 'default'} />
        <Tile
          label="TAKEN OFF"
          value={discounts.totalOffCents > 0 ? `−${formatCents(discounts.totalOffCents)}` : formatCents(0)}
          hint={offHint}
          tone={discounts.totalOffCents > 0 ? 'blue' : 'dim'}
        />
        <Tile label="TAX" value={formatCents(sale.taxCents)} hint={taxHint} tone={sale.taxCents > 0 ? 'default' : 'dim'} />
        <Tile
          label="PROFIT"
          value={`${profit.profitCents >= 0 ? '+' : '−'}${formatCents(Math.abs(profit.profitCents))}`}
          hint={profitHint}
          tone={profit.profitCents >= 0 ? 'good' : 'bad'}
        />
      </View>

      <View style={compact ? styles.cardsStacked : styles.cards}>
        {itemsCard}
        {moneyCard}
        {profitCard}
      </View>

      {footer}
    </View>
  );
}

// A sign travels with every coloured figure (+$3.71, −$8.00), so green and red
// are never the only signal -- theme.ts's rule for bentoProfit/bentoLoss.
const TILE_TONE = StyleSheet.create({
  default: {},
  blue: { color: theme.bentoAccentInk },
  good: { color: theme.bentoProfit },
  bad: { color: theme.bentoLoss },
  dim: { color: theme.bentoMuted3 },
});

const LINE_TONE = StyleSheet.create({
  blue: { color: theme.bentoAccentInk },
  bad: { color: theme.bentoLoss },
  good: { color: theme.bentoProfit },
});

// Blue fills say "press this" and wash pills are the non-committing presses --
// the rule from the hub cards (see bentoAccentSolid in theme.ts). Exported so
// the row's actions and the editor draw from one place.
export const pillStyles = StyleSheet.create({
  pill: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: theme.bentoAccentWash },
  pillText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoAccentInk },
  solid: { backgroundColor: theme.bentoAccentSolid },
  solidText: { color: theme.bentoSurface },
  danger: { backgroundColor: theme.bentoDownWash },
  dangerText: { color: theme.bentoDownInk },
  quiet: { backgroundColor: theme.bentoSoft },
  quietText: { color: theme.bentoInk },
  disabled: { backgroundColor: theme.bentoLine },
  disabledText: { color: theme.bentoMuted3 },
});

const styles = StyleSheet.create({
  panel: { backgroundColor: theme.bentoSoft, borderRadius: 16, marginHorizontal: 6, marginBottom: 8, padding: 12, gap: 12 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  topCompact: { flexDirection: 'column', alignItems: 'stretch' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, flexShrink: 1 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: theme.bentoSurface, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5 },
  chipStrong: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk },
  chipText: { fontSize: 12.5, color: theme.bentoInk2 },
  chipMuted: { fontSize: 12.5, color: theme.bentoMuted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },

  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { flexGrow: 1, flexBasis: 150, backgroundColor: theme.bentoSurface, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 12 },
  tileLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8, color: theme.bentoMuted2 },
  tileValue: { fontSize: 22, fontWeight: '800', letterSpacing: -0.6, color: theme.bentoInk, marginTop: 2, fontVariant: ['tabular-nums'] },
  tileHint: { fontSize: 12, color: theme.bentoMuted, marginTop: 2 },

  cards: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  cardsStacked: { gap: 10 },
  itemsCol: { flex: 1.55, minWidth: 0 },
  sideCol: { flex: 1, minWidth: 0 },
  box: { backgroundColor: theme.bentoSurface, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14, marginBottom: 0 },
  boxHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 },
  boxTitle: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk },
  boxMeta: { fontSize: 11.5, fontWeight: '600', color: theme.bentoMuted },

  itemRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 9, borderTopWidth: 1, borderTopColor: theme.bentoLine },
  itemHeadRow: { borderTopWidth: 0, paddingTop: 0, paddingBottom: 6 },
  itemHead: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6, color: theme.bentoMuted2 },
  moneyCol: { width: 78, textAlign: 'right', alignItems: 'flex-end' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  qty: { fontSize: 13, fontWeight: '800', color: theme.bentoMuted, lineHeight: 18 },
  itemName: { fontSize: 13, fontWeight: '700', color: theme.bentoInk, lineHeight: 18, flexShrink: 1 },
  sub: { fontSize: 11.5, color: theme.bentoMuted, lineHeight: 16 },
  list: { fontSize: 13, color: theme.bentoMuted, lineHeight: 18, fontVariant: ['tabular-nums'] },
  off: { fontSize: 13, fontWeight: '700', color: theme.bentoAccentInk, lineHeight: 18, fontVariant: ['tabular-nums'] },
  none: { fontSize: 13, color: theme.bentoMuted3, lineHeight: 18 },
  paid: { fontSize: 13, fontWeight: '800', color: theme.bentoInk, lineHeight: 18, fontVariant: ['tabular-nums'] },
  right: { textAlign: 'right' },
  backPill: { backgroundColor: theme.bentoRefundWash, borderRadius: 999, paddingHorizontal: 6 },
  backPillText: { fontSize: 10.5, fontWeight: '800', color: theme.bentoRefundInk },
  stackItem: { paddingVertical: 9, borderTopWidth: 1, borderTopColor: theme.bentoLine, gap: 2 },
  stackTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },

  line: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 5 },
  lineRule: { borderTopWidth: 1, borderTopColor: theme.bentoLine, marginTop: 3, paddingTop: 8 },
  lineTotal: { borderTopWidth: 1.5, borderTopColor: theme.bentoInk, marginTop: 4, paddingTop: 8 },
  lineKey: { fontSize: 13, color: theme.bentoInk2, flexShrink: 1 },
  lineHint: { fontSize: 11.5, color: theme.bentoMuted },
  lineValue: { fontSize: 13, fontWeight: '700', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  lineTotalText: { fontSize: 15, fontWeight: '800', color: theme.bentoInk },
  includes: { fontSize: 11.5, color: theme.bentoMuted, textAlign: 'right', marginTop: -2 },
  subLine: { fontSize: 11.5, color: theme.bentoMuted, marginBottom: 2 },
  saved: { marginTop: 10, backgroundColor: theme.bentoAccentWash, color: theme.bentoAccentInk, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, fontSize: 12, fontWeight: '700', overflow: 'hidden' },
  meter: { height: 6, borderRadius: 3, backgroundColor: theme.bentoSoft, marginTop: 8, marginBottom: 4, overflow: 'hidden' },
  meterFill: { height: '100%', borderRadius: 3, backgroundColor: theme.bentoProfit },
  caveat: { fontSize: 11.5, color: theme.bentoWarn, marginTop: 8, lineHeight: 16 },
});
