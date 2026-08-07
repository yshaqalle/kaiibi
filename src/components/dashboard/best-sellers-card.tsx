import { useMemo, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { BandFoot, BandPill, BandScope, BentoBand, ON_INK_MUTED } from '@/components/ui/bento-band';
import { Colors } from '@/constants/theme';
import { formatAccountingCents } from '@/lib/currency';
import type { ProductSales } from '@/lib/sales-reporting';

const theme = Colors.light;

type SortKey = 'revenue' | 'units';

// The fan needs horizontal room to read as a fan; stacked it is a smear. Below
// this the rows carry every value anyway, so it simply goes.
const FAN_MIN_WIDTH = 700;
const FAN_W = 600;
const FAN_H = 176;

/**
 * What sold, ranked — and sortable, because the two rankings disagree.
 *
 * That disagreement is the card. Sugar outsells rice several times over by
 * unit and loses to it by money; a shop reading only the money list stocks
 * for the wrong shelf. One ordering shown alone quietly asserts it is the
 * ordering that matters.
 *
 * Three parts: the total on the left, the fan in the middle, the ranked rows
 * on the right. The fan encodes share as stroke width, which is read poorly —
 * so it is a signature, not the measurement. Every value it draws is also
 * stated in the rows beside it, and taking the fan away loses nothing but the
 * flourish. That is the test a decorative mark has to pass to earn space here.
 */
export function BestSellersCard({ products, rangeLabel }: { products: ProductSales[]; rangeLabel: string }) {
  const [sortBy, setSortBy] = useState<SortKey>('revenue');
  const [width, setWidth] = useState(0);
  const [fanWidth, setFanWidth] = useState(0);
  const byRevenue = sortBy === 'revenue';
  const showFan = width >= FAN_MIN_WIDTH;

  const items = useMemo(() => {
    const rows = products.map((product) => ({
      name: product.name,
      // What the current sort ranks on — and what the fan's stroke encodes.
      value: byRevenue ? product.revenueCents : product.unitsSold,
      // The measure NOT being ranked, kept on the row so switching the sort
      // re-orders without dropping anything.
      caption: byRevenue
        ? `${product.unitsSold} ${product.unitsSold === 1 ? 'unit' : 'units'}`
        : formatAccountingCents(product.revenueCents),
      display: byRevenue ? formatAccountingCents(product.revenueCents) : String(product.unitsSold),
      revenueCents: product.revenueCents,
    }));
    return rows.sort((a, b) => b.value - a.value);
  }, [products, byRevenue]);

  const totalCents = useMemo(() => products.reduce((sum, p) => sum + p.revenueCents, 0), [products]);
  const totalUnits = useMemo(() => products.reduce((sum, p) => sum + p.unitsSold, 0), [products]);
  const leader = items[0];
  const leaderShare = leader && totalCents > 0 ? (leader.revenueCents / totalCents) * 100 : 0;

  return (
    <BentoBand
      title="Best sellers"
      blurb={`What sold in the ${rangeLabel.toLowerCase()}, ranked. Money and units do not always agree.`}
      actions={
        <View style={styles.actions}>
          <BandPill
            label={byRevenue ? 'By revenue' : 'By units sold'}
            onPress={() => setSortBy(byRevenue ? 'units' : 'revenue')}
          />
          {/* States the window; it does not offer to change it. The range is
              the control bar's, at the top of the screen. */}
          <BandScope label={rangeLabel} />
        </View>
      }
    >
      {items.length === 0 ? (
        <BandFoot>Nothing sold in this range yet.</BandFoot>
      ) : (
        <View
          style={[styles.wrap, !showFan && styles.wrapStacked]}
          onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
        >
          <View style={[styles.out, !showFan && styles.outStacked]}>
            <Text style={styles.outLabel}>{`Top ${items.length} · ${byRevenue ? 'sales' : 'units'}`}</Text>
            <Text style={styles.outValue}>
              {byRevenue ? formatAccountingCents(totalCents) : `${totalUnits} units`}
            </Text>
            {leader ? (
              <Text style={styles.outSub}>
                {`${leaderShare.toFixed(0)}% of the range's revenue is ${leader.name}.`}
              </Text>
            ) : null}
          </View>

          {showFan ? (
            <View
              style={styles.fan}
              onLayout={(event: LayoutChangeEvent) => setFanWidth(event.nativeEvent.layout.width)}
            >
              <FlowFan values={items.map((item) => item.value)} width={fanWidth} />
            </View>
          ) : null}

          <View style={[styles.rows, !showFan && styles.rowsStacked]}>
            {items.map((item, index) => (
              <View key={item.name} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.rowName} numberOfLines={2}>
                    {item.name}
                  </Text>
                  <Text style={styles.rowCaption}>{item.caption}</Text>
                </View>
                <View>
                  <Text style={styles.rowValue}>{item.display}</Text>
                  {index === 0 ? <Text style={styles.rowLead}>Leads</Text> : null}
                </View>
              </View>
            ))}
          </View>
        </View>
      )}

      {leader ? (
        <BandFoot>
          {`${leader.name} led with ${leaderShare.toFixed(0)}% of the range's product revenue. ` +
            'Figures are gross of refunds — a refund carries no product on it, so it cannot be taken off a line here.'}
        </BandFoot>
      ) : null}
    </BentoBand>
  );
}

