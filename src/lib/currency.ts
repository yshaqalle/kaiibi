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

// Glance formatter for stat tiles, where the number has to survive a narrow
// column on a phone. Two compromises the detailed formatters don't make:
//
//   * whole dollars, no cents -- "$407" not "$406.50". A tile answers "roughly
//     how much"; the exact figure is a tap away in Transactions or Reports.
//   * K/M past ten thousand, so a good month can't overflow the tile. Capped
//     at about six characters however large the underlying number gets.
//
// Deliberately not used on the P&L or any row a shop owner might reconcile
// against a bank statement -- those need the real number.
export function formatCompactCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  // Rounds the magnitude, not the signed value: Math.round(-406.5) is -406
  // while Math.round(406.5) is 407, so rounding before taking the sign would
  // format the same amount differently either side of zero.
  const dollars = Math.round(Math.abs(cents) / 100);

  if (dollars < 10_000) {
    return `${sign}$${dollars.toLocaleString()}`;
  }

  // The unit is chosen from the *rounded* figure, because rounding can push a
  // value past the next boundary -- $999,999 rounds to 1000K, which should be
  // reported as $1M rather than "$1000K".
  const thousands = dollars / 1000;
  if (Number(thousands.toFixed(1)) < 1000) {
    return `${sign}$${trimZero(thousands)}K`;
  }
  return `${sign}$${trimZero(dollars / 1_000_000)}M`;
}

// One decimal, but "45K" rather than "45.0K" -- the trailing zero costs a
// character and says nothing.
function trimZero(value: number): string {
  const rounded = value.toFixed(1);
  return rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded;
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
