import type { Product } from '@/types/models';

export function deriveCategories(products: Product[]): string[] {
  const distinct = new Set(products.map((p) => p.category).filter((c): c is string => Boolean(c)));
  return [...distinct].sort((a, b) => a.localeCompare(b));
}

export function deriveTags(products: Product[]): string[] {
  const distinct = new Set(products.flatMap((p) => p.tags).filter((tag): tag is string => Boolean(tag)));
  return [...distinct].sort((a, b) => a.localeCompare(b));
}