/**
 * The fan. One ribbon per product, all leaving the same point and spreading to
 * their own row, with stroke width carrying share.
 *
 * Only the leader is drawn in the series blue; the rest are white at low
 * opacity. That is the whole reading the shape offers — which one is biggest —
 * and it is stated in words in the rows regardless.
 */
function FlowFan({ values, width }: { values: number[]; width: number }) {
  const max = Math.max(...values, 1);
  const padY = 12;
  const rowH = (FAN_H - padY * 2) / values.length;
  const x0 = 8;
  const x1 = FAN_W - 8;
  const originY = FAN_H / 2;

  // The height is DERIVED from the measured width, which is the RN equivalent
  // of the design's `height:auto`. With a fixed height the default
  // `xMidYMid meet` scales the viewBox down to fit that height and centres it
  // — so the fan drew at its natural 600 units in the middle of a wider box,
  // leaving a gap between the ribbons and the rows they point at.
  if (width <= 0) return <View style={{ height: FAN_H }} />;

  return (
    <Svg width={width} height={(width * FAN_H) / FAN_W} viewBox={`0 0 ${FAN_W} ${FAN_H}`}>
      {values.map((value, index) => {
        const y = padY + rowH * index + rowH / 2;
        const c1 = x0 + (x1 - x0) * 0.5;
        const c2 = x0 + (x1 - x0) * 0.82;
        return (
          <Path
            key={index}
            d={`M ${x0} ${originY} C ${c1} ${originY} ${c2} ${y.toFixed(1)} ${x1} ${y.toFixed(1)}`}
            fill="none"
            stroke={index === 0 ? theme.bentoSeries1 : 'rgba(255,255,255,0.22)'}
            strokeWidth={2 + (value / max) * 9}
            strokeLinecap="round"
          />
        );
      })}
      <Circle cx={x0} cy={originY} r={4.5} fill="#ffffff" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 8 },
  wrap: { flexDirection: 'row', alignItems: 'stretch', gap: 20, marginTop: 18 },
  wrapStacked: { flexDirection: 'column', gap: 16 },

  // Fixed width beside the fan, full width once stacked. `alignSelf` keeps it
  // at the top rather than stretching to the height of the rows beside it.
  out: {
    width: 152,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  outStacked: { width: 'auto', alignSelf: 'stretch' },
  outLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    color: ON_INK_MUTED,
  },
  outValue: {
    fontSize: 21,
    fontWeight: '800',
    color: '#ffffff',
    marginTop: 5,
    letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
  },
  outSub: { fontSize: 11, color: ON_INK_MUTED, marginTop: 5, lineHeight: 15 },

  fan: { flex: 1, minWidth: 0, justifyContent: 'center' },

  rows: { width: 224, justifyContent: 'space-between', gap: 8 },
  rowsStacked: { width: 'auto' },
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  rowText: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 13, fontWeight: '700', color: '#f2f2f5' },
  rowCaption: { fontSize: 11, color: ON_INK_MUTED, marginTop: 1, fontVariant: ['tabular-nums'] },
  rowValue: {
    fontSize: 13.5,
    fontWeight: '800',
    color: '#ffffff',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  rowLead: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    // The DARK mirror. `Colors.light.bentoAccentInk` is a deep blue chosen to
    // sit on a pale wash; on this near-black band it is all but invisible.
    // Same rule the band's chart marks follow — read the token by surface,
    // not by theme.
    color: Colors.dark.bentoAccentInk,
    marginTop: 3,
    textAlign: 'right',
  },
});
