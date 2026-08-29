import { collectLocation } from '@/lib/storefront-collect';

// Orders Part 0, tasks 4 and 5. The rule these tests pin exists because
// `shop_locations.address` is EMPTY for nearly every shop -- nothing has ever
// written it automatically (20260808000000's backfill and createShop both
// carry name/city/neighborhood/contact_phone and not address), so it holds
// something only for an owner who typed it into the optional "Unit or
// building, street" field in Settings -> Locations.
//
// Rendering that field alone would have shipped this feature as a blank line
// for almost everyone -- the exact defect the feature exists to remove. So the
// pick-up line is COMPOSED, and `city` (returned by the same RPC, and
// populated for every shop by both creation paths) is what it degrades to.
describe('collectLocation', () => {
  it('joins a hand-typed address to the city', () => {
    expect(collectLocation('Shop 12, Bakaaro Market', 'Hargeisa')).toBe('Shop 12, Bakaaro Market, Hargeisa');
  });

  // THE COMMON CASE. Without this, the feature is a blank line for nearly
  // every real shop.
  it('falls back to the city alone when no address was ever typed', () => {
    expect(collectLocation(null, 'Hargeisa')).toBe('Hargeisa');
  });

  it('uses the address alone when the shop has no city', () => {
    expect(collectLocation('Shop 12, Bakaaro Market', null)).toBe('Shop 12, Bakaaro Market');
  });

  // Null, never '' -- callers test one thing to decide whether the line
  // renders at all, and an empty string would render an empty line.
  it('returns null when it knows nothing, so no line renders at all', () => {
    expect(collectLocation(null, null)).toBeNull();
  });

  // Whitespace is not an address. A field the owner opened and left as a
  // space must not produce a dangling ", Hargeisa" with nothing before it.
  it('treats a whitespace-only address as absent rather than joining a dangling separator', () => {
    expect(collectLocation('   ', 'Hargeisa')).toBe('Hargeisa');
  });

  it('treats whitespace on both sides as knowing nothing', () => {
    expect(collectLocation('  ', '   ')).toBeNull();
  });

  it('trims the parts it keeps', () => {
    expect(collectLocation('  Shop 12  ', '  Hargeisa  ')).toBe('Shop 12, Hargeisa');
  });

  // An owner who typed the city into the address field must not be repeated
  // back to the customer as "Hargeisa, Hargeisa".
  it('does not repeat the city when the address already names it', () => {
    expect(collectLocation('Bakaaro Market, Hargeisa', 'Hargeisa')).toBe('Bakaaro Market, Hargeisa');
  });

  it('matches the city case-insensitively when deciding whether it is already there', () => {
    expect(collectLocation('Bakaaro Market, HARGEISA', 'Hargeisa')).toBe('Bakaaro Market, HARGEISA');
  });

  // undefined and null mean the same thing here: an optional prop that was
  // never passed reads the same as a column that came back null.
  it('reads undefined the same as null', () => {
    expect(collectLocation(undefined, undefined)).toBeNull();
    expect(collectLocation(undefined, 'Hargeisa')).toBe('Hargeisa');
  });
});
