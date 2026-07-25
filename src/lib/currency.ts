export function toCents(input: string): number {
  if (input.includes('-')) return 0;
  const normalized = input.replace(/[^0-9.]/g, '');
  const value = Number.parseFloat(normalized || '0');
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 100);
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// `rateToUsd` is units of the foreign currency per $1 USD (e.g. 115 for
// Somaliland Shilling) — both amounts are in that currency's minor unit
// (i.e. already multiplied by 100), same convention as USD cents.
export function foreignCentsToUsdCents(foreignCents: number, rateToUsd: number): number {
  return Math.round(foreignCents / rateToUsd);
}

export function usdCentsToForeignCents(usdCents: number, rateToUsd: number): number {
  return Math.round(usdCents * rateToUsd);
}

// Drops the decimals for a whole-unit amount (the common case for
// currencies like Sl Sh with no real fractional denomination in
// circulation) but keeps 2 decimals when the amount isn't whole.
export function formatForeignCents(cents: number, symbol: string): string {
  const amount = Math.round(cents) / 100;
  const formatted = amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `${formatted} ${symbol}`;
}
