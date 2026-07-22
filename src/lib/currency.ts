export function toCents(input: string): number {
  if (input.includes('-')) return 0;
  const normalized = input.replace(/[^0-9.]/g, '');
  const value = Number.parseFloat(normalized || '0');
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 100);
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
