// Mirrors the loyalty arithmetic in complete_sale (migration 20260820000000)
// exactly. Client-side this is display-only — so the POS cart can show the
// points line and the "earns N points" hint before checkout — and the server
// always recomputes and is authoritative, same contract as tax.ts.
//
// No Supabase import, deliberately: that module needs a native runtime and so
// can't be loaded under Jest, which is why every piece of arithmetic in this
// app lives apart from the I/O that uses it.
import { formatCents } from '@/lib/currency';

export type LoyaltySettings = {
  enabled: boolean;
  // Points earned per USD of pre-tax, post-discount spend.
  pointsPerUsd: number;
  // What one point is worth when spent, in cents.
  centsPerPoint: number;
};

export function pointsToCents(points: number, centsPerPoint: number): number {
  if (points <= 0 || centsPerPoint <= 0) return 0;
  return Math.floor(points) * centsPerPoint;
}

// The most a customer could put towards this bill: bounded by what they have,
// and by the bill itself. Floored, because a point is indivisible — at 2c a
// point, a $10.05 bill can absorb 502 points ($10.04) and not 503, which would
// overshoot and turn the last point into cash back.
export function maxRedeemablePoints(
  preRedemptionCents: number,
  balancePoints: number,
  settings: LoyaltySettings
): number {
  if (!settings.enabled || settings.centsPerPoint <= 0) return 0;
  if (preRedemptionCents <= 0 || balancePoints <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(balancePoints), Math.floor(preRedemptionCents / settings.centsPerPoint)));
}

// The single clamp. Every caller uses this rather than the number the cashier
// typed, which is what keeps a redemption correct when the cart changes
// underneath it: shrink the basket and the redemption shrinks with it on the
// next render, with no imperative re-clamping anywhere.
export function effectiveRedemption(
  requestedPoints: number,
  preRedemptionCents: number,
  balancePoints: number,
  settings: LoyaltySettings,
  hasCustomer: boolean
): { points: number; cents: number } {
  if (!hasCustomer || !settings.enabled || requestedPoints <= 0) return { points: 0, cents: 0 };
  const points = Math.min(Math.floor(requestedPoints), maxRedeemablePoints(preRedemptionCents, balancePoints, settings));
  if (points <= 0) return { points: 0, cents: 0 };
  return { points, cents: pointsToCents(points, settings.centsPerPoint) };
}

// Rounded to the nearest whole point, up or down — a $19.99 basket earns 20,
// not 19. Flooring is defensible arithmetic but reads as pettiness at the
// counter, where a penny short of twenty dollars visibly costs a point.
//
// Note this is the opposite choice from maxRedeemablePoints, which must keep
// flooring: rounding a redemption UP would let points exceed the bill and turn
// into cash back. Generous on the way in, exact on the way out.
//
// `earnBaseCents` is the pre-tax total after every discount, including any
// points already redeemed.
export function pointsEarnedFor(earnBaseCents: number, pointsPerUsd: number): number {
  if (earnBaseCents <= 0 || pointsPerUsd <= 0) return 0;
  return Math.round((earnBaseCents * pointsPerUsd) / 100);
}

export function formatPoints(points: number): string {
  return `${points.toLocaleString()} ${points === 1 ? 'point' : 'points'}`;
}

// "148 pts · $1.48" — the balance and what it's actually worth, together,
// because a points number on its own tells a customer nothing they can act on.
export function pointsValueLabel(points: number, centsPerPoint: number): string {
  return `${points.toLocaleString()} pts · ${formatCents(pointsToCents(points, centsPerPoint))}`;
}
