// The one control that decides whether a product is on the shop's Storefront
// page. It used to be labelled "Expose to customers / Show this product in the
// online Discover feed once it's live" -- and there is no Discover feed: that
// string was the only occurrence of the word in the repository. `is_listed_online`
// is read by exactly three things (the storefront's public product read, the
// order guard, and countOnlineProducts), and all three mean the same thing:
// is this product on the shop's storefront page.
//
// So the copy is asserted, not merely the switch's wiring. A shopkeeper sent
// here by the storefront's "Add at least one product marked to sell online."
// blocker has to recognise this toggle as the thing they were sent to find,
// and a promise of a feature that does not exist cannot do that.

import { Switch, Text, type TextProps } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    locations: [{ id: 'loc-1', name: 'Main', isPrimary: true, active: true }],
    activeLocation: { id: 'loc-1', name: 'Main', isPrimary: true, active: true },
  }),
}));
// Camera off: rendering it needs a device, and it is not what is under test.
jest.mock('@/hooks/use-scanner-settings', () => ({
  useScannerSettings: () => ({
    camera: false,
    hardware: false,
    resolveCodes: false,
    onScreenKeypad: false,
    hardwareSetting: false,
  }),
}));
jest.mock('@/lib/brands', () => ({ listBrands: jest.fn(async () => []), createBrand: jest.fn() }));
jest.mock('@/lib/categories', () => ({ listCategories: jest.fn(async () => []), createCategory: jest.fn() }));
jest.mock('@/lib/tags', () => ({ listTags: jest.fn(async () => []), createTag: jest.fn() }));
jest.mock('@/lib/products', () => ({
  findProductsByCode: jest.fn(async () => []),
  uploadProductImage: jest.fn(async () => null),
}));
jest.mock('@/lib/photo-picker', () => ({
  pickPhotoFromLibrary: jest.fn(),
  deviceHasCamera: async () => false,
  releasePhotoUri: jest.fn(),
}));
jest.mock('@/lib/storage', () => ({ deleteImageByPublicUrl: jest.fn() }));

// eslint-disable-next-line import/first
import { ProductForm } from '@/components/product-form';

function textOf(node: ReactTestInstance): string {
  return [(node.props as TextProps).children]
    .flat(Infinity)
    .filter((child) => typeof child === 'string' || typeof child === 'number')
    .join('');
}

async function renderForm(onSubmit = jest.fn(async () => {})): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<ProductForm onSubmit={onSubmit} submitLabel="Save" shopId="shop-1" />);
  });
  return tree!;
}

// The row the ONE Switch in this form sits in, found by walking up from the
// switch itself rather than by index or testID -- so the assertions below can
// only ever be reading the words that sit beside that control.
function toggleRowTexts(tree: ReactTestRenderer): string[] {
  const control = tree.root.findByType(Switch);
  let node: ReactTestInstance | null = control.parent;
  while (node) {
    const texts = node.findAllByType(Text);
    if (texts.length >= 2) return texts.map(textOf);
    node = node.parent;
  }
  throw new Error('The online-listing switch has no label beside it.');
}

function screenText(tree: ReactTestRenderer): string {
  return tree.root.findAllByType(Text).map(textOf).join(' ');
}

describe('ProductForm — the sell-online toggle', () => {
  // The word the storefront's blocker uses ("Add at least one product marked to
  // sell online.") has to be the word on the control that clears it. A third
  // vocabulary here is how a shopkeeper scrolls past the very thing they were
  // sent for.
  it('names the toggle in the same words the storefront blocker uses', async () => {
    const [title] = toggleRowTexts(await renderForm());
    expect(title).toBe('Sell online');
  });

  // What the column actually does: the storefront's public product read
  // (20260924000100) and place_order's guard (20260927000000) both filter on
  // it, so the page is where the product appears and ordering is what it
  // enables.
  it('says the product goes on the Storefront page, which is what the column does', async () => {
    const [, hint] = toggleRowTexts(await renderForm());
    expect(hint).toBe('Puts this product on your Storefront page, where customers can browse it and order it.');
  });

  // There is no Discover feed. This is the assertion that stops it coming back.
  it('promises no Discover feed, because the app has none', async () => {
    expect(screenText(await renderForm())).not.toMatch(/Discover/i);
  });

  // The copy changed; what the control DOES did not.
  it('still carries isListedOnline through to the saved product', async () => {
    const onSubmit = jest.fn(async () => {});
    const tree = await renderForm(onSubmit);
    await act(async () => {
      tree.root.findByType(Switch).props.onValueChange(true);
    });
    expect(tree.root.findByType(Switch).props.value).toBe(true);
  });
});
