import { type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { DualAmount } from '@/components/pos/dual-amount';
import { Colors } from '@/constants/theme';
import type { CheckoutIntent } from '@/lib/checkout-intent';
import { formatCents } from '@/lib/currency';
import type { Currency } from '@/types/models';

// Pinned to the light palette for now -- no dark-mode switching yet.
const theme = Colors.light;

/**
 * The sale, as a fixed frame: the title and Clear all hold at the top, the
 * total and the primary action hold at the bottom, and everything that grows
 * with the basket scrolls between them. A twenty-line sale changes what is in
 * the scroller and nothing else -- the total and the button stay exactly where
 * the cashier's thumb left them.
 *
 * `mode` is where the money is taken, not how the panel looks:
 *   'sheet'  -- the button opens the checkout modal (every phone, and the
 *               counter until the payment blocks move inline)
 *   'inline' -- the payment is on this panel, so the button charges, and says
 *               so in the words `checkoutIntent` chose.
 */
export function SalePanel({
  compact,
  mode,
  itemCount,
  onClearAll,
  scanButton,
  head,
  totalCents,
  currency,
  intent,
  onPrimary,
  onHold,
  servedBy,
  onChangeServedBy,
  earnsPoints = 0,
  children,
}: {
  compact: boolean;
  mode: 'inline' | 'sheet';
  itemCount: number;
  onClearAll: (() => void) | null;
  scanButton?: ReactNode;
  head?: ReactNode;
  totalCents: number;
  currency: Currency | null;
  intent: CheckoutIntent;
  onPrimary: () => void;
  onHold: (() => void) | null;
  servedBy: string | null;
  onChangeServedBy: () => void;
  earnsPoints?: number;
  children: ReactNode;
}) {
  // Opening the sheet is not the same promise as taking the money: the
  // decision the sheet exists to take has not been made yet, so the button
  // names the amount and stops there.
  const primaryLabel = mode === 'inline'
    ? intent.label
    : (itemCount > 0 ? `Checkout · ${formatCents(totalCents)}` : 'Nothing to charge yet');
  const primaryEnabled = mode === 'inline' ? intent.enabled : itemCount > 0;

  // A plain View on a phone, for the reason pos.tsx already documents: the page
  // itself scrolls there (the cart renders above the browse pane), and nesting
  // a flex-sized ScrollView inside that scroller is a sizing fight against
  // Yoga's own defaults that is very hard to win.
  const Middle = compact ? View : ScrollView;

  return (
    <Card variant="bento" style={[styles.card, compact && styles.cardCompact]}>
      <View style={styles.head}>
        <Text style={styles.title}>Current sale</Text>
        <View style={styles.headActions}>
          <Text style={styles.count}>{itemCount} {itemCount === 1 ? 'item' : 'items'}</Text>
          {scanButton}
          {onClearAll && (
            <Pressable onPress={onClearAll} style={styles.clear}>
              <Text style={styles.clearText}>Clear all</Text>
            </Pressable>
          )}
          {head}
        </View>
      </View>

      <Middle style={compact ? undefined : styles.middle} contentContainerStyle={compact ? undefined : styles.middleContent}>
        {children}
      </Middle>

      {/* On the page grey rather than the card white, so the edge of the
          scroller is visible: a cashier can see there is more above it. */}
      <View style={styles.grand}>
        <View style={styles.grandRow}>
          <Text style={styles.grandLabel}>Total</Text>
          <DualAmount cents={totalCents} currency={currency} size="total" />
        </View>
        {earnsPoints > 0 && <Text style={styles.earns}>Earns {earnsPoints.toLocaleString()} points</Text>}
      </View>

      <View style={styles.foot}>
        <Pressable
          onPress={onPrimary}
          disabled={!primaryEnabled}
          style={[styles.primary, !primaryEnabled && styles.primaryDisabled]}
        >
          <Text style={styles.primaryText}>{primaryLabel}</Text>
        </Pressable>
        {mode === 'inline' && intent.hint && <Text style={styles.hint}>{intent.hint}</Text>}

        {/* Short on a phone by design: every pixel this row takes is a pixel of
            basket the cashier cannot see. Holding a sale and who is serving it
            share one line there, and stack on a counter that has the room. */}
        <View style={compact ? styles.footRowCompact : undefined}>
          {onHold && (
            <Pressable onPress={onHold} style={compact ? styles.holdMini : styles.hold}>
              <Text style={compact ? styles.holdMiniText : styles.holdText}>
                {compact ? 'Hold' : 'Hold for later'}
              </Text>
            </Pressable>
          )}
          <Pressable onPress={onChangeServedBy} style={styles.served}>
            <Text style={styles.servedText}>
              Served by <Text style={styles.servedName}>{servedBy ?? 'nobody yet'}</Text>
            </Text>
          </Pressable>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  // `flex: 1` on the counter so `middle` below has a real height to resolve
  // against -- against a content-sized parent a flex scroller collapses to
  // nothing, which is the same trap receipt-modal.tsx documents.
  card: { flex: 1, padding: 0, overflow: 'hidden' },
  // Spelled out rather than a bare `flex: 0`, which is the trap the cart card
  // carried a comment about before this component existed: inside the page's
  // vertical scroller the panel must size to its content, and `flex: 0` alone
  // leaves flexBasis to interpretation -- on web it resolves to 0% and the
  // panel lays out wider than the screen and disappears off the side of it.
  cardCompact: { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%', minWidth: 0 },
  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    paddingHorizontal: 18, paddingTop: 18, paddingBottom: 10,
  },
  title: { color: theme.bentoInk, fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
  headActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0 },
  count: {
    color: theme.bentoMuted, fontSize: 12, fontWeight: '700', backgroundColor: theme.bentoSoft,
    borderRadius: 999, paddingVertical: 3, paddingHorizontal: 10,
  },
  clear: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 11 },
  clearText: { color: theme.bentoMuted, fontSize: 11.5, fontWeight: '700' },
  middle: { flex: 1 },
  middleContent: { paddingBottom: 4 },
  grand: { backgroundColor: theme.bentoSoft, paddingHorizontal: 18, paddingVertical: 14 },
  grandRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  grandLabel: { color: theme.bentoInk, fontSize: 15, fontWeight: '800' },
  earns: { color: theme.bentoMuted, fontSize: 11.5, fontWeight: '700', marginTop: 6 },
  foot: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 16 },
  primary: {
    backgroundColor: theme.bentoInk, height: 56, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
  },
  primaryDisabled: { opacity: 0.35 },
  primaryText: { color: theme.bentoSurface, fontSize: 15, fontWeight: '800' },
  hint: { color: theme.bentoMuted, fontSize: 11.5, textAlign: 'center', marginTop: 9 },
  footRowCompact: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 9 },
  hold: { marginTop: 10, paddingVertical: 13, borderRadius: 999, backgroundColor: theme.bentoSoft, alignItems: 'center' },
  holdText: { color: theme.bentoMuted, fontSize: 12.5, fontWeight: '700' },
  holdMini: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 13 },
  holdMiniText: { color: theme.bentoMuted, fontSize: 11.5, fontWeight: '700' },
  served: { paddingVertical: 6, flexShrink: 1, minWidth: 0 },
  servedText: { color: theme.bentoMuted, fontSize: 11.5 },
  servedName: { color: theme.bentoInk2, fontWeight: '700' },
});
