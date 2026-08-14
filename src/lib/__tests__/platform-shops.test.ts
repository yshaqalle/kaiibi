// listPlatformShops() is the query that decides what the operator sees about
// every store. It has to keep two plans apart per row: the one the shop is
// actually being BILLED for (shop_subscriptions.plan_id, never rewritten by
// retirement -- `storedPlanKey`/`storedPlanName`) and the one that actually
// APPLIES (mirroring shop_effective_plan()'s status branch and the retirement
// hop -- `planKey`/`planName`/`limits`). A test that reads only one of those
// would pass even if the portal priced revenue off the wrong plan.
//
// The client is mocked -- this function talks to Supabase -- but the fixture
// rows below are exactly the shape PostgREST would hand back (including the
// `plans` embed on shop_subscriptions), so everything from that boundary
// inward (deriveStatus, the stored/effective split, resolveRetiredPlan,
// retiringTo) is the real function under test, not a stand-in for it.
//
// jest/fake-supabase.ts was considered and rejected for this: its embed
// resolution only models the "parent has many children" direction (e.g.
// sales -> sale_items), matching child rows by `<parent>_id`. What this query
// needs is the other direction -- shop_subscriptions HOLDS plan_id and PostgREST
// nests the referenced plans row as an object -- which that helper does not
// support (it would always return an array, keyed off a foreign key name that
// does not exist on the fixture).

jest.mock('@/lib/supabase', () => {
  const tables: Record<string, any[]> = {};
  const client = {
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        order: () => builder,
        eq: () => builder,
        then: (resolve: any, reject: any) =>
          Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve, reject),
      };
      return builder;
    },
  };
  return { supabase: client, __tables: tables };
});

import { listPlatformShops, type PlatformShopRow } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

const { __tables: tables } = jest.requireMock('@/lib/supabase') as { __tables: Record<string, any[]> };

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

function makePlan(overrides: Partial<Plan> & { key: string }): Plan {
  return {
    id: `plan-${overrides.key}`,
    name: overrides.key,
    description: null,
    priceCents: 0,
    currency: 'USD',
    billingInterval: 'month',
    modules: [],
    limits: {},
    isPublic: true,
    retireAt: null,
    successorPlanKey: null,
    active: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    sortOrder: 0,
    ...overrides,
  };
}

const FREE = makePlan({ key: 'free', name: 'Free', limits: { products: 20, staff: 2 } });
const GROWTH = makePlan({ key: 'growth', name: 'Growth', limits: { products: 500, staff: 20 } });
// Retiring, but the date has not arrived yet.
const LEGACY_STANDARD = makePlan({
  key: 'legacy_standard',
  name: 'Legacy Standard',
  limits: { products: 100, staff: 5 },
  isPublic: false,
  retireAt: FUTURE,
  successorPlanKey: 'growth',
});
// Retiring, and the date is already behind us.
const LEGACY_BASIC = makePlan({
  key: 'legacy_basic',
  name: 'Legacy Basic',
  limits: { products: 50, staff: 3 },
  isPublic: false,
  retireAt: PAST,
  successorPlanKey: 'growth',
});

const PLANS = [FREE, GROWTH, LEGACY_STANDARD, LEGACY_BASIC];
const POST_TRIAL_PLAN_KEY = 'free';

// Raw rows, shaped exactly like what the real client hands back for each of
// the four narrow reads listPlatformShops issues.
tables.shops = [
  { id: 'shop-own-plan', name: 'Own Plan Co', owner_id: 'owner-1', created_at: '2026-01-01T00:00:00.000Z' },
  { id: 'shop-retiring-future', name: 'Not Yet Retired Co', owner_id: 'owner-2', created_at: '2026-01-02T00:00:00.000Z' },
  { id: 'shop-retiring-passed', name: 'Already Retired Co', owner_id: 'owner-3', created_at: '2026-01-03T00:00:00.000Z' },
  { id: 'shop-expired', name: 'Lapsed Co', owner_id: 'owner-4', created_at: '2026-01-04T00:00:00.000Z' },
  { id: 'shop-no-sub', name: 'No Subscription Co', owner_id: 'owner-5', created_at: '2026-01-05T00:00:00.000Z' },
];

tables.shop_subscriptions = [
  {
    shop_id: 'shop-own-plan',
    plan_id: GROWTH.id,
    trial_ends_at: null,
    current_period_end: FUTURE,
    grace_until: null,
    manual_status: 'active',
    plans: { key: GROWTH.key, name: GROWTH.name, limits: GROWTH.limits },
  },
  {
    shop_id: 'shop-retiring-future',
    plan_id: LEGACY_STANDARD.id,
    trial_ends_at: null,
    current_period_end: FUTURE,
    grace_until: null,
    manual_status: 'active',
    plans: { key: LEGACY_STANDARD.key, name: LEGACY_STANDARD.name, limits: LEGACY_STANDARD.limits },
  },
  {
    shop_id: 'shop-retiring-passed',
    plan_id: LEGACY_BASIC.id,
    trial_ends_at: null,
    current_period_end: FUTURE,
    grace_until: null,
    manual_status: 'active',
    plans: { key: LEGACY_BASIC.key, name: LEGACY_BASIC.name, limits: LEGACY_BASIC.limits },
  },
  {
    // Still nominally on growth, but its billing period lapsed with no grace
    // left -- deriveStatus() must call this 'expired', which is what forces
    // the entitlement base to platform_settings.post_trial_plan_key below.
    shop_id: 'shop-expired',
    plan_id: GROWTH.id,
    trial_ends_at: null,
    current_period_end: PAST,
    grace_until: null,
    manual_status: 'active',
    plans: { key: GROWTH.key, name: GROWTH.name, limits: GROWTH.limits },
  },
  // shop-no-sub deliberately has no row here.
];

