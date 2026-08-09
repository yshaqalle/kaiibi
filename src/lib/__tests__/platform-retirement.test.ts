// platform.ts imports the real `@/lib/supabase` client, whose module load
// throws unless EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY are
// set -- Jest does not inline .env the way Metro does. resolveRetiredPlan
// itself never touches Supabase, so mocking the client (as every other test
// that imports a supabase-backed module in this repo already does) is enough
// to make the module loadable.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

import { resolveRetiredPlan } from '@/lib/platform';

// The client-side mirror of shop_effective_plan()'s successor hop. The server
// stays the authority for enforcement; this exists so the portal's own list can
// show the plan that actually applies without one RPC per row. If it drifts
// from 20260824000100_resolve_retired_plans.sql, the operator sees the dead
// plan's limits while the server enforces the successor's.

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

const plan = (key: string, retireAt: string | null = null, successorPlanKey: string | null = null) => ({
  key,
  retireAt,
  successorPlanKey,
});

describe('resolveRetiredPlan', () => {
  it('leaves a plan that is not retiring alone', () => {
    const plans = [plan('free'), plan('standard')];
    expect(resolveRetiredPlan('free', plans)).toBe('free');
  });

  it('leaves a plan whose retirement is still in the future alone', () => {
    const plans = [plan('free', FUTURE, 'standard'), plan('standard')];
    expect(resolveRetiredPlan('free', plans)).toBe('free');
  });

  it('follows the successor once the date has passed', () => {
    const plans = [plan('free', PAST, 'standard'), plan('standard')];
    expect(resolveRetiredPlan('free', plans)).toBe('standard');
  });

  it('follows one hop only, matching the SQL resolver', () => {
    // retire_plan re-points anything aimed at a plan it retires, so this state
    // should not occur. If it does, stopping is right: a loop here runs on
    // every row of the portal's store list.
    const plans = [plan('a', PAST, 'b'), plan('b', PAST, 'c'), plan('c')];
    expect(resolveRetiredPlan('a', plans)).toBe('b');
  });

  it('returns the original key when the successor is missing from the list', () => {
    const plans = [plan('free', PAST, 'starter')];
    expect(resolveRetiredPlan('free', plans)).toBe('free');
  });
});
