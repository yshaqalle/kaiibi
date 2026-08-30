// Where to tell a customer to come and get it.
//
// WHY THIS IS COMPOSED AND NOT JUST AN ADDRESS. `shop_locations.address` is
// empty for very nearly every shop. Nothing has ever written it automatically:
// 20260808000000's backfill (:134-135) and createShop (src/lib/shops.ts:126-134)
// both carry name, city, neighborhood and contact_phone forward and NOT
// address, because `shops` never had one. It holds something only where an
// owner went and typed it into the optional "Unit or building, street" field in
// Settings -> Locations. Rendering it on its own would have shipped "a shop
// that does not deliver never told anyone where it is" as a BLANK LINE for
// almost everyone -- the same defect wearing a different shape.
//
// `neighborhood` IS THE MIDDLE TERM, and it is the field this region actually
// navigates by. Both creation paths above populate it -- the backfill for every
// pre-existing shop, createShop (shops.ts:132) from signup's "area" box
// (signup.tsx:68) for every shop since -- and 20260808000000:47-48 says outright
// that a shop addresses itself "by neighborhood/landmark (e.g. 'Jigjiga Yar,
// near the main market')". For the common shop this is the difference between
// "Collect from Hargeisa", which names a city of a million people, and
// "Collect from Jigjiga Yar, Hargeisa", which tells someone where to go.
// 20261010000100 puts it on the public payload beside `collect_address`.
//
// THE ORDER IS THE REPO'S OWN, narrowest first: [address, neighborhood, city],
// the same triple and the same sequence as locations-panel.tsx:138's
// describeLocation, marketing/poster-sheet.tsx:79's addressFor and
// location-switcher.tsx:45's describe(). Those join with ' · ' because they
// label a row in a list; this joins with ', ' because it is read inside a
// sentence ("Collect from ..."), which is the only thing that differs.
//
// Returns NULL, never '', when it knows nothing at all. Callers test one thing
// to decide whether the line renders, and an empty string would render an
// empty line -- which is the whole failure being avoided. Empty and
// whitespace-only parts are dropped rather than joined, so the line can never
// carry a dangling separator or a gap between two commas. The shop's NAME is
// deliberately not folded in here: both surfaces that use this already name
// the shop (the checkout page it is part of, and order-placed's "<shop> will
// call you ..." sentence), so including it would say it twice.
export function collectLocation(
  address: string | null | undefined,
  neighborhood: string | null | undefined,
  city: string | null | undefined,
): string | null {
  const kept: string[] = [];

  for (const raw of [address, neighborhood, city]) {
    const part = raw?.trim() ?? '';
    if (!part) continue;
    if (kept.some((k) => segmentsOf(k).includes(part.toLowerCase()))) continue;
    kept.push(part);
  }

  return kept.length > 0 ? kept.join(', ') : null;
}

// The de-duplication rule, and it is a SEGMENT match rather than a substring
// one on purpose.
//
// An owner who typed "Bakaaro Market, Hargeisa" into the address box and has
// Hargeisa as their city must not be read back as "..., Hargeisa, Hargeisa";
// likewise a shop whose "area" and city are both "Hargeisa", which signup
// makes easy (city defaults to Hargeisa and the area box is free text). So a
// part is dropped when an earlier-kept part already contains it as a whole
// comma-delimited segment.
//
// It was `street.toLowerCase().includes(town.toLowerCase())` -- a raw
// substring test -- and that suppressed a REAL city whenever its name turned
// up inside the address for an unrelated reason: a shop in Berbera at "Berbera
// Road" lost its city entirely and read "Collect from Berbera Road", which
// names a street and no town. Comparing whole segments keeps every duplicate
// this was built to catch ("Bakaaro Market, Hargeisa" still splits to a
// segment that IS "Hargeisa") while never swallowing a part that carries
// something the others do not. With three fields rather than two the rule also
// has more work to do than it did -- neighborhood can repeat the city as
// readily as the address can -- which is the other reason it is now applied
// uniformly to every part instead of only to the city.
function segmentsOf(value: string): string[] {
  return value.split(',').map((segment) => segment.trim().toLowerCase());
}
