import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

import { CheckoutForm } from '@/components/storefront/checkout-form';
import { paletteColors } from '@/lib/storefront-catalog';
import type { StorefrontCart } from '@/lib/storefront-cart';
import type { PublicDeliveryArea } from '@/types/models';

// `@testing-library/react-native` is not installed in this repo -- flatten
// the rendered tree to strings instead, same helper cart-sheet.test.tsx uses.
function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const colors = paletteColors('ink');

const cart: StorefrontCart = {
  slug: 'xamdi',
  lines: [
    { productId: 'p1', name: 'Soap', unitPriceCents: 500, quantity: 2 }, // 1000
    { productId: 'p2', name: 'Oil', unitPriceCents: 1200, quantity: 1 }, // 1200
  ],
}; // goods subtotal: 2200

const areas: PublicDeliveryArea[] = [
  { name: 'Near the stadium', feeCents: 300 },
  { name: 'Outside town', feeCents: 800 },
];

function renderForm(opts?: {
  offersDelivery?: boolean;
  areas?: PublicDeliveryArea[];
  onSubmit?: jest.Mock;
  submitting?: boolean;
}) {
  const onSubmit = opts?.onSubmit ?? jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <CheckoutForm
        cart={cart}
        colors={colors}
        offersDelivery={opts?.offersDelivery ?? true}
        areas={opts?.areas ?? areas}
        submitting={opts?.submitting ?? false}
        onSubmit={onSubmit}
      />,
    );
  });
  return { tree, onSubmit };
}

function texts(tree: ReactTestRenderer): string[] {
  return textsIn(tree.toJSON() as ReactTestRendererJSON);
}

function findByTestId(tree: ReactTestRenderer, testID: string) {
  return tree.root.findAll((node) => node.props?.testID === testID);
}

function setText(tree: ReactTestRenderer, testID: string, value: string) {
  const [node] = findByTestId(tree, testID);
  act(() => node.props.onChangeText(value));
}

function press(tree: ReactTestRenderer, testID: string) {
  const [node] = findByTestId(tree, testID);
  act(() => node.props.onPress());
}

function fillName(tree: ReactTestRenderer, value = 'Amina Warsame') {
  setText(tree, 'checkout-form-name-input', value);
}

function fillPhone(tree: ReactTestRenderer, value = '0634456789') {
  setText(tree, 'checkout-form-phone-input', value);
}

