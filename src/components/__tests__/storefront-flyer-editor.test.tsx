import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

// flyer-editor.tsx imports flyerErrorMessage from storefront-admin (one error
// vocabulary, one file -- the same place orderErrorMessage lives), and that
// module imports the real supabase client at load time. Nothing here talks to
// a database; this is the same one-liner storefront-editor-screen.test.tsx
// already uses for the same reason.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// The component picks the local photo itself (expo-image-picker is not a
// data-layer concern) and hands the uri to onUploadImage -- exactly the seam
// ContentDrawer uses for the hero photo.
jest.mock('@/lib/photo-picker', () => ({
  pickPhotoFromLibrary: jest.fn(async () => ({ status: 'picked', uri: 'file:///tmp/eid.jpg' })),
}));

import { FlyerEditor, type FlyerFields } from '@/components/storefront/editor/flyer-editor';
import { pickPhotoFromLibrary } from '@/lib/photo-picker';
import type { ShopFlyer } from '@/lib/storefront-admin';
import type { Promotion } from '@/types/models';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function flyer(overrides: Partial<ShopFlyer> = {}): ShopFlyer {
  return {
    id: 'f1',
    imagePath: 'https://cdn.example/solar.jpg',
    headline: '20% off all solar',
    subline: null,
    linkKind: 'none',
    linkValue: null,
    position: 0,
    draft: false,
    promotionId: null,
    ...overrides,
  };
}

const SOLAR: Promotion = {
  id: 'promo-solar',
  shopId: 's1',
  locationId: null,
  name: '20% off solar',
  discountType: 'percentage',
  discountValue: 20,
  scope: 'category',
  scopeValue: 'Solar',
  active: true,
  startsAt: null,
  endsAt: null,
  autoApply: true,
  archivedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
};

const EID: Promotion = { ...SOLAR, id: 'promo-eid', name: 'Eid $2.50 off', discountType: 'fixed', discountValue: 250, scope: 'store', scopeValue: null };

type Props = Parameters<typeof FlyerEditor>[0];

function renderEditor(overrides: Partial<Props> = {}): { tree: ReactTestRenderer; props: Props } {
  const props: Props = {
    flyers: [],
    theme: 'market',
    promotions: [],
    promotionsEnabled: true,
    autoAdvance: false,
    onAutoAdvanceChange: jest.fn(),
    onUploadImage: jest.fn(async () => 'https://cdn.example/uploaded.jpg'),
    onCreate: jest.fn(async () => {}),
    onUpdate: jest.fn(async () => {}),
    onDelete: jest.fn(async () => {}),
    onReorder: jest.fn(async () => {}),
    ...overrides,
  };
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(<FlyerEditor {...props} />);
  });
  return { tree: tree!, props };
}

// Every match, composite and host alike -- `[0]` is the outermost, which is
// the one carrying onPress/onChangeText, the same shape every other component
// test in this repo uses to drive a control.
function byTestID(tree: ReactTestRenderer, id: string) {
  return tree.root.findAll((node) => node.props?.testID === id);
}

// How MANY of a thing are on screen. A testID on a <Pressable> matches the
// composite AND the host View it renders, so byTestID above counts one
// control two or three times -- which would make "exactly one Add button"
// unassertable and, worse, make every absence check pass for the wrong
// reason. Host elements only (`typeof type === 'string'`) is one node per
// rendered control.
function countOf(tree: ReactTestRenderer, id: string): number {
  return tree.root.findAll((node) => node.props?.testID === id && typeof node.type === 'string').length;
}

// The rendered controls whose testID starts with a prefix, in tree order.
function hostIDsStartingWith(tree: ReactTestRenderer, prefix: string): string[] {
  return tree.root
    .findAll((node) => typeof node.props?.testID === 'string' && node.props.testID.startsWith(prefix) && typeof node.type === 'string')
    .map((node) => node.props.testID as string);
}

function screenText(tree: ReactTestRenderer): string {
  return textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
}

// Every word rendered INSIDE one testID'd element, found by walking the
// rendered JSON rather than the fiber tree -- a test instance has no toJSON
// of its own.
function findJSON(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null, id: string): ReactTestRendererJSON | null {
  if (node == null || typeof node === 'string') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findJSON(child, id);
      if (hit) return hit;
    }
    return null;
  }
  if ((node.props as { testID?: string } | undefined)?.testID === id) return node;
  return findJSON(node.children as ReactTestRendererJSON[] | null, id);
}

function textWithin(tree: ReactTestRenderer, id: string): string {
  const found = findJSON(tree.toJSON() as ReactTestRendererJSON, id);
  if (!found) throw new Error(`no element with testID ${id} is on screen`);
  return textsIn(found).join(' ');
}

