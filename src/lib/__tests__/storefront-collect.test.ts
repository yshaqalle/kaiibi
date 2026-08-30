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
// pick-up line is COMPOSED, from [address, neighborhood, city] -- the repo's
// own place-string order (locations-panel.tsx:138, poster-sheet.tsx:79,
// location-switcher.tsx:45) -- and `neighborhood`, which BOTH creation paths
// populate for every shop, is what it degrades to before it ever reaches
// `city`.
describe('collectLocation', () => {
  it('joins a hand-typed address to the city', () => {
    expect(collectLocation('Shop 12, Bakaaro Market', null, 'Hargeisa')).toBe('Shop 12, Bakaaro Market, Hargeisa');
  });

  // THE COMMON CASE. Without this, the feature is a blank line for nearly
  // every real shop.
  it('falls back to the city alone when no address was ever typed', () => {
    expect(collectLocation(null, null, 'Hargeisa')).toBe('Hargeisa');
  });

  it('uses the address alone when the shop has no city', () => {
    expect(collectLocation('Shop 12, Bakaaro Market', null, null)).toBe('Shop 12, Bakaaro Market');
  });

  // Null, never '' -- callers test one thing to decide whether the line
  // renders at all, and an empty string would render an empty line.
  it('returns null when it knows nothing, so no line renders at all', () => {
    expect(collectLocation(null, null, null)).toBeNull();
  });

  // Whitespace is not an address. A field the owner opened and left as a
  // space must not produce a dangling ", Hargeisa" with nothing before it.
  it('treats a whitespace-only address as absent rather than joining a dangling separator', () => {
    expect(collectLocation('   ', null, 'Hargeisa')).toBe('Hargeisa');
  });

  it('treats whitespace on both sides as knowing nothing', () => {
    expect(collectLocation('  ', null, '   ')).toBeNull();
  });

  it('trims the parts it keeps', () => {
    expect(collectLocation('  Shop 12  ', null, '  Hargeisa  ')).toBe('Shop 12, Hargeisa');
  });

  // An owner who typed the city into the address field must not be repeated
  // back to the customer as "Hargeisa, Hargeisa".
  it('does not repeat the city when the address already names it', () => {
    expect(collectLocation('Bakaaro Market, Hargeisa', null, 'Hargeisa')).toBe('Bakaaro Market, Hargeisa');
  });

  it('matches the city case-insensitively when deciding whether it is already there', () => {
    expect(collectLocation('Bakaaro Market, HARGEISA', null, 'Hargeisa')).toBe('Bakaaro Market, HARGEISA');
  });

  // undefined and null mean the same thing here: an optional prop that was
  // never passed reads the same as a column that came back null.
  it('reads undefined the same as null', () => {
    expect(collectLocation(undefined, undefined, undefined)).toBeNull();
    expect(collectLocation(undefined, undefined, 'Hargeisa')).toBe('Hargeisa');
  });

  // --- the neighbourhood, added because `city` alone names a town of a
  // million people and not a shop ---

  // THE NEW COMMON CASE, and the whole point of the change. Nearly every shop
  // has no address and DOES have a neighbourhood, written at signup.
  it('degrades to the neighbourhood before the city, not straight past it', () => {
    expect(collectLocation(null, 'Jigjiga Yar, near the main road', 'Hargeisa'))
      .toBe('Jigjiga Yar, near the main road, Hargeisa');
  });

  it('puts all three in the repo place-string order, narrowest first', () => {
    expect(collectLocation('Shop 12', 'Bakaaro', 'Hargeisa')).toBe('Shop 12, Bakaaro, Hargeisa');
  });

  it('uses the neighbourhood alone when it is the only thing on file', () => {
    expect(collectLocation(null, 'Jigjiga Yar', null)).toBe('Jigjiga Yar');
  });

  // The gap in the middle is the one that would show. Without dropping it the
  // line reads "Shop 12, , Hargeisa".
  it('closes up a missing middle rather than rendering two commas together', () => {
    expect(collectLocation('Shop 12', null, 'Hargeisa')).toBe('Shop 12, Hargeisa');
    expect(collectLocation('Shop 12', '   ', 'Hargeisa')).toBe('Shop 12, Hargeisa');
  });

  it('treats whitespace in all three parts as knowing nothing', () => {
    expect(collectLocation(' ', '  ', '   ')).toBeNull();
  });

  // signup.tsx defaults the city to Hargeisa and leaves "area" as free text,
  // so an owner typing their town into both boxes is an ordinary thing to do.
  it('does not repeat the city when the neighbourhood is the same place', () => {
    expect(collectLocation(null, 'Hargeisa', 'Hargeisa')).toBe('Hargeisa');
    expect(collectLocation(null, 'hargeisa', 'HARGEISA')).toBe('hargeisa');
  });

  it('does not repeat a neighbourhood the address already spells out', () => {
    expect(collectLocation('Shop 12, Bakaaro', 'Bakaaro', 'Hargeisa')).toBe('Shop 12, Bakaaro, Hargeisa');
  });

  // THE REGRESSION THE OLD SUBSTRING RULE SHIPPED. `street.includes(town)`
  // suppressed the city outright here, leaving "Collect from Berbera Road" --
  // a street, and no town at all, for a customer following a forwarded link.
  // Comparing whole comma-delimited segments keeps the city, because "Berbera
  // Road" is not the segment "Berbera".
  it('keeps a real city whose name merely appears inside the address', () => {
    expect(collectLocation('Berbera Road', null, 'Berbera')).toBe('Berbera Road, Berbera');
  });

  it('keeps a real city whose name merely appears inside the neighbourhood', () => {
    expect(collectLocation(null, 'Hargeisa Road', 'Hargeisa')).toBe('Hargeisa Road, Hargeisa');
  });
});
