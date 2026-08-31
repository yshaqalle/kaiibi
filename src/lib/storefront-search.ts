import type { StorefrontProduct } from '@/types/models';

// Finding one thing in a long catalogue.
//
// Counter exists for "a long catalogue with no photos" -- a 200-line pharmacy
// -- and had no way to find anything in it. The theme built for scale had the
// least navigation on the page.
//
// Client-side, over the products already in memory, and deliberately so: the
// whole catalogue arrives in one read on page load, so a server round trip per
// keystroke would be slower and more fragile on exactly the connection this
// page is usually opened over. It also keeps searching a shop from being
// something the shop's database has to serve to strangers.

// Below this, a search box is a control that costs a tap and saves nothing --
// the catalogue is already on screen and scrolling is not the problem.
// Twenty-five is roughly two phone screens of Counter rows, or six rows of a
// two-column grid: the point where "scroll and look" stops being reasonable.
export const SEARCH_THRESHOLD = 25;

export function shouldOfferSearch(products: StorefrontProduct[]): boolean {
  return products.length >= SEARCH_THRESHOLD;
}

// Name, category AND description.
//
// Name alone is not enough: a customer looks for "panadol" or "honey cough",
// which is the shop's own description or category rather than the name typed
// on the product. The description in particular is the field where a shop
// writes the words its customers actually use -- and until now it was fetched
// on every page load and rendered nowhere, so this is the second thing to
// finally make use of it.
//
// Case- and whitespace-insensitive, the same rule filterByCategory follows and
// for the same reason: the query and the stored value have different authors,
// and "Solar " not matching "solar" is a dead end the customer cannot see the
// cause of.
export function searchProducts(products: StorefrontProduct[], query: string): StorefrontProduct[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return products;

  return products.filter((p) => {
    const haystack = [p.name, p.category ?? '', p.description ?? ''].join(' ').toLowerCase();
    return haystack.includes(wanted);
  });
}
