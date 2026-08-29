import {
  ALL_MODULES,
  canWrite,
  daysUntil,
  describeLimit,
  expandModules,
  FREE_FALLBACK,
  headroom,
  isAtLimit,
  LIMIT_RESOURCES,
  limitReachedMessage,
  moduleForPath,
  MODULES,
  moduleNotIncludedMessage,
  parseLimitReached,
  parseModuleNotIncluded,
} from '@/lib/entitlements';

// The plans seeded by migration 20260818000000 are the concrete cases this
// catalog has to get right — if these drift, the client and the DB disagree
// about what a tier includes.
const FREE = ['pos', 'inventory'];
const STANDARD = ['pos', 'inventory', 'customers', 'dashboard', 'accounting', 'promotions', 'scheduling'];

describe('the module catalog', () => {
  it('exposes every module in MODULES through ALL_MODULES, in the same order', () => {
    expect(ALL_MODULES).toEqual(MODULES.map((m) => m.key));
  });

  it('gives every module a label and a description', () => {
    for (const module of MODULES) {
      expect(module.label.length).toBeGreaterThan(0);
      expect(module.description.length).toBeGreaterThan(0);
    }
  });

  it('gives every limit resource a singular noun, so messages can pluralize', () => {
    for (const resource of LIMIT_RESOURCES) {
      expect(resource.noun.length).toBeGreaterThan(0);
      expect(resource.noun.endsWith('s')).toBe(false);
    }
  });
});

describe('expandModules', () => {
  it('keeps a seeded plan as-is', () => {
    expect(expandModules(FREE)).toEqual(['pos', 'inventory']);
  });

  it('returns modules in catalog order regardless of stored order', () => {
    expect(expandModules(['accounting', 'pos'])).toEqual(['pos', 'accounting']);
  });

  it('drops unknown entries so a plan row can outlive a catalog change', () => {
    expect(expandModules([...FREE, 'time_travel'])).toEqual(['pos', 'inventory']);
  });

  it('handles an empty plan without inventing access', () => {
    expect(expandModules([])).toEqual([]);
  });

  it('resolves the full Standard tier', () => {
    expect(expandModules(STANDARD)).toEqual([
      'pos',
      'inventory',
      'customers',
      'dashboard',
      'accounting',
      'promotions',
      'scheduling',
    ]);
  });
});

describe('moduleForPath', () => {
  it('maps the module-gated tabs', () => {
    expect(moduleForPath('/dashboard')).toBe('dashboard');
    expect(moduleForPath('/pos')).toBe('pos');
    expect(moduleForPath('/inventory')).toBe('inventory');
    expect(moduleForPath('/accounting')).toBe('accounting');
  });

  // Both storefront routes are gated so a lapsed shop tapping the greyed row
  // lands on the upgrade wall in (admin)/_layout.tsx -- which is also what
  // makes the nav's own 🔒 derivation (moduleForPath + hasModule) light up for
  // them with no second implementation of the lock treatment.
  it('maps both storefront routes to the storefront module', () => {
    expect(moduleForPath('/storefront')).toBe('storefront');
    expect(moduleForPath('/orders')).toBe('storefront');
  });

  it('resolves a nested route through its prefix', () => {
    expect(moduleForPath('/product/new')).toBe('inventory');
    expect(moduleForPath('/product/abc-123')).toBe('inventory');
    expect(moduleForPath('/accounting/payroll')).toBe('accounting');
  });

  it('leaves People and Settings ungated', () => {
    // People holds self-service HR that any active member must reach whatever
    // the shop pays; Settings holds the Billing panel, which is the one screen
    // that tells a lapsed shop how to start paying again.
    expect(moduleForPath('/people')).toBeNull();
    expect(moduleForPath('/settings')).toBeNull();
    expect(moduleForPath('/me')).toBeNull();
  });

  it('does not match a route that merely starts with the same letters', () => {
    expect(moduleForPath('/posture')).toBeNull();
    expect(moduleForPath('/inventory-report')).toBeNull();
  });
});

