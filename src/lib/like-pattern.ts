// `%` and `_` are wildcards inside a PostgREST `ilike` pattern, and `\` escapes
// them -- so a search for "50% off supplier" or "stock_take" would otherwise
// match far more than the reader asked for, and a trailing backslash would
// make the pattern invalid.
//
// Lived privately in vendors.ts until global search needed the same rule
// across products, bills and expenses. One copy, because a search that escapes
// correctly on four tables and not the fifth is the kind of bug nobody finds.
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** `%term%`, escaped. The shape every type-ahead in the app wants. */
export function containsPattern(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}
