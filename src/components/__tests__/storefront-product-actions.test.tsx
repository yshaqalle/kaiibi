import { act, create } from 'react-test-renderer';

import { registerFlyTrigger, resetFlyToCartForTests, unregisterFlyTrigger } from '@/components/storefront/fly-to-cart';
import { ProductActions } from '@/components/storefront/theme-shared';
import { paletteColors } from '@/lib/storefront-catalog';
import type { StorefrontProduct } from '@/types/models';

// theme-shared.tsx transitively imports '@/lib/storefront' -> '@/lib/storage'
// -> '@/lib/supabase', which throws at import time without real Supabase env
// vars -- the same mock every other suite that pulls in theme-shared.tsx
// carries (storefront-shop-anchor.test.tsx, storefront-checkout-bar.test.tsx).
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const colors = paletteColors('ink');

const product: StorefrontProduct = {
  id: 'p1', name: 'Anker 20W charger', description: null, category: 'Phone', priceCents: 1200, stock: 5, imageUrl: null,
};

afterEach(() => {
  resetFlyToCartForTests();
});

// DECISION 4: `ProductActions` is shared between the ordinary product grid
// (ProductTile, Counter's row -- both real windows FlyToCartLayer's own
// overlay paints into) and ProductSheet, which renders the identical
// component inside an AppModal -- a SEPARATE native window on iOS and
// Android. `canFlyToCart` is what tells the two apart: true (the default,
// unset here) for the grid path, false only where ProductSheet renders it.
// These tests hold that switch directly, at the one component that owns it,
// rather than inferring it from ProductTile or ProductSheet's own trees.
describe('ProductActions: canFlyToCart gates the dot, never the cart', () => {
  it('fires the fly-to-cart trigger on Add when canFlyToCart is left at its default', () => {
    const trigger = jest.fn();
    registerFlyTrigger(trigger);
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ProductActions product={product} colors={colors} />);
    });
    const add = tree.root.findAll((n) => n.props?.testID === 'product-tile-add')[0];
    act(() => add.props.onPress({ nativeEvent: { pageX: 40, pageY: 220 } }));
    expect(trigger).toHaveBeenCalledWith({ x: 40, y: 220 });
    unregisterFlyTrigger(trigger);
  });

  it('never fires the trigger when canFlyToCart is false -- the sheet\'s own opt-out', () => {
    const trigger = jest.fn();
    registerFlyTrigger(trigger);
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ProductActions product={product} colors={colors} canFlyToCart={false} />);
    });
    const add = tree.root.findAll((n) => n.props?.testID === 'product-tile-add')[0];
    act(() => add.props.onPress({ nativeEvent: { pageX: 40, pageY: 220 } }));
    expect(trigger).not.toHaveBeenCalled();
    unregisterFlyTrigger(trigger);
  });

  it('still calls onAdd (the cart update) with canFlyToCart false -- only the dot is suppressed', () => {
    const trigger = jest.fn();
    const onAdd = jest.fn();
    registerFlyTrigger(trigger);
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ProductActions product={product} colors={colors} onAdd={onAdd} canFlyToCart={false} />);
    });
    const add = tree.root.findAll((n) => n.props?.testID === 'product-tile-add')[0];
    act(() => add.props.onPress({ nativeEvent: { pageX: 40, pageY: 220 } }));
    expect(onAdd).toHaveBeenCalledWith(product);
    expect(trigger).not.toHaveBeenCalled();
    unregisterFlyTrigger(trigger);
  });
});
