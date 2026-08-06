import { containsPattern, escapeLikePattern, orFilterValue } from '@/lib/like-pattern';

// Two escape layers that run in opposite directions, which is the whole reason
// this file exists. escapeLikePattern ADDS backslashes so ILIKE reads `%` as a
// character; orFilterValue then DOUBLES them, because PostgREST strips one
// level off anything inside double quotes. Get the order or the doubling wrong
// and a search silently turns into a wildcard, or the request 400s -- neither
// of which the caller sees, since searchEverything settles each branch.

describe('escapeLikePattern', () => {
  it('escapes the ILIKE wildcards so they match literally', () => {
    expect(escapeLikePattern('50% off')).toBe('50\\% off');
    expect(escapeLikePattern('stock_take')).toBe('stock\\_take');
  });

  it('escapes the escape character itself', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLikePattern('basmati rice')).toBe('basmati rice');
  });
});

describe('containsPattern', () => {
  it('wraps in wildcards without escaping the ones it added', () => {
    expect(containsPattern('rice')).toBe('%rice%');
    expect(containsPattern('50%')).toBe('%50\\%%');
  });
});

describe('orFilterValue', () => {
  // The bug this was written for: `or=(name.ilike.%rice, basmati%,...)` parses
  // as a malformed third filter and PostgREST answers PGRST100.
  it('quotes a value so a comma stays data rather than a delimiter', () => {
    expect(orFilterValue(containsPattern('rice, basmati'))).toBe('"%rice, basmati%"');
  });

  it('doubles the backslashes containsPattern added, so ILIKE still sees one', () => {
    // On the wire: "%50\\% off%" -- PostgREST unquotes it to %50\% off%, which
    // ILIKE reads as a literal per cent. Without the doubling it would arrive
    // as %50% off% and match every product with "off" in the name.
    expect(orFilterValue(containsPattern('50% off'))).toBe('"%50\\\\% off%"');
  });

  it('escapes an embedded double quote rather than closing the value early', () => {
    expect(orFilterValue(containsPattern('say "hi"'))).toBe('"%say \\"hi\\"%"');
  });

  it('is safe for a trailing backslash, which would otherwise escape the closing quote', () => {
    expect(orFilterValue(containsPattern('tail\\'))).toBe('"%tail\\\\\\\\%"');
  });

  it('leaves ordinary text quoted but otherwise untouched', () => {
    expect(orFilterValue(containsPattern('rice'))).toBe('"%rice%"');
  });
});
