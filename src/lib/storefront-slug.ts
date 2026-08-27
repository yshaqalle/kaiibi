// A slug becomes a DNS label -- `<slug>.kaiibi.com` -- so the rules here are
// DNS's, not ours: lowercase, a-z 0-9 and hyphen, no hyphen at either end, and
// 63 characters maximum, which is the hard limit on a single label.
//
// normalizeSlug is what we SUGGEST as someone types their shop name.
// validateSlug is what we ENFORCE. They are deliberately separate: normalising
// a rejected value would silently hand a shop a different address from the one
// they typed, and an address is the thing they are about to print on a card.

export type SlugProblem =
  | 'too_short'
  | 'too_long'
  | 'bad_characters'
  | 'edge_hyphen'
  | 'reserved';

// Names the platform answers on itself, plus the ones a browser or a mail
// server will assume. A shop holding any of these could intercept traffic
// meant for us.
export const RESERVED_SLUGS = [
  'www', 'app', 'api', 'admin', 'platform', 'dashboard', 'account', 'accounts',
  'billing', 'support', 'help', 'status', 'blog', 'docs', 'mail', 'smtp',
  'ftp', 'cdn', 'static', 'assets', 'auth', 'login', 'signup', 'kaiibi',
] as const;

const RESERVED = new Set<string>(RESERVED_SLUGS);

export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function validateSlug(input: string): SlugProblem | null {
  if (input.length < 3) return 'too_short';
  if (input.length > 63) return 'too_long';
  if (!/^[a-z0-9-]+$/.test(input)) return 'bad_characters';
  if (input.startsWith('-') || input.endsWith('-')) return 'edge_hyphen';
  if (RESERVED.has(input)) return 'reserved';
  return null;
}

// What we SUGGEST while a shop's address is still unclaimed: normalizeSlug
// applied to their name. It derives; it does not judge -- a name that
// normalizes to a reserved word (deriveSlugFromName('Admin') -> 'admin') is
// still returned as-is, and validateSlug is what refuses it. Keeping that
// judgement in one place is the point.
export function deriveSlugFromName(shopName: string): string {
  const normalized = normalizeSlug(shopName);
  if (normalized.length <= 63) return normalized;

  // Truncating at 63 can land mid-word on what was an internal hyphen,
  // producing a trailing hyphen that validateSlug then rejects -- so strip
  // any trailing hyphen AFTER truncating, not before.
  return normalized.slice(0, 63).replace(/-+$/, '');
}

// Joins a base slug with a suffix (e.g. a second word from the shop's name)
// when the plain suggestion is already taken. It normalizes the join so it
// never produces a leading/trailing/double hyphen, but it does NOT truncate
// the result if it overflows 63 characters -- that's validateSlug's call to
// make, same as everywhere else in this file.
export function applySuffix(base: string, suffix: string): string {
  const normalizedSuffix = normalizeSlug(suffix);
  if (normalizedSuffix === '') return base;
  return normalizeSlug(`${base}-${normalizedSuffix}`);
}
