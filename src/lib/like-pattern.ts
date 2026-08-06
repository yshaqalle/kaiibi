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

// A value inside a PostgREST `or=(…)` list sits in a comma-separated grammar,
// so a comma in the reader's query ends the filter early and the whole request
// fails to parse -- a search for "rice, basmati" returns PGRST100 rather than
// rice. Double quotes are how PostgREST is told the commas are data.
//
// Quoting introduces a SECOND escape layer, and it runs the opposite way:
// inside quotes PostgREST strips backslashes, so the `\%` escapeLikePattern
// just produced would reach ILIKE as a bare `%` wildcard. Doubling `\` here is
// what survives that -- see the reserved-characters note in PostgREST's URL
// grammar, which specifies `"\\"` for a backslash and `"\""` for a quote.
//
// Only `.or()` needs this. A plain `.ilike()` puts its value in its own query
// parameter with no list to break, which is why vendors.ts never wanted it.
export function orFilterValue(value: string): string {
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}