async function press(tree: ReactTestRenderer, id: string) {
  await act(async () => {
    byTestID(tree, id)[0].props.onPress();
  });
}

async function type(tree: ReactTestRenderer, id: string, text: string) {
  await act(async () => {
    byTestID(tree, id)[0].props.onChangeText(text);
  });
}

describe('FlyerEditor: the list', () => {
  it("lists the shop's flyers in position order, whatever order they arrive in", () => {
    const { tree } = renderEditor({
      flyers: [
        flyer({ id: 'c', headline: 'Third', position: 2 }),
        flyer({ id: 'a', headline: 'First', position: 0 }),
        flyer({ id: 'b', headline: 'Second', position: 1 }),
      ],
    });
    expect(hostIDsStartingWith(tree, 'flyer-editor-row-')).toEqual([
      'flyer-editor-row-a',
      'flyer-editor-row-b',
      'flyer-editor-row-c',
    ]);
  });

  it('says which flyers a customer can see and which are still drafts', () => {
    const { tree } = renderEditor({
      flyers: [flyer({ id: 'a', headline: 'Live one', draft: false }), flyer({ id: 'b', headline: 'Next week', draft: true, position: 1 })],
    });
    // Read each ROW's own words, not the whole screen's -- otherwise "Live"
    // appearing anywhere (the other row, a hint) would satisfy both halves.
    const live = textWithin(tree, 'flyer-editor-row-a');
    const draft = textWithin(tree, 'flyer-editor-row-b');
    expect(live).toMatch(/live/i);
    expect(draft).toMatch(/draft/i);
  });

  it('counts the flyers out of five and still offers Add below five', () => {
    const { tree } = renderEditor({ flyers: [flyer({ id: 'a' }), flyer({ id: 'b', position: 1 }), flyer({ id: 'c', position: 2 })] });
    expect(screenText(tree)).toContain('3 of 5');
    expect(countOf(tree, 'flyer-editor-add')).toBe(1);
  });

  it('stops offering Add at five and says why', () => {
    const { tree } = renderEditor({
      flyers: [0, 1, 2, 3, 4].map((i) => flyer({ id: `f${i}`, position: i })),
    });
    expect(countOf(tree, 'flyer-editor-add')).toBe(0);
    expect(screenText(tree)).toMatch(/5 of 5/);
    expect(screenText(tree)).toMatch(/remove one/i);
  });

  it('removes a flyer through onDelete', async () => {
    const { tree, props } = renderEditor({ flyers: [flyer({ id: 'a' })] });
    await press(tree, 'flyer-editor-delete-a');
    expect(props.onDelete).toHaveBeenCalledWith('a');
  });

  it('reorders by reporting the whole new order, not a single moved id', async () => {
    const { tree, props } = renderEditor({
      flyers: [flyer({ id: 'a', position: 0 }), flyer({ id: 'b', position: 1 }), flyer({ id: 'c', position: 2 })],
    });
    await press(tree, 'flyer-editor-down-a');
    expect(props.onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('offers no way to move the first flyer up or the last one down', () => {
    const { tree } = renderEditor({ flyers: [flyer({ id: 'a', position: 0 }), flyer({ id: 'b', position: 1 })] });
    expect(countOf(tree, 'flyer-editor-up-a')).toBe(0);
    expect(countOf(tree, 'flyer-editor-down-b')).toBe(0);
    // The positive control for the two absences above: the moves that DO
    // exist are rendered, so "found nothing" cannot pass by rendering nothing.
    expect(countOf(tree, 'flyer-editor-down-a')).toBe(1);
    expect(countOf(tree, 'flyer-editor-up-b')).toBe(1);
  });
});

describe('FlyerEditor: the Counter layout shows no flyers', () => {
  it('says flyers will not show, and why, when the shop is on Counter', () => {
    const { tree } = renderEditor({ theme: 'counter', flyers: [flyer()] });
    const text = screenText(tree);
    expect(text).toMatch(/counter/i);
    expect(text).toMatch(/won't show|will not show|no flyers/i);
    expect(text).toMatch(/market|window/i);
  });

  it('still lets a shop on Counter build its flyers rather than hiding the panel', () => {
    const { tree } = renderEditor({ theme: 'counter', flyers: [flyer({ id: 'a' })] });
    expect(countOf(tree, 'flyer-editor-row-a')).toBe(1);
    expect(countOf(tree, 'flyer-editor-add')).toBe(1);
  });

  it('says nothing about Counter when the shop is on Market', () => {
    const market = screenText(renderEditor({ theme: 'market', flyers: [flyer()] }).tree);
    // Positive control: the same assertion against Counter must go the other
    // way, or "no mention of Counter" would pass on an empty screen.
    const counter = screenText(renderEditor({ theme: 'counter', flyers: [flyer()] }).tree);
    expect(counter).toMatch(/counter/i);
    expect(market).not.toMatch(/counter/i);
  });
});

describe('FlyerEditor: the form', () => {
  it('refuses to save a flyer with no image, because a flyer IS the image', async () => {
    const { tree, props } = renderEditor();
    await press(tree, 'flyer-editor-add');
    await type(tree, 'flyer-editor-headline', 'Ciid wanaagsan');
    await press(tree, 'flyer-editor-save');
    expect(props.onCreate).not.toHaveBeenCalled();
    // Positive control for the absence above -- with an image, the same
    // sequence DOES save.
    await press(tree, 'flyer-editor-image-pick');
    await press(tree, 'flyer-editor-save');
    expect(props.onCreate).toHaveBeenCalled();
  });

  it('uploads through the injected uploader and saves what it returned', async () => {
    const onUploadImage = jest.fn(async () => 'https://cdn.example/uploaded.jpg');
    const { tree, props } = renderEditor({ onUploadImage });
    await press(tree, 'flyer-editor-add');
    await press(tree, 'flyer-editor-image-pick');
    expect(pickPhotoFromLibrary).toHaveBeenCalled();
    expect(onUploadImage).toHaveBeenCalledWith('file:///tmp/eid.jpg');
    await press(tree, 'flyer-editor-save');
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ imagePath: 'https://cdn.example/uploaded.jpg' }));
  });

  it('keeps the headline free text, because "Ciid wanaagsan" is not derivable from a discount row', async () => {
    const { tree, props } = renderEditor();
    await press(tree, 'flyer-editor-add');
    await press(tree, 'flyer-editor-image-pick');
    await type(tree, 'flyer-editor-headline', 'Ciid wanaagsan');
    await type(tree, 'flyer-editor-subline', 'Eid stock has landed.');
    await press(tree, 'flyer-editor-save');
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ headline: 'Ciid wanaagsan', subline: 'Eid stock has landed.' })
    );
  });

  it('saves a new flyer as a draft when the shop asks to keep it back', async () => {
    const { tree, props } = renderEditor();
    await press(tree, 'flyer-editor-add');
    await press(tree, 'flyer-editor-image-pick');
    await act(async () => {
      byTestID(tree, 'flyer-editor-draft-toggle')[0].props.onValueChange(true);
    });
    await press(tree, 'flyer-editor-save');
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
  });

  it('carries the category a flyer links to', async () => {
    const { tree, props } = renderEditor();
    await press(tree, 'flyer-editor-add');
    await press(tree, 'flyer-editor-image-pick');
    await press(tree, 'flyer-editor-link-category');
    await type(tree, 'flyer-editor-link-value', 'Solar');
    await press(tree, 'flyer-editor-save');
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ linkKind: 'category', linkValue: 'Solar' }));
  });

  it('edits an existing flyer in place rather than adding a second one', async () => {
    const { tree, props } = renderEditor({ flyers: [flyer({ id: 'a', headline: 'Old' })] });
    await press(tree, 'flyer-editor-edit-a');
    expect(byTestID(tree, 'flyer-editor-headline')[0].props.value).toBe('Old');
    await type(tree, 'flyer-editor-headline', 'New');
    await press(tree, 'flyer-editor-save');
    expect(props.onUpdate).toHaveBeenCalledWith('a', expect.objectContaining({ headline: 'New' }));
    expect(props.onCreate).not.toHaveBeenCalled();
  });
});

