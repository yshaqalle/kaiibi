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

// Accounting-surface formatter. `formatCents` is fine for a receipt line but
// reads badly on a P&L: no thousands separator, and a loss renders as
// "$-1925.10" with the sign stranded inside the amount. Kept as a separate
// function rather than changing formatCents, which POS/receipts/inventory all
// depend on.
//
// `negativeStyle: 'parens'` gives the accounting convention -- ($1,925.10) --
// which is faster to scan down a column of figures than a leading minus, and
// is what a P&L's expense/loss lines should use. 'sign' (the default) suits
// running text and stat tiles, where a lone parenthesised number is cryptic.
export function formatAccountingCents(cents: number, options?: { negativeStyle?: 'sign' | 'parens' }): string {
  const negative = cents < 0;
  const magnitude = Math.abs(cents) / 100;
  const formatted = `$${magnitude.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (!negative) return formatted;
  return options?.negativeStyle === 'parens' ? `(${formatted})` : `-${formatted}`;
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
