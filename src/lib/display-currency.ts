import { formatForeignCents, usdCentsToForeignCents } from '@/lib/currency';
import type { Currency } from '@/types/models';

// The shop's second currency, if it keeps one. `currencies` is a list with no
// primary, so the first active non-USD row is the pick -- a shop trading in two
// local currencies at one till is not a case this counter has ever had, and
// guessing between them would be worse than showing neither.
export function displayCurrency(currencies: Currency[]): Currency | null {
  return currencies.find((currency) => currency.active && currency.code.toUpperCase() !== 'USD') ?? null;
}

// The echo under a dollar figure: the same money, said again in the words the
// customer hears it in. Null when there is nothing to echo, so a caller renders
// one line rather than an empty second one.
//
// A rate of zero (or worse) is refused rather than divided by: a shop that has
// not filled its rate in yet gets the dollar price alone, which is true, rather
// than a converted figure that isn't.
export function secondaryAmount(usdCents: number, currency: Currency | null): string | null {
  if (!currency || currency.rateToUsd <= 0) return null;
  return formatForeignCents(usdCentsToForeignCents(usdCents, currency.rateToUsd), currency.symbol);
}