tables.shop_usage_counters = [{ shop_id: 'shop-own-plan', resource: 'products', count: 12 }];

// Every column listPlatformShops actually selects, and a SECOND branch on the
// same shop: the read stopped filtering to is_primary (20260830000000's
// companion change), so both the grouping and the primary-first ordering are
// only exercised if a shop here has more than one.
tables.shop_locations = [
  {
    id: 'loc-2',
    shop_id: 'shop-own-plan',
    name: 'Koodbuur',
    contact_phone: null,
    city: 'Hargeisa',
    neighborhood: 'Koodbuur',
    is_primary: false,
  },
  {
    id: 'loc-1',
    shop_id: 'shop-own-plan',
    name: 'Main',
    contact_phone: '+252611234567',
    city: 'Hargeisa',
    neighborhood: 'Jigjiga Yar',
    is_primary: true,
  },
];

let rows: PlatformShopRow[];

beforeAll(async () => {
  rows = await listPlatformShops(PLANS, POST_TRIAL_PLAN_KEY);
});

function row(shopId: string): PlatformShopRow {
  const found = rows.find((r) => r.shopId === shopId);
  if (!found) throw new Error(`fixture bug: no row for ${shopId}`);
  return found;
}

describe('listPlatformShops', () => {
  it('reports a store whose plan is not retiring straight from its own plan', () => {
    expect(row('shop-own-plan')).toMatchObject({
      planKey: 'growth',
      planName: 'Growth',
      storedPlanKey: 'growth',
      storedPlanName: 'Growth',
      limits: GROWTH.limits,
      retiringTo: null,
      status: 'active',
      usage: { products: 12 },
    });
  });

  // The primary branch leads, whatever order the rows arrive in -- the drawer
  // reads this list top to bottom and "Main" is what an operator looks for.
  it('carries every branch, primary first', () => {
    expect(row('shop-own-plan').branches).toEqual([
      {
        id: 'loc-1',
        name: 'Main',
        city: 'Hargeisa',
        neighborhood: 'Jigjiga Yar',
        phone: '+252611234567',
        isPrimary: true,
      },
      { id: 'loc-2', name: 'Koodbuur', city: 'Hargeisa', neighborhood: 'Koodbuur', phone: null, isPrimary: false },
    ]);
  });

  it('leaves a shop with no branch row with an empty list rather than a hole', () => {
    expect(row('shop-retiring-future').branches).toEqual([]);
  });

  it('names the successor ahead of time but keeps serving its own plan until the date passes', () => {
    expect(row('shop-retiring-future')).toMatchObject({
      planKey: 'legacy_standard',
      planName: 'Legacy Standard',
      storedPlanKey: 'legacy_standard',
      storedPlanName: 'Legacy Standard',
      limits: LEGACY_STANDARD.limits,
      retiringTo: 'Growth',
      status: 'active',
    });
  });

  // The crux case: money is priced off what the store is still billed for
  // (storedPlanKey), entitlements off what the server actually now enforces
  // (planKey/planName/limits) -- and after the retirement date those two must
  // diverge in the SAME row.
  it('splits stored (billing) from effective (entitlement) plan once the retirement date has passed', () => {
    expect(row('shop-retiring-passed')).toMatchObject({
      planKey: 'growth',
      planName: 'Growth',
      limits: GROWTH.limits,
      storedPlanKey: 'legacy_basic',
      storedPlanName: 'Legacy Basic',
      retiringTo: 'Growth',
      status: 'active',
    });
  });

  it('resolves an expired store through platform_settings.post_trial_plan_key, not its stale subscription plan', () => {
    expect(row('shop-expired')).toMatchObject({
      planKey: 'free',
      planName: 'Free',
      limits: FREE.limits,
      // Still what they were last billed for -- the fallback only changes
      // what applies, never what shop_subscriptions.plan_id still points at.
      storedPlanKey: 'growth',
      storedPlanName: 'Growth',
      retiringTo: null,
      status: 'expired',
    });
  });

  it('falls back to free for a store with no subscription row at all', () => {
    expect(row('shop-no-sub')).toMatchObject({
      planKey: 'free',
      planName: 'Free',
      limits: FREE.limits,
      storedPlanKey: 'free',
      storedPlanName: 'Free',
      retiringTo: null,
      status: 'expired',
      manualStatus: 'active',
      trialEndsAt: null,
      currentPeriodEnd: null,
      usage: {},
    });
  });
});
