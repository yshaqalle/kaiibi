import { audienceSummary, isReachable, matchesAudience, type AudienceFilter } from '@/lib/campaign-audience';
import type { Customer } from '@/types/models';

const NOW = Date.parse('2026-08-13T10:00:00Z');

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'c1', shopId: 's1', firstName: 'Hodan', lastName: 'Ali', email: null,
    phone: '063 771 4402', street: null, city: null, neighborhood: null,
    tags: [], notes: null, pointsBalance: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Customer;
}

const EMPTY: AudienceFilter = { segments: [], tags: [], inactiveDays: null, locationId: null };

describe('isReachable', () => {
  it('is true for a number WhatsApp can open', () => {
    expect(isReachable(makeCustomer({ phone: '063 771 4402' }))).toBe(true);
  });

  it('is false with no phone at all', () => {
    expect(isReachable(makeCustomer({ phone: null }))).toBe(false);
  });

  it('is false for a number too short to dial', () => {
    expect(isReachable(makeCustomer({ phone: '1234' }))).toBe(false);
  });
});

describe('matchesAudience', () => {
  it('an empty filter matches everyone', () => {
    expect(matchesAudience(makeCustomer(), EMPTY, null, NOW)).toBe(true);
  });

  it('matches a chosen segment', () => {
    const vip = makeCustomer({ tags: ['vip'] });
    const filter = { ...EMPTY, segments: ['vip' as const] };
    expect(matchesAudience(vip, filter, null, NOW)).toBe(true);
  });

  it('excludes a customer outside every chosen segment', () => {
    const plain = makeCustomer({ tags: [], createdAt: '2020-01-01T00:00:00Z' });
    const filter = { ...EMPTY, segments: ['vip' as const] };
    expect(matchesAudience(plain, filter, null, NOW)).toBe(false);
  });

  it('matches any one of several chosen segments', () => {
    const atRisk = makeCustomer({ tags: ['at risk'] });
    const filter = { ...EMPTY, segments: ['vip' as const, 'at-risk' as const] };
    expect(matchesAudience(atRisk, filter, null, NOW)).toBe(true);
  });

  it('matches a tag regardless of case', () => {
    const c = makeCustomer({ tags: ['Wholesale'] });
    expect(matchesAudience(c, { ...EMPTY, tags: ['wholesale'] }, null, NOW)).toBe(true);
  });

  it('requires every chosen tag, not just one', () => {
    const c = makeCustomer({ tags: ['wholesale'] });
    expect(matchesAudience(c, { ...EMPTY, tags: ['wholesale', 'credit'] }, null, NOW)).toBe(false);
  });

  it('includes someone whose last purchase is older than the inactive window', () => {
    const filter = { ...EMPTY, inactiveDays: 60 };
    const longAgo = '2026-01-01T00:00:00Z';
    expect(matchesAudience(makeCustomer(), filter, longAgo, NOW)).toBe(true);
  });

  it('excludes someone who bought inside the inactive window', () => {
    const filter = { ...EMPTY, inactiveDays: 60 };
    const recent = '2026-08-10T00:00:00Z';
    expect(matchesAudience(makeCustomer(), filter, recent, NOW)).toBe(false);
  });

  it('includes someone who has never bought when an inactive window is set', () => {
    // Never having bought is the strongest form of "has not bought lately".
    const filter = { ...EMPTY, inactiveDays: 60 };
    expect(matchesAudience(makeCustomer(), filter, null, NOW)).toBe(true);
  });

  it('an unreachable customer still MATCHES — reachability is a separate question', () => {
    // They stay in the audience so that fixing their phone number later adds
    // them to the queue rather than requiring the campaign be rebuilt.
    const noPhone = makeCustomer({ phone: null });
    expect(matchesAudience(noPhone, EMPTY, null, NOW)).toBe(true);
    expect(isReachable(noPhone)).toBe(false);
  });
});

describe('audienceSummary', () => {
  it('counts matched, reachable and unreachable separately', () => {
    const customers = [
      makeCustomer({ id: 'a', phone: '063 771 4402' }),
      makeCustomer({ id: 'b', phone: null }),
      makeCustomer({ id: 'c', phone: '063 771 4403' }),
    ];
    const summary = audienceSummary(customers, EMPTY, new Map(), NOW);
    expect(summary).toEqual({ matched: 3, reachable: 2, unreachable: 1 });
  });

  it('counts only those the filter matched', () => {
    const customers = [
      makeCustomer({ id: 'a', tags: ['vip'] }),
      makeCustomer({ id: 'b', tags: [], createdAt: '2020-01-01T00:00:00Z' }),
    ];
    const summary = audienceSummary(customers, { ...EMPTY, segments: ['vip'] }, new Map(), NOW);
    expect(summary).toEqual({ matched: 1, reachable: 1, unreachable: 0 });
  });
});
