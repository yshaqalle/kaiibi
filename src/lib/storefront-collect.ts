// Where to tell a customer to come and get it.
//
// WHY THIS IS COMPOSED AND NOT JUST AN ADDRESS. `shop_locations.address` is
// empty for very nearly every shop. Nothing has ever written it automatically:
// 20260808000000's backfill and createShop (src/lib/shops.ts) both carry
// name, city, neighborhood and contact_phone forward and NOT address, because
// `shops` never had one. It holds something only where an owner went and typed
// it into the optional "Unit or building, street" field in Settings ->
// Locations. Rendering it on its own would have shipped "a shop that does not
// deliver never told anyone where it is" as a BLANK LINE for almost everyone --
// the same defect wearing a different shape.
//
// `city` is the fallback that is actually there: get_public_storefront
// (20261010000100) returns it on the same row, and both creation paths above
// populate it for every shop. `neighborhood` would be the better middle term
// and this deliberately does NOT use it -- it exists on shop_locations but is
// not in that function's explicit column list, so it is not public data and
// adding it would be a migration. These two fields are what the customer's
// page is actually given.
//
// Returns NULL, never '', when it knows nothing at all. Callers test one thing
// to decide whether the line renders, and an empty string would render an
// empty line -- which is the whole failure being avoided. The shop's NAME is
// deliberately not folded in here: both surfaces that use this already name
// the shop (the checkout page it is part of, and order-placed's "<shop> will
// call you ..." sentence), so including it would say it twice.
export function collectLocation(
  address: string | null | undefined,
  city: string | null | undefined,
): string | null {
  const street = address?.trim() ?? '';
  const town = city?.trim() ?? '';

  if (!street) return town || null;
  if (!town) return street;

  // An owner who typed the city into the address field must not be read back
  // as "Hargeisa, Hargeisa".
  if (street.toLowerCase().includes(town.toLowerCase())) return street;

  return `${street}, ${town}`;
}
