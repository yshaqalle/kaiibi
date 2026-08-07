import { useMemo, useState } from 'react';

import { RankingChart } from '@/components/ranking-chart';
import { BandFoot, BandPill, BentoBand } from '@/components/ui/bento-band';
import { formatAccountingCents } from '@/lib/currency';
import type { ProductSales } from '@/lib/sales-reporting';

type SortKey = 'revenue' | 'units';

/**
 * What sold, ranked — and sortable, because the two rankings disagree.
 *
 * That disagreement is the card. Sugar outsells rice several times over by
 * unit and loses to it by money; a shop reading only the money list stocks
 * for the wrong shelf. One ordering shown alone quietly asserts it is the
 * ordering that matters.
 *
 * The measure NOT being ranked is printed under each bar rather than dropped,
 * so switching the sort re-orders the rows without hiding anything — the
 * reader can see why the order changed.
 */
export function BestSellersCard({ products, rangeLabel }: { products: ProductSales[]; rangeLabel: string }) {
  const [sortBy, setSortBy] = useState<SortKey>('revenue');
  const byRevenue = sortBy === 'revenue';

  const items = useMemo(() => {
    const rows = products.map((product) => ({
      name: product.name,
      value: byRevenue ? product.revenueCents : product.unitsSold,
      // The measure NOT being ranked, kept on the row so switching the sort
      // re-orders without dropping anything.
      caption: byRevenue ? `${product.unitsSold} sold` : formatAccountingCents(product.revenueCents),
      revenueCents: product.revenueCents,
    }));
    return rows.sort((a, b) => b.value - a.value);
  }, [products, byRevenue]);

  const totalCents = useMemo(() => products.reduce((sum, p) => sum + p.revenueCents, 0), [products]);
  const leader = items[0];
  const leaderShare = leader && totalCents > 0 ? (leader.revenueCents / totalCents) * 100 : 0;

  return (
    <BentoBand
      title="Best sellers"
      blurb={`What sold in the ${rangeLabel.toLowerCase()}, ranked. Money and units do not always agree.`}
      actions={
        <BandPill
          label={byRevenue ? 'By revenue' : 'By units sold'}
          onPress={() => setSortBy(byRevenue ? 'units' : 'revenue')}
        />
      }
    >
      <RankingChart
        onInk
        showRank
        items={items}
        emptyLabel="Nothing sold in this range yet."
        formatValue={(value) => (byRevenue ? formatAccountingCents(value) : `${value} sold`)}
      />
      {leader ? (
        <BandFoot>
          {`${leader.name} led with ${leaderShare.toFixed(0)}% of the range's product revenue. ` +
            'Figures are gross of refunds — a refund carries no product on it, so it cannot be taken off a line here.'}
        </BandFoot>
      ) : null}
    </BentoBand>
  );
}
