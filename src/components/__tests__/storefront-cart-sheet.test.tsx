import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { CartSheet } from '@/components/storefront/cart-sheet';
import { paletteColors } from '@/lib/storefront-catalog';
import type { StorefrontCart } from '@/lib/storefront-cart';

// `@testing-library/react-native` is not installed in this repo (see
// list-card.test.tsx for the same pattern) -- flatten the rendered tree to
// strings instead of reaching for a query library the repo does not have.
function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const colors = paletteColors('ink');

const soap = { productId: 'p1', name: 'Soap', unitPriceCents: 500, quantity: 2 };
const oil = { productId: 'p2', name: 'Oil', unitPriceCents: 1200, quantity: 1 };

const cartWithLines: StorefrontCart = { slug: 'xamdi', lines: [soap, oil] };
const emptyCart: StorefrontCart = { slug: 'xamdi', lines: [] };

function renderSheet(cart: StorefrontCart, opts?: { visible?: boolean; onChangeQuantity?: jest.Mock; onClose?: jest.Mock }) {
  const onChangeQuantity = opts?.onChangeQuantity ?? jest.fn();
  const onClose = opts?.onClose ?? jest.fn();
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <CartSheet
        visible={opts?.visible ?? true}
        onClose={onClose}
        cart={cart}
        colors={colors}
        onChangeQuantity={onChangeQuantity}
      />
    );
  });
  return { tree, onChangeQuantity, onClose };
}

describe('CartSheet', () => {
  it('lists each line with its name and a subtotal', () => {
    const { tree } = renderSheet(cartWithLines);
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('Soap');
    expect(texts).toContain('Oil');
    // 500 * 2 = 1000 -> $10.00; 1200 * 1 -> $12.00.
    expect(texts).toContain('$10.00');
    expect(texts).toContain('$12.00');
  });

  it('shows the cart subtotal', () => {
    const { tree } = renderSheet(cartWithLines);
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    // 1000 + 1200 = 2200 -> $22.00.
    expect(texts).toContain('$22.00');
  });

  // Property: delivery cannot be known until an area is chosen at checkout.
  // Saying so plainly (asserted below) is correct; showing a delivery LINE or
  // a grand total that folds it in is not -- either would read as a real
  // number a customer could mistake for what they will pay.
  it('says why delivery is absent instead of showing a delivery line or a total', () => {
    const { tree } = renderSheet(cartWithLines);
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts.some((t) => /area you choose at checkout/i.test(t))).toBe(true);
    expect(texts).not.toContain('Total');
    expect(texts).not.toContain('Delivery');
  });

  // Property: nothing is charged now -- this has to be said plainly, not left
  // implied by the absence of a pay button.
  it('says plainly that nothing is charged now', () => {
    const { tree } = renderSheet(cartWithLines);
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts.some((t) => /nothing is charged/i.test(t))).toBe(true);
  });

  it('increases a line quantity through the stepper', () => {
    const { tree, onChangeQuantity } = renderSheet(cartWithLines);
    const increase = tree.root.findAll((node) => node.props?.testID === 'cart-line-increase-p1');
    act(() => increase[0].props.onPress());
    expect(onChangeQuantity).toHaveBeenCalledWith('p1', 3);
  });

  it('decreases a line quantity through the stepper', () => {
    const { tree, onChangeQuantity } = renderSheet(cartWithLines);
    const decrease = tree.root.findAll((node) => node.props?.testID === 'cart-line-decrease-p1');
    act(() => decrease[0].props.onPress());
    expect(onChangeQuantity).toHaveBeenCalledWith('p1', 1);
  });

  // Driving a line to zero is how a customer removes it -- setQuantity in
  // storefront-cart.ts already treats zero as "delete this line", so the
  // sheet just has to pass the number through, not special-case it.
  it('decreasing a line already at quantity one asks for zero, not a negative number', () => {
    const { tree, onChangeQuantity } = renderSheet({ slug: 'xamdi', lines: [oil] });
    const decrease = tree.root.findAll((node) => node.props?.testID === 'cart-line-decrease-p2');
    act(() => decrease[0].props.onPress());
    expect(onChangeQuantity).toHaveBeenCalledWith('p2', 0);
  });

  it('shows an honest empty state rather than a bare sheet', () => {
    const { tree } = renderSheet(emptyCart);
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('Your basket is empty.');
  });

  it('renders nothing when not visible', () => {
    const { tree } = renderSheet(cartWithLines, { visible: false });
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).not.toContain('Soap');
  });

  it('calls onClose when the close control is pressed', () => {
    const { tree, onClose } = renderSheet(cartWithLines);
    const close = tree.root.findAll((node) => node.props?.testID === 'cart-sheet-close');
    act(() => close[0].props.onPress());
    expect(onClose).toHaveBeenCalled();
  });
});
