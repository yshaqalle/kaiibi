import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { BestSellersCard } from '@/components/dashboard/best-sellers-card';
import { LeaderboardCard } from '@/components/dashboard/leaderboard-card';
import { OpenHoursCard } from '@/components/dashboard/open-hours-card';
import { SalesPaceCard } from '@/components/dashboard/sales-pace-card';
import { TakingsHeroCard, type TakingsMethod } from '@/components/dashboard/takings-hero-card';
import { TopMoverCard } from '@/components/dashboard/top-mover-card';
import type { DailyBucket, ProductSales } from '@/lib/sales-reporting';
import type { OpeningHours } from '@/lib/store-hours';
import type { Sale } from '@/types/models';

// Same flattening helper stat-tile.test.tsx uses — enough to assert what
// reached the screen without a query library the repo does not have.
function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function render(element: React.ReactElement) {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(element);
  });
  return { tree: tree!, texts: () => textsIn(tree!.toJSON() as ReactTestRendererJSON) };
}

// `textsIn` walks the RENDERED json; a test instance's `props.children` are
// still React elements, so matching a control by its label needs this instead.
function stringsInElement(node: unknown): string[] {
  if (node == null || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(stringsInElement);
  const children = (node as { props?: { children?: unknown } }).props?.children;
  return children === undefined ? [] : stringsInElement(children);
}

function pressLabelled(tree: ReturnType<typeof create>, label: string) {
  const target = tree.root
    .findAll((node) => typeof node.props?.onPress === 'function', { deep: true })
    .find((node) => stringsInElement(node.props.children).includes(label));
  if (!target) throw new Error(`No pressable found carrying the label "${label}"`);
  act(() => {
    target.props.onPress();
  });
}

const product = (name: string, revenueCents: number, unitsSold: number): ProductSales => ({
  productId: name,
  name,
  unitsSold,
  revenueCents,
});

describe('BestSellersCard', () => {
  // Rice earns more; sugar shifts more units. The card exists because those
  // two orderings disagree, so this is the behaviour worth pinning.
  const products = [product('Basmati Rice 5kg', 110_400, 96), product('Sugar 2kg', 59_000, 118)];

  it('ranks by money first, and shows the units it is not ranking by', () => {
    const { texts } = render(<BestSellersCard products={products} rangeLabel="7 days" />);
    expect(texts()).toContain('By revenue');
    expect(texts()).toContain('96 sold');
    // Rice is rank 1 while money is the measure.
    expect(texts().indexOf('Basmati Rice 5kg')).toBeLessThan(texts().indexOf('Sugar 2kg'));
  });

  it('re-orders the rows when switched to units, without dropping the money', () => {
    const { tree, texts } = render(<BestSellersCard products={products} rangeLabel="7 days" />);
    pressLabelled(tree, 'By revenue');
    expect(texts()).toContain('By units sold');
    expect(texts().indexOf('Sugar 2kg')).toBeLessThan(texts().indexOf('Basmati Rice 5kg'));
    // The measure no longer ranked is still on the row.
    expect(texts().some((t) => t.includes('1,104.00'))).toBe(true);
  });
});

describe('TopMoverCard', () => {
  it('carries a direction glyph, never colour alone', () => {
    const { texts } = render(
      <TopMoverCard
        mover={{ productId: 'p', name: 'Cooking Oil 3L', revenueCents: 5_000, previousCents: 10_000, changePct: -50 }}
        shareOfRevenue={12}
        dailyCents={[100, 200, 150]}
        rangeLabel="7 days"
      />
    );
    // The arrow is what says "down" -- profit green and loss red are ΔE 4.0
    // apart for deutan viewers, so the colour cannot carry it.
    expect(texts()).toContain('↓ 50%');
  });

  it('says "New" rather than inventing a percentage from zero', () => {
    const { texts } = render(
      <TopMoverCard
        mover={{ productId: 'p', name: 'Tea Leaves', revenueCents: 5_000, previousCents: 0, changePct: null }}
        shareOfRevenue={4}
        dailyCents={[]}
        rangeLabel="7 days"
      />
    );
    expect(texts()).toContain('New');
    expect(texts().some((t) => t.includes('Infinity') || t.includes('NaN'))).toBe(false);
  });
});

describe('SalesPaceCard', () => {
  it('states ahead or behind in words, not only in the ring colour', () => {
    const { texts } = render(
      <SalesPaceCard
        todayCents={60_000}
        weekCents={100_000}
        monthToDateCents={924_000}
        monthlyGoalCents={1_500_000}
        daysLeftInMonth={11}
      />
    );
    // Today is 60,000 against a 50,000 daily target -> ahead; the month is
    // 924,000 of 1,500,000 -> behind. Both words must be present.
    expect(texts()).toContain('ahead');
    expect(texts()).toContain('behind');
  });

  it('survives a shop with no goal set rather than printing NaN', () => {
    const { texts } = render(
      <SalesPaceCard todayCents={0} weekCents={0} monthToDateCents={0} monthlyGoalCents={0} daysLeftInMonth={3} />
    );
    expect(texts().some((t) => t.includes('NaN'))).toBe(false);
  });
});

describe('LeaderboardCard', () => {
  it('prints the figures as rows, not only inside the avatar strip', () => {
    // The regression this guards: the reference design put the ranking in a
    // hover title and nothing else, which on a phone is unreadable.
    const { texts } = render(
      <LeaderboardCard
        title="Top performers"
        scope="7 days"
        entries={[
          { name: 'Faduma Ali', valueCents: 148_620, meta: '84 orders' },
          { name: 'Abdi M', valueCents: 120_460 },
        ]}
        emptyLabel="No sales attributed yet."
      />
    );
    expect(texts()).toContain('Faduma Ali');
    expect(texts().some((t) => t.includes('1,486.20'))).toBe(true);
    expect(texts()).toContain('FA'); // the strip is still there, as the picture
  });

  it('shows the empty label rather than an empty strip', () => {
    const { texts } = render(
      <LeaderboardCard title="Top customers" scope="All time" entries={[]} emptyLabel="Nobody yet." />
    );
    expect(texts()).toContain('Nobody yet.');
  });
});

describe('OpenHoursCard', () => {
  const hours: OpeningHours = { mon: [{ open: '08:00', close: '18:00' }], sun: [] };

  const bucket = (day: string, netRevenueCents: number): DailyBucket => ({
    day,
    grossCents: netRevenueCents,
    taxCents: 0,
    refundCents: 0,
    netRevenueCents,
    orderCount: 1,
    discountCents: 0,
  });

  const sale = (iso: string, totalCents: number): Sale =>
    ({ id: iso, createdAt: iso, totalCents, taxCents: 0, items: [] }) as unknown as Sale;

  it('refuses to plot a day the shop is shut, and says why', () => {
    // 2026-08-02 is a Sunday, and `hours` has Sunday closed. A flat line here
    // would read as a catastrophic trading day rather than a closed one.
    const { texts } = render(
      <OpenHoursCard
        sales={[]}
        daily={[bucket('2026-08-02', 0)]}
        openingHours={hours}
        rangeLabel="7 days"
      />
    );
    expect(texts().some((t) => t.includes('closed on Sunday'))).toBe(true);
  });

  it('plots the trading hours of an open day and names the busiest', () => {
    const { texts } = render(
      <OpenHoursCard
        sales={[sale('2026-08-03T09:30:00', 500), sale('2026-08-03T14:30:00', 4_000)]}
        daily={[bucket('2026-08-03', 4_500)]}
        openingHours={hours}
        rangeLabel="7 days"
      />
    );
    // Open 08:00–18:00 means the last hour money is taken in is 17:00, so the
    // axis runs 8am–5pm and the 2:30pm sale is the peak.
    expect(texts().some((t) => t.includes('Busiest 2pm'))).toBe(true);
    expect(texts()).toContain('8am');
  });

  it('names takings rung up outside the posted hours instead of hiding them', () => {
    const { texts } = render(
      <OpenHoursCard
        sales={[sale('2026-08-03T06:00:00', 900)]}
        daily={[bucket('2026-08-03', 900)]}
        openingHours={hours}
        rangeLabel="7 days"
      />
    );
    expect(texts().some((t) => t.includes('outside your posted hours'))).toBe(true);
  });
});

describe('TakingsHeroCard', () => {
  const methods: TakingsMethod[] = [
    { label: 'Cash', amountCents: 226_100, group: 'cash' },
    { label: 'ZAAD', amountCents: 135_390, group: 'mobile' },
    { label: 'e-Dahab', amountCents: 43_190, group: 'mobile' },
  ];

  const render_ = () =>
    render(
      <TakingsHeroCard
        methods={methods}
        revenueCents={384_720}
        expenseCents={89_000}
        taxCents={25_560}
        canSeeExpenses
        onSeeProfitAndLoss={() => {}}
      />
    );

  it('leads with takings, and says why they exceed revenue', () => {
    const { texts } = render_();
    // 226,100 + 135,390 + 43,190 = 404,680
    expect(texts().some((t) => t.includes('4,046.80'))).toBe(true);
    expect(texts().some((t) => t.includes('sales tax you are holding'))).toBe(true);
  });

  it('scopes BOTH figures when a method filter is on', () => {
    // The reference design's bug: its filter changed the headline while the
    // row underneath stayed unfiltered, so "Mobile money" showed $0.00 above
    // an unfiltered "Money out $1,000.00". A filter scopes the whole card or
    // it does not exist.
    const { tree, texts } = render_();
    pressLabelled(tree, 'All methods');
    expect(texts()).toContain('Cash only');
    expect(texts().some((t) => t.includes('2,261.00'))).toBe(true);
    // Revenue narrows in proportion rather than staying at the full figure.
    expect(texts().some((t) => t.includes('3,847.20'))).toBe(false);
    expect(texts().some((t) => t.includes('Both figures above are filtered'))).toBe(true);
  });

  it('clears the filter when switched to money out, and says why', () => {
    // Expenses carry no payment method in kaiibi, so a "Cash only" heading
    // over an unfilterable figure would be a lie.
    const { tree, texts } = render_();
    pressLabelled(tree, 'All methods');
    expect(texts()).toContain('Cash only');
    pressLabelled(tree, 'Money out');
    expect(texts().some((t) => t.includes('carry no payment method'))).toBe(true);
    // Back to full takings, not the cash-only figure.
    expect(texts().some((t) => t.includes('4,046.80'))).toBe(true);
    // And the filter control is gone rather than shown and ignored.
    expect(texts()).not.toContain('Cash only');
  });

  it('hides the money in/out segment from someone who cannot see expenses', () => {
    const { texts } = render(
      <TakingsHeroCard
        methods={methods}
        revenueCents={384_720}
        expenseCents={0}
        taxCents={25_560}
        canSeeExpenses={false}
        onSeeProfitAndLoss={() => {}}
      />
    );
    expect(texts()).not.toContain('Money out');
  });
});