describe('isAtLimit', () => {
  it('treats null and undefined as unlimited', () => {
    expect(isAtLimit(10_000, null)).toBe(false);
    expect(isAtLimit(10_000, undefined)).toBe(false);
  });

  it('blocks at the cap, not past it — it is asked before creating a record', () => {
    expect(isAtLimit(49, 50)).toBe(false);
    expect(isAtLimit(50, 50)).toBe(true);
    expect(isAtLimit(51, 50)).toBe(true);
  });

  it('treats a zero limit as blocking everything', () => {
    // Free grants vendors: 0 — the module is reachable but nothing can be added.
    expect(isAtLimit(0, 0)).toBe(true);
  });

  it('reports a shop left over its cap by a downgrade as at-limit', () => {
    expect(isAtLimit(62, 50)).toBe(true);
  });
});

describe('headroom', () => {
  it('is null when unlimited', () => {
    expect(headroom(500, null)).toBeNull();
  });

  it('counts what is left', () => {
    expect(headroom(38, 50)).toBe(12);
    expect(headroom(0, 50)).toBe(50);
  });

  it('never goes negative for a shop stranded over its cap', () => {
    expect(headroom(62, 50)).toBe(0);
  });
});

describe('describeLimit', () => {
  it('says unlimited when there is no cap', () => {
    expect(describeLimit('products', null)).toBe('Unlimited products');
  });

  it('pluralizes on the count', () => {
    expect(describeLimit('locations', 1)).toBe('1 store');
    expect(describeLimit('locations', 4)).toBe('4 stores');
    expect(describeLimit('staff', 2)).toBe('2 team members');
  });

  it('groups thousands so a big cap stays readable', () => {
    expect(describeLimit('customers', 2000)).toBe('2,000 customers');
  });
});

describe('canWrite', () => {
  it('allows writes through trial, active, and grace', () => {
    expect(canWrite('trialing')).toBe(true);
    expect(canWrite('active')).toBe(true);
    // Grace exists because mobile-money payment is confirmed by hand — a shop
    // that paid yesterday must not be locked out today.
    expect(canWrite('grace')).toBe(true);
  });

  it('stops writes once expired or suspended', () => {
    expect(canWrite('expired')).toBe(false);
    expect(canWrite('suspended')).toBe(false);
  });
});

describe('daysUntil', () => {
  const now = new Date('2026-08-04T12:00:00Z');

  it('is null with no date', () => {
    expect(daysUntil(null, now)).toBeNull();
  });

  it('rounds up, so a partial day still counts as a day to plan for', () => {
    expect(daysUntil('2026-08-05T18:00:00Z', now)).toBe(2);
    expect(daysUntil('2026-08-05T12:00:00Z', now)).toBe(1);
  });

  it('floors at zero once the date has passed', () => {
    expect(daysUntil('2026-08-01T12:00:00Z', now)).toBe(0);
  });

  it('counts a full default trial', () => {
    expect(daysUntil('2026-11-02T12:00:00Z', now)).toBe(90);
  });
});

describe('parseLimitReached', () => {
  // The exact shape PostgREST produces from the trigger in migration
  // 20260818000300 — verified against a live insert past the cap.
  const realError = {
    code: 'P0001',
    message: 'limit_reached',
    details: '{"resource" : "products", "limit" : 50, "usage" : 50}',
    hint: 'Upgrade the plan or remove an existing record.',
  };

  it('reads the resource, cap and usage off a real trigger error', () => {
    expect(parseLimitReached(realError)).toEqual({ resource: 'products', limit: 50, usage: 50 });
  });

  it('accepts the postgres-native `detail` spelling too', () => {
    expect(parseLimitReached({ message: 'limit_reached', detail: '{"resource":"locations","limit":1,"usage":1}' })).toEqual({
      resource: 'locations',
      limit: 1,
      usage: 1,
    });
  });

  it('ignores unrelated failures so a network drop is never blamed on the plan', () => {
    expect(parseLimitReached({ message: 'permission denied for table products' })).toBeNull();
    expect(parseLimitReached(new Error('Network request failed'))).toBeNull();
    expect(parseLimitReached(null)).toBeNull();
    expect(parseLimitReached(undefined)).toBeNull();
    expect(parseLimitReached('limit_reached')).toBeNull();
  });

  it('rejects a malformed or unknown payload rather than guessing', () => {
    expect(parseLimitReached({ message: 'limit_reached', details: 'not json' })).toBeNull();
    expect(parseLimitReached({ message: 'limit_reached' })).toBeNull();
    expect(parseLimitReached({ message: 'limit_reached', details: '{"resource":"wormholes","limit":1,"usage":1}' })).toBeNull();
    expect(parseLimitReached({ message: 'limit_reached', details: '{"resource":"products"}' })).toBeNull();
  });
});