describe('FlyerEditor: the offer is picked, never typed', () => {
  it("lists the shop's running offers by name and attaches the one picked", async () => {
    const { tree, props } = renderEditor({ promotions: [SOLAR, EID] });
    await press(tree, 'flyer-editor-add');
    await press(tree, 'flyer-editor-image-pick');
    expect(screenText(tree)).toContain('20% off solar');
    expect(screenText(tree)).toContain('Eid $2.50 off');
    await press(tree, 'flyer-editor-offer-promo-solar');
    await press(tree, 'flyer-editor-save');
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ promotionId: 'promo-solar' }));
  });

  it('offers no free-text field for the offer at all', async () => {
    const { tree } = renderEditor({ promotions: [SOLAR] });
    await press(tree, 'flyer-editor-add');
    expect(countOf(tree, 'flyer-editor-offer-input')).toBe(0);
    // Positive control: the picker for the same offer IS on screen, so the
    // absence above is about the FIELD, not about an empty form.
    expect(countOf(tree, 'flyer-editor-offer-promo-solar')).toBe(1);
  });

  it('leaves the offer empty for an announcement', async () => {
    const { tree, props } = renderEditor({ promotions: [SOLAR] });
    await press(tree, 'flyer-editor-add');
    await press(tree, 'flyer-editor-image-pick');
    await type(tree, 'flyer-editor-headline', 'New opening hours');
    await press(tree, 'flyer-editor-save');
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ promotionId: null }));
  });

  it('says so, rather than showing an empty picker, when no offer is running today', async () => {
    const { tree } = renderEditor({ promotions: [] });
    await press(tree, 'flyer-editor-add');
    expect(screenText(tree)).toMatch(/no offers? (are )?running|nothing running|not running/i);
  });
});