describe('CheckoutForm', () => {
  // ── Property 1: name and phone ──────────────────────────────────────────

  it('requires a name before it will submit', () => {
    const { tree, onSubmit } = renderForm();
    fillPhone(tree);
    press(tree, 'checkout-form-submit');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(texts(tree).some((t) => /name/i.test(t))).toBe(true);
  });

  it('requires a phone before it will submit', () => {
    const { tree, onSubmit } = renderForm();
    fillName(tree);
    press(tree, 'checkout-form-submit');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(texts(tree).some((t) => /phone/i.test(t))).toBe(true);
  });

  it('normalises a phone through toE164 and submits the E.164 form, never the raw digits typed', () => {
    const { tree, onSubmit } = renderForm();
    fillName(tree);
    fillPhone(tree, '0634456789');
    press(tree, 'checkout-form-submit');
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ phone: '+252634456789' }));
  });

  it('displays a normalised phone through formatE164ForDisplay once it recognises the number', () => {
    const { tree } = renderForm();
    fillPhone(tree, '0634456789');
    const [input] = findByTestId(tree, 'checkout-form-phone-input');
    act(() => input.props.onBlur());
    // TextInput's value is a prop, not a rendered text child -- read it off
    // the node itself, the same way search-row.test.tsx does.
    const [after] = findByTestId(tree, 'checkout-form-phone-input');
    expect(after.props.value).toBe('+252 63 4456789');
  });

  // toE164 refuses an ambiguous unmarked foreign number (no +, no 00, more
  // than 9 digits) rather than guessing a country -- see phone-e164.ts. The
  // form must reject it the same way: an explanation, never a raw store.
  it('rejects a phone toE164 will not normalise, with an explanation, and never submits it raw', () => {
    const { tree, onSubmit } = renderForm();
    fillName(tree);
    fillPhone(tree, '12345678901234');
    press(tree, 'checkout-form-submit');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(texts(tree).some((t) => /phone/i.test(t))).toBe(true);
  });

  // ── Property 2: collect or deliver ──────────────────────────────────────

  it('is collect by default and offers no area fields until deliver is chosen', () => {
    const { tree } = renderForm();
    expect(findByTestId(tree, 'checkout-form-area-Near the stadium')).toHaveLength(0);
    expect(findByTestId(tree, 'checkout-form-landmark-input')).toHaveLength(0);
  });

  it('lists the shop\'s own delivery areas once deliver is chosen', () => {
    const { tree } = renderForm();
    press(tree, 'checkout-form-fulfilment-deliver');
    expect(texts(tree)).toContain('Near the stadium');
    expect(texts(tree)).toContain('Outside town');
  });

  it('asks for a landmark once deliver is chosen, not a free-text address', () => {
    const { tree } = renderForm();
    press(tree, 'checkout-form-fulfilment-deliver');
    // findAll can return both the composite TextInput and its host node for
    // one field -- delivery-editor.test.tsx hits the same shape and asserts
    // via [0] rather than an exact count; presence, not cardinality, is what
    // this property is about.
    expect(findByTestId(tree, 'checkout-form-landmark-input').length).toBeGreaterThan(0);
  });

  it('requires an area to be picked before a delivery order submits', () => {
    const { tree, onSubmit } = renderForm();
    fillName(tree);
    fillPhone(tree);
    press(tree, 'checkout-form-fulfilment-deliver');
    setText(tree, 'checkout-form-landmark-input', 'Behind the blue gate');
    press(tree, 'checkout-form-submit');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('requires a landmark before a delivery order submits', () => {
    const { tree, onSubmit } = renderForm();
    fillName(tree);
    fillPhone(tree);
    press(tree, 'checkout-form-fulfilment-deliver');
    press(tree, 'checkout-form-area-Near the stadium');
    press(tree, 'checkout-form-submit');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the chosen area name and landmark for a delivery order', () => {
    const { tree, onSubmit } = renderForm();
    fillName(tree);
    fillPhone(tree);
    press(tree, 'checkout-form-fulfilment-deliver');
    press(tree, 'checkout-form-area-Near the stadium');
    setText(tree, 'checkout-form-landmark-input', 'Behind the blue gate');
    press(tree, 'checkout-form-submit');
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        fulfilment: 'deliver',
        deliveryArea: 'Near the stadium',
        deliveryLandmark: 'Behind the blue gate',
      }),
    );
  });

  it('submits collect orders with no area and no landmark', () => {
    const { tree, onSubmit } = renderForm();
    fillName(tree);
    fillPhone(tree);
    press(tree, 'checkout-form-submit');
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ fulfilment: 'collect', deliveryArea: null, deliveryLandmark: null }),
    );
  });

  // ── Property 3: the fee appears the moment an area is chosen ───────────

  it('shows only the goods total, no delivery line, before an area is chosen', () => {
    const { tree } = renderForm();
    press(tree, 'checkout-form-fulfilment-deliver');
    const t = texts(tree);
    expect(t).toContain('$22.00'); // goods subtotal
    expect(t).not.toContain('Delivery');
  });

  it('shows the delivery fee and the new total the moment an area is chosen', () => {
    const { tree } = renderForm();
    press(tree, 'checkout-form-fulfilment-deliver');
    press(tree, 'checkout-form-area-Near the stadium');
    const t = texts(tree);
    expect(t).toContain('Delivery');
    expect(t).toContain('$3.00'); // the area's fee
    expect(t).toContain('$25.00'); // 22.00 goods + 3.00 delivery
  });

  it('updates the fee and total when a different area is chosen', () => {
    const { tree } = renderForm();
    press(tree, 'checkout-form-fulfilment-deliver');
    press(tree, 'checkout-form-area-Near the stadium');
    press(tree, 'checkout-form-area-Outside town');
    const t = texts(tree);
    expect(t).toContain('$8.00');
    expect(t).toContain('$30.00'); // 22.00 + 8.00
  });

  // ── Property 4: collection-only shops render no area fields at all ─────

  it('renders no fulfilment choice or area fields when the shop does not offer delivery', () => {
    const { tree } = renderForm({ offersDelivery: false });
    expect(findByTestId(tree, 'checkout-form-fulfilment-deliver')).toHaveLength(0);
    expect(findByTestId(tree, 'checkout-form-fulfilment-collect')).toHaveLength(0);
    expect(findByTestId(tree, 'checkout-form-landmark-input')).toHaveLength(0);
  });

  it('renders no fulfilment choice or area fields when the shop offers delivery but lists no areas', () => {
    const { tree } = renderForm({ offersDelivery: true, areas: [] });
    expect(findByTestId(tree, 'checkout-form-fulfilment-deliver')).toHaveLength(0);
    expect(findByTestId(tree, 'checkout-form-fulfilment-collect')).toHaveLength(0);
  });

  it('always submits collect-only orders as collect when the shop offers no delivery', () => {
    const { tree, onSubmit } = renderForm({ offersDelivery: false });
    fillName(tree);
    fillPhone(tree);
    press(tree, 'checkout-form-submit');
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ fulfilment: 'collect' }));
  });

  // ── Property 6: payment is on collection or delivery ────────────────────

  it('states plainly that payment is on collection or delivery', () => {
    const { tree } = renderForm();
    expect(texts(tree).some((t) => /pay.*collection.*delivery/i.test(t))).toBe(true);
  });

  // Regression: error text used to hard-code clay's own accent (#98452a) as
  // the error colour on every palette, so a shop on any other palette saw an
  // unrelated rust-brown. Error text must come from the palette handed in
  // (colors.danger), never a literal -- proven here on 'saffron', a palette
  // whose own accent (#8a5a05) is the out-of-stock amber, to also confirm the
  // error colour is never confused with that.
  it("renders error text in the given palette's danger colour, never a hard-coded literal", () => {
    const saffron = paletteColors('saffron');
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <CheckoutForm
          cart={cart}
          colors={saffron}
          offersDelivery={true}
          areas={areas}
          submitting={false}
          onSubmit={jest.fn()}
        />,
      );
    });
    press(tree, 'checkout-form-submit');
    const [nameErrorNode] = tree.root.findAll(
      (node) =>
        typeof node.props?.children === 'string' &&
        node.props.children === 'Add your name so the shop knows who is ordering.',
    );
    const flatStyle = [nameErrorNode.props.style].flat(Infinity).reduce((acc, s) => ({ ...acc, ...s }), {});
    expect(flatStyle.color).toBe(saffron.danger);
    expect(flatStyle.color).not.toBe('#98452a');
    expect(flatStyle.color).not.toBe(saffron.accent); // saffron's accent IS the out-of-stock amber
  });

  // ── B1: a double tap must not place two orders ──────────────────────────

  it('disables the submit control while an order is being placed', () => {
    const { tree } = renderForm({ submitting: true });
    const [submit] = findByTestId(tree, 'checkout-form-submit');
    expect(submit.props.disabled).toBe(true);
  });

  it('leaves the submit control enabled when nothing is in flight', () => {
    const { tree } = renderForm({ submitting: false });
    const [submit] = findByTestId(tree, 'checkout-form-submit');
    expect(submit.props.disabled).toBe(false);
  });

  // ── B5: the optional note ────────────────────────────────────────────────
  // place_storefront_order already reads p_customer->>'note' and has its own
  // invalid_note code (20260927000000_place_order.sql) -- this only proves
  // the form collects it and hands it to onSubmit, trimmed, the same
  // convention deliveryLandmark follows.

  it('submits a trimmed note when the customer writes one', () => {
    const { tree, onSubmit } = renderForm();
    fillName(tree);
    fillPhone(tree);
    setText(tree, 'checkout-form-note-input', '  Ring the bell, don\'t call  ');
    press(tree, 'checkout-form-submit');
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ note: "Ring the bell, don't call" }));
  });

  it('submits a null note, not an empty string, when the customer leaves it blank', () => {
    const { tree, onSubmit } = renderForm();
    fillName(tree);
    fillPhone(tree);
    press(tree, 'checkout-form-submit');
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ note: null }));
  });

  it('never requires a note before it will submit', () => {
    const { tree, onSubmit } = renderForm();
    fillName(tree);
    fillPhone(tree);
    press(tree, 'checkout-form-submit');
    expect(onSubmit).toHaveBeenCalled();
  });
});
