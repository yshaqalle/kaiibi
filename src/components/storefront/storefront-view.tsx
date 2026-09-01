import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  const insets = useSafeAreaInsets();

  // THE STATUS BAR WAS SITTING ON THE BUTTONS, on every theme, and nothing on
  // this route had ever asked for an inset -- not this file, not
  // src/app/store/[slug].tsx, not the public layout. The old nav was a bare
  // `padding: 16`, which is less than the status bar on any phone sold in the
  // last five years, so the shop's own name and the WhatsApp button have been
  // rendering under the clock and the battery icon the whole time.
  //
  // Invisible on web, where every inset is 0 and where this page was verified;
  // found the first time it was opened on an Android emulator. It is fixed here
  // rather than in each theme because this is the one place all three converge,
  // and because the page tone is already computed here -- padding the wrapper
  // without also filling it would trade the collision for a white band.
  return (
    <View style={{ flex: 1, backgroundColor: colors.soft, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <Renderer storefront={storefront} products={products} colors={colors} areas={areas} categories={categories} />
    </View>
  );
}
