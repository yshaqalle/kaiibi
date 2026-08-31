import { ThemeCounter } from '@/components/storefront/theme-counter';
import { ThemeMarket } from '@/components/storefront/theme-market';
import { ThemeWindow } from '@/components/storefront/theme-window';
import {
  DEFAULT_PALETTE, DEFAULT_THEME, paletteColors,
  type StorefrontPalette, type StorefrontTheme,
} from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront, StorefrontCategory, StorefrontProduct } from '@/types/models';

const RENDERERS = {
  market: ThemeMarket,
  counter: ThemeCounter,
  window: ThemeWindow,
} as const;

// The stored theme and palette are CHECK-constrained in the database, so an
// unknown value should be impossible. Falling back anyway costs one line and is
// the difference between a page that looks slightly different from what the shop
// chose and a page that renders unstyled in front of their customers.
//
// `areas` is optional and defaults to `[]` -- a caller with nothing to offer
// (every pre-Task-8 test of this component) still gets a collection-only
// checkout rather than a missing required prop.
export function StorefrontView({
  storefront,
  products,
  areas = [],
  categories = [],
}: {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  areas?: PublicDeliveryArea[];
  categories?: StorefrontCategory[];
}) {
  const hasTheme = Object.prototype.hasOwnProperty.call(RENDERERS, storefront.theme);
  const themeKey = (hasTheme ? storefront.theme : DEFAULT_THEME) as StorefrontTheme;
  const Renderer = RENDERERS[themeKey];
  const colors = paletteColors((storefront.palette ?? DEFAULT_PALETTE) as StorefrontPalette);
  return <Renderer storefront={storefront} products={products} colors={colors} areas={areas} categories={categories} />;
}
