import {
  effectiveRedemption,
  formatPoints,
  maxRedeemablePoints,
  pointsEarnedFor,
  pointsToCents,
  pointsValueLabel,
  type LoyaltySettings,
} from '@/lib/loyalty';

// The shipped defaults: a point per dollar, a cent per point — a 1% programme.
const makeSettings = (overrides: Partial<LoyaltySettings> = {}): LoyaltySettings => ({
  enabled: true,
  pointsPerUsd: 1,
  centsPerPoint: 1,
  ...overrides,
});

describe('pointsToCents', () => {
  it('multiplies points by the point value', () => {
    expect(pointsToCents(200, 1)).toBe(200); // 200 points at 1c = $2.00
  });

  it('handles a point worth more than a cent', () => {
    expect(pointsToCents(50, 10)).toBe(500); // 50 points at 10c = $5.00
  });

  it('returns 0 for zero or negative points', () => {
    expect(pointsToCents(0, 1)).toBe(0);
    expect(pointsToCents(-10, 1)).toBe(0);
  });
});

describe('maxRedeemablePoints', () => {
  it('is bounded by the balance when the bill is larger', () => {
    expect(maxRedeemablePoints(10000, 148, makeSettings())).toBe(148);
  });

  it('is bounded by the bill when the balance is larger', () => {
    expect(maxRedeemablePoints(500, 10000, makeSettings())).toBe(500);
  });

  it('floors against the bill so points never become cash back', () => {
    // $10.05 at 2c a point absorbs 502 points ($10.04), not 503 ($10.06).
    expect(maxRedeemablePoints(1005, 10000, makeSettings({ centsPerPoint: 2 }))).toBe(502);
  });

  it('returns 0 when loyalty is off', () => {
    expect(maxRedeemablePoints(10000, 500, makeSettings({ enabled: false }))).toBe(0);
  });

  it('returns 0 for a zero bill', () => {
    expect(maxRedeemablePoints(0, 500, makeSettings())).toBe(0);
  });

  it('returns 0 rather than a negative for a customer already in the red', () => {
    expect(maxRedeemablePoints(10000, -20, makeSettings())).toBe(0);
  });
});

describe('effectiveRedemption', () => {
  it('passes a valid request through', () => {
    expect(effectiveRedemption(100, 10000, 500, makeSettings(), true)).toEqual({ points: 100, cents: 100 });
  });

  it('clamps a request larger than the balance', () => {
    expect(effectiveRedemption(500, 10000, 148, makeSettings(), true)).toEqual({ points: 148, cents: 148 });
  });

  it('clamps a request larger than the bill', () => {
    expect(effectiveRedemption(5000, 300, 10000, makeSettings(), true)).toEqual({ points: 300, cents: 300 });
  });

  it('returns nothing when no customer is attached', () => {
    expect(effectiveRedemption(100, 10000, 500, makeSettings(), false)).toEqual({ points: 0, cents: 0 });
  });

  it('returns nothing when loyalty is off', () => {
    expect(effectiveRedemption(100, 10000, 500, makeSettings({ enabled: false }), true)).toEqual({ points: 0, cents: 0 });
  });

  it('keeps cents consistent with pointsToCents at any point value', () => {
    const settings = makeSettings({ centsPerPoint: 10 });
    const result = effectiveRedemption(50, 10000, 500, settings, true);
    expect(result.cents).toBe(pointsToCents(result.points, settings.centsPerPoint));
  });
});

describe('pointsEarnedFor', () => {
  it('gives a point per dollar at the default rate', () => {
    expect(pointsEarnedFor(100, 1)).toBe(1);
  });

  it('rounds a part-dollar up to the nearest whole point', () => {
    // A penny short of $20 still earns 20 — flooring here reads as pettiness
    // at the counter.
    expect(pointsEarnedFor(1999, 1)).toBe(20);
    expect(pointsEarnedFor(199, 1)).toBe(2);
  });

  it('rounds a part-dollar down when it is nearer the lower point', () => {
    expect(pointsEarnedFor(140, 1)).toBe(1);
    expect(pointsEarnedFor(1940, 1)).toBe(19);
  });

  it('rounds a half-point up, matching the SQL', () => {
    // Postgres round() on numeric goes half away from zero; for the positive
    // amounts a sale can produce that agrees with Math.round.
    expect(pointsEarnedFor(150, 1)).toBe(2);
  });

  it('applies a rate above 1', () => {
    expect(pointsEarnedFor(150, 2)).toBe(3); // $1.50 at 2/dollar
  });

  it('applies a fractional rate', () => {
    expect(pointsEarnedFor(400, 0.5)).toBe(2);
    expect(pointsEarnedFor(500, 0.5)).toBe(3); // 2.5 rounds up
  });

  it('returns 0 for a zero base or a zero rate', () => {
    expect(pointsEarnedFor(0, 1)).toBe(0);
    expect(pointsEarnedFor(10000, 0)).toBe(0);
  });
});

describe('formatPoints', () => {
  it('uses the singular for exactly one point', () => {
    expect(formatPoints(1)).toBe('1 point');
  });

  it('uses the plural everywhere else, zero included', () => {
    expect(formatPoints(0)).toBe('0 points');
    expect(formatPoints(12)).toBe('12 points');
  });
});

describe('pointsValueLabel', () => {
  it('shows the balance next to what it is worth', () => {
    expect(pointsValueLabel(148, 1)).toBe('148 pts · $1.48');
  });

  it('values a point worth more than a cent', () => {
    expect(pointsValueLabel(50, 10)).toBe('50 pts · $5.00');
  });
});
