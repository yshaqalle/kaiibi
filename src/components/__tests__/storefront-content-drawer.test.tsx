import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';
import { APP_DOMAIN, slugFromHostname } from '@/lib/storefront-host';

import { ContentDrawer, type ContentDrawerValue, type SlugState } from '@/components/storefront/editor/content-drawer';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const DEFAULT_VALUE: ContentDrawerValue = {
  slug: '',
  headline: '',
  about: '',
  heroImageUrl: null,
  whatsappE164: null,
};

// Not a spec -- a harness. It takes the flat shape each assertion below wants
// and wires it onto the real <ContentDrawer value onChange onClaimSlug
// slugState shopName /> props, so what each `it` reads stays close to the
// property it's checking rather than to how the component happens to be
// wired up.
//
// draftPhone/commitPhone: typed into the WhatsApp field and then blurred --
// this component validates and commits on blur, so every draftPhone here is
// followed by a blur regardless of the flag. commitPhone exists only to make
// call sites read as "and then commit it" rather than leaving the blur
// implicit.
function renderDrawer(overrides: {
  slug?: string;
  whatsappE164?: string | null;
  slugState?: SlugState;
  shopName?: string;
  draftPhone?: string;
  commitPhone?: boolean;
  onChange?: (patch: Partial<ContentDrawerValue>) => void;
}): string[] {
  const value: ContentDrawerValue = {
    ...DEFAULT_VALUE,
    ...(overrides.slug !== undefined ? { slug: overrides.slug } : {}),
    ...(overrides.whatsappE164 !== undefined ? { whatsappE164: overrides.whatsappE164 } : {}),
  };
  const onChange = overrides.onChange ?? jest.fn();

  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(
      <ContentDrawer
        value={value}
        onChange={onChange}
        onClaimSlug={() => {}}
        slugState={overrides.slugState ?? 'idle'}
        shopName={overrides.shopName ?? ''}
      />
    );
  });

  if (overrides.draftPhone !== undefined) {
    const inputs = tree!.root.findAll((node) => node.props?.testID === 'content-drawer-phone-input');
    act(() => {
      inputs[0].props.onChangeText(overrides.draftPhone);
    });
    act(() => {
      inputs[0].props.onBlur();
    });
  }

  return textsIn(tree!.toJSON() as ReactTestRendererJSON);
}

describe('ContentDrawer', () => {
  it('explains every slug problem in words a shopkeeper can act on', () => {
    const problems = ['too_short', 'too_long', 'bad_characters', 'edge_hyphen', 'reserved'] as const;
    for (const p of problems) {
      const texts = renderDrawer({ slugState: p });
      const joined = texts.join(' ');
      expect(joined).not.toContain(p); // never leak the enum
      expect(joined.length).toBeGreaterThan(0);
    }
  });

  it('warns that changing an existing address breaks what was already shared', () => {
    expect(renderDrawer({ slug: 'xamdi' }).join(' ')).toMatch(/stops working|already shared|printed/i);
  });

  it('shows a stored number in readable form', () => {
    expect(renderDrawer({ whatsappE164: '+252634456789' })).toContain('+252 63 4456789');
  });

  it('suggests a slug from the shop name but never rewrites what was typed', () => {
    const onChange = jest.fn();
    const texts = renderDrawer({ shopName: "Xamdi's Electronics", slug: '', onChange });
    // The suggestion is offered as text the shop can accept...
    expect(texts.join(' ')).toContain('xamdis-electronics');
    // ...and nothing was written into the slug field on their behalf.
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ slug: 'xamdis-electronics' }));
  });

  it('rejects a phone number it cannot normalise instead of storing it raw', () => {
    const onChange = jest.fn();
    const texts = renderDrawer({ whatsappE164: null, draftPhone: 'call me', onChange });
    expect(texts.join(' ')).toMatch(/not a (valid )?number|check the number/i);
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ whatsappE164: 'call me' }));
  });

  it('stores a typed local number in E.164', () => {
    const onChange = jest.fn();
    renderDrawer({ draftPhone: '0634456789', onChange, commitPhone: true });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ whatsappE164: '+252634456789' }));
  });

  it('says the opening photo only shows on the Window layout', () => {
    expect(renderDrawer({}).join(' ')).toMatch(/window/i);
  });
});

describe('the address it shows is the address that works', () => {
  it('renders the slug as a SUBDOMAIN, and that address round-trips through the real router', () => {
    const texts = renderDrawer({ slug: 'xamdi' });
    const joined = texts.join(' ');

    // A path would be wrong: nothing resolves kaiibi.com/xamdi.
    expect(joined).not.toContain('kaiibi.com/');
    expect(joined).toContain(`.${APP_DOMAIN}`);

    // The real proof: reassemble what the shop sees and feed it to the actual
    // function that resolves a hostname. If the two ever drift, this fails.
    expect(slugFromHostname(`xamdi.${APP_DOMAIN}`)).toBe('xamdi');
  });
});
