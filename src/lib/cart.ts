import type { CartLine } from '@/types/models';

export function cartTotalCents(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
}

export function buildSalePayload(lines: CartLine[]): { product_id: string; quantity: number }[] {
  return lines.map((line) => ({ product_id: line.product.id, quantity: line.quantity }));
}
