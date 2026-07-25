// Mirrors the tax calculation in complete_sale/edit_sale (migration
// 0015) exactly — client-side, this is display-only (so the POS cart can
// show the tax line before checkout); the server always recomputes and is
// authoritative.
export function taxCentsFor(baseCents: number, taxRatePercent: number): number {
  return Math.round((baseCents * taxRatePercent) / 100);
}