describe('FlyerEditor: a shop without the promotions module', () => {
  it('says the offer picker is unavailable rather than showing nothing at all', async () => {
    const { tree } = renderEditor({ promotionsEnabled: false, promotions: [] });
    await press(tree, 'flyer-editor-add');
    const text = screenText(tree);
    expect(text).toMatch(/promotions/i);
    expect(text).toMatch(/plan|isn't included|not included/i);
  });

  it('offers no offer picker when the module is off', async () => {
    const off = renderEditor({ promotionsEnabled: false, promotions: [SOLAR] });
    await press(off.tree, 'flyer-editor-add');
    expect(countOf(off.tree, 'flyer-editor-offer-promo-solar')).toBe(0);
    // Positive control: identical props with the module ON do render it.
    const on = renderEditor({ promotionsEnabled: true, promotions: [SOLAR] });
    await press(on.tree, 'flyer-editor-add');
    expect(countOf(on.tree, 'flyer-editor-offer-promo-solar')).toBe(1);
  });

  it('can still save an announcement flyer', async () => {
    const { tree, props } = renderEditor({ promotionsEnabled: false, promotions: [] });
    await press(tree, 'flyer-editor-add');
    await press(tree, 'flyer-editor-image-pick');
    await type(tree, 'flyer-editor-headline', 'New stock in');
    await press(tree, 'flyer-editor-save');
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ headline: 'New stock in', promotionId: null }));
  });
});

describe("FlyerEditor: the database's refusal reaches the shop as a sentence", () => {
  it("turns flyer_limit_reached into words a shopkeeper can act on, never the raw token", async () => {
    const onCreate = jest.fn(async () => {
      throw {
        message: 'flyer_limit_reached',
        details: JSON.stringify({ resource: 'storefront_flyers', limit: 5, usage: 5 }),
      };
    });
    const { tree } = renderEditor({ onCreate, flyers: [flyer({ id: 'a' })] });
    await press(tree, 'flyer-editor-add');
    await press(tree, 'flyer-editor-image-pick');
    await press(tree, 'flyer-editor-save');
    const text = screenText(tree);
    expect(text).not.toContain('flyer_limit_reached');
    expect(text).toMatch(/5 flyers/);
    expect(text).toMatch(/remove one/i);
  });

  it('shows any other failure rather than closing the form on a write that never landed', async () => {
    const onCreate = jest.fn(async () => {
      throw new Error('network request failed');
    });
    const { tree } = renderEditor({ onCreate });
    await press(tree, 'flyer-editor-add');
    await press(tree, 'flyer-editor-image-pick');
    await type(tree, 'flyer-editor-headline', 'Ciid wanaagsan');
    await press(tree, 'flyer-editor-save');
    expect(screenText(tree)).toMatch(/could not save|try again/i);
    // The form is still open, still holding what was typed.
    expect(byTestID(tree, 'flyer-editor-headline')[0].props.value).toBe('Ciid wanaagsan');
  });
});

describe('FlyerEditor: auto-advance', () => {
  it('reports the switch through onAutoAdvanceChange', async () => {
    const { tree, props } = renderEditor({ flyers: [flyer({ id: 'a' }), flyer({ id: 'b', position: 1 })] });
    await act(async () => {
      byTestID(tree, 'flyer-editor-auto-advance')[0].props.onValueChange(true);
    });
    expect(props.onAutoAdvanceChange).toHaveBeenCalledWith(true);
  });

  it('shows the switch off when the shop has not turned it on', () => {
    const { tree } = renderEditor({ autoAdvance: false, flyers: [flyer()] });
    expect(byTestID(tree, 'flyer-editor-auto-advance')[0].props.value).toBe(false);
  });

  it("says the customer's own reduced-motion setting wins, so the shop is not surprised", () => {
    const { tree } = renderEditor({ flyers: [flyer()] });
    expect(screenText(tree)).toMatch(/less motion|reduced motion|asks for less/i);
  });
});

// Typed here so a change to FlyerFields that the tests above never exercise
// is still a compile error rather than a silent gap.
const _fieldsShape: FlyerFields = {
  imagePath: 'x',
  headline: null,
  subline: null,
  linkKind: 'none',
  linkValue: null,
  promotionId: null,
  draft: false,
};
void _fieldsShape;