describe('parseModuleNotIncluded', () => {
  it('reads the module off a real gate error', () => {
    expect(
      parseModuleNotIncluded({
        code: 'P0001',
        message: 'module_not_included',
        details: '{"module" : "accounting"}',
      })
    ).toBe('accounting');
  });

  it('does not confuse itself with a limit error', () => {
    expect(parseModuleNotIncluded({ message: 'limit_reached', details: '{"resource":"products","limit":1,"usage":1}' })).toBeNull();
  });

  it('rejects an unknown module rather than guessing', () => {
    expect(parseModuleNotIncluded({ message: 'module_not_included', details: '{"module":"telepathy"}' })).toBeNull();
  });
});

describe('moduleNotIncludedMessage', () => {
  it('refuses and reassures in the same breath', () => {
    const message = moduleNotIncludedMessage('accounting');
    expect(message).toContain('Accounting');
    // Someone who just failed to save must be told their existing data is fine,
    // or they will assume the worst about everything else on the screen.
    expect(message).toContain('already saved is safe');
  });
});

describe('limitReachedMessage', () => {
  it('names the cap and both ways out', () => {
    expect(limitReachedMessage({ resource: 'products', limit: 50, usage: 50 })).toBe(
      "You've reached 50 of 50 products on your plan. Remove one, or upgrade to add more."
    );
  });

  it('says a zero limit is a plan gap, not a full shelf', () => {
    // "Remove one to add another" would be nonsense advice at a cap of zero.
    expect(limitReachedMessage({ resource: 'vendors', limit: 0, usage: 0 })).toBe(
      "Your plan doesn't include vendors. Upgrade to start adding them."
    );
  });
});

describe('FREE_FALLBACK', () => {
  it('matches the seeded Free plan, so failing closed lands somewhere real', () => {
    expect(FREE_FALLBACK.modules).toEqual(['pos', 'inventory']);
    expect(FREE_FALLBACK.limits).toEqual({
      locations: 1,
      products: 50,
      staff: 2,
      customers: 100,
      vendors: 0,
      sales_per_month: 300,
    });
  });

  it('is marked unresolved, so the UI never claims a plan "ended" when the lookup merely failed', () => {
    // The restriction is right; the accusation is not. A shop whose entitlement
    // call failed — an outage, a stale build, a migration not yet applied —
    // must not be told its plan has ended.
    expect(FREE_FALLBACK.resolved).toBe(false);
  });

  it('never reads as full access', () => {
    expect(FREE_FALLBACK.modules).not.toContain('accounting');
    expect(FREE_FALLBACK.modules).not.toContain('payroll');
    expect(FREE_FALLBACK.modules.length).toBeLessThan(ALL_MODULES.length);
  });
});

describe('storefront module', () => {
  it('is in the catalog', () => {
    expect(ALL_MODULES).toContain('storefront');
    expect(MODULES.find((m) => m.key === 'storefront')?.label).toBe('Online storefront');
  });

  it('is not in the free fallback', () => {
    expect(FREE_FALLBACK.modules).not.toContain('storefront');
  });

  it('survives a round trip through expandModules', () => {
    expect(expandModules(['storefront', 'not_a_module'])).toEqual(['storefront']);
  });
});
