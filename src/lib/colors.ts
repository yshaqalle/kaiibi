// A fixed, distinguishable palette for auto-coloring brands/categories/tags
// — see migration 0012. Deliberately not part of the app's monochrome UI
// chrome; this is the one place colors are meant to carry meaning (telling
// similarly-named chips apart at a glance), not styling.
export const taxonomyPalette = [
  '#5B8DEF', // blue
  '#F2994A', // orange
  '#27AE60', // green
  '#9B51E0', // purple
  '#E0607E', // rose
  '#2D9CDB', // cyan
  '#D4A017', // amber
  '#56CCF2', // light blue
  '#BB6BD9', // magenta
  '#6FCF97', // mint
];

// Cycles through the palette deterministically by how many items already
// exist, so newly-created brands/categories/tags get a color "for free"
// (the "generate them on the fly" part) without ever needing to ask the
// user to pick one up front — they can always change it later.
export function nextTaxonomyColor(existingCount: number): string {
  return taxonomyPalette[existingCount % taxonomyPalette.length];
}
