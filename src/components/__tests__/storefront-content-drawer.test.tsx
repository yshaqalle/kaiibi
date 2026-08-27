import { useState } from 'react';
import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';
import { APP_DOMAIN, slugFromHostname } from '@/lib/storefront-host';

import { Caveat } from '@/components/ui/caveat';
import { ContentDrawer, type ContentDrawerValue, type SlugState } from '@/components/storefront/editor/content-drawer';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

// Lends the process a clipboard for the duration of `run`, and takes it back
// afterwards. Patches `navigator.clipboard` in place where a navigator already
// exists rather than replacing the whole object, because React Native's own
// modules read other things off it mid-render.
async function withClipboard(writeText: jest.Mock, run: () => Promise<void>): Promise<void> {
  const globals = globalThis as { navigator?: { clipboard?: unknown } };
  const hadNavigator = globals.navigator !== undefined;
  const previousClipboard = hadNavigator ? Object.getOwnPropertyDescriptor(globals.navigator, 'clipboard') : undefined;

  if (hadNavigator) Object.defineProperty(globals.navigator, 'clipboard', { value: { writeText }, configurable: true });
  else Object.defineProperty(globals, 'navigator', { value: { clipboard: { writeText } }, configurable: true });

  try {
    await run();
  } finally {
    if (!hadNavigator) delete globals.navigator;
    else if (previousClipboard) Object.defineProperty(globals.navigator, 'clipboard', previousClipboard);
    else delete globals.navigator!.clipboard;
  }
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

  // Was "suggests a slug but never writes it": an unclaimed address is now
  // DERIVED from the name rather than offered as a row to tap, so the
  // assertion that nothing is written on the shop's behalf is exactly the
  // behaviour this replaces. What must still never be overwritten is a value
  // the shop typed itself -- pinned in "the address follows the shop's name"
  // below, where it belongs.
  it('derives an unclaimed address from the shop name instead of leaving it blank', () => {
    const onChange = jest.fn();
    renderDrawer({ shopName: "Xamdi's Electronics", slug: '', onChange });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ slug: 'xamdis-electronics' }));
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

// A CONTROLLED harness, unlike renderDrawer above: `value` is real state that
// the drawer's own onChange writes back into, which is the only way to test
// "the shop typed something and a later rename must not clobber it" -- with a
// frozen `value` prop the clobber is invisible. `shopName`, `slugState`,
// `claimedSlug` and `suffixSuggestions` stay props of the harness so a test
// can change them the way the editor screen does, without remounting (which
// would reset exactly the state under test).
type HarnessProps = {
  shopName: string;
  slugState: SlugState;
  claimedSlug: string | null;
  suffixSuggestions: string[];
};

function mountDrawer(initial: Partial<HarnessProps> & { slug?: string } = {}) {
  const onChange = jest.fn();
  const onClaimSlug = jest.fn();
  let props: HarnessProps = {
    shopName: initial.shopName ?? '',
    slugState: initial.slugState ?? 'idle',
    claimedSlug: initial.claimedSlug ?? null,
    suffixSuggestions: initial.suffixSuggestions ?? [],
  };

  function Harness(p: HarnessProps) {
    const [value, setValue] = useState<ContentDrawerValue>({ ...DEFAULT_VALUE, slug: initial.slug ?? '' });
    return (
      <ContentDrawer
        value={value}
        onChange={(patch) => {
          onChange(patch);
          setValue((v) => ({ ...v, ...patch }));
        }}
        onClaimSlug={onClaimSlug}
        slugState={p.slugState}
        shopName={p.shopName}
        claimedSlug={p.claimedSlug}
        suffixSuggestions={p.suffixSuggestions}
      />
    );
  }

  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<Harness {...props} />);
  });

  const api = {
    onChange,
    onClaimSlug,
    texts: () => textsIn(tree.toJSON() as ReactTestRendererJSON).join(' '),
    find: (testID: string) => tree.root.findAll((n) => n.props?.testID === testID)[0],
    has: (testID: string) => tree.root.findAll((n) => n.props?.testID === testID).length > 0,
    valueOf: (testID: string) => api.find(testID)?.props.value as string | undefined,
    type: (testID: string, text: string) => {
      act(() => {
        api.find(testID).props.onChangeText(text);
      });
    },
    press: (testID: string) => {
      act(() => {
        api.find(testID).props.onPress();
      });
    },
    update: (next: Partial<HarnessProps>) => {
      props = { ...props, ...next };
      act(() => {
        tree.update(<Harness {...props} />);
      });
    },
    /** Every Caveat currently on screen, as props -- tone and action included. */
    caveats: () =>
      tree.root.findAllByType(Caveat).map((n) => n.props as { tone?: string; action?: unknown; children: string }),
    /**
     * A fresh mount with the CURRENT props -- what a shopkeeper gets by
     * leaving the Storefront screen and coming back after renaming the shop
     * somewhere else. Reseeds `value.slug` from `initial.slug` exactly as the
     * editor screen reseeds `slugDraft` from `row.slug` on load
     * (src/app/(admin)/storefront.tsx), so this is a real reload, not a
     * re-render.
     */
    remount: () => {
      act(() => {
        tree.unmount();
      });
      act(() => {
        tree = create(<Harness {...props} />);
      });
    },
  };
  return api;
}

describe('the address follows the shop’s name', () => {
  it('prefills an unclaimed address from the shop’s name', () => {
    const d = mountDrawer({ shopName: 'Xamdi Electronics' });
    expect(d.valueOf('content-drawer-slug-input')).toBe('xamdi-electronics');
  });

  it('re-derives while the name changes and nothing has been claimed', () => {
    const d = mountDrawer({ shopName: 'Xamdi Electronics' });
    d.update({ shopName: 'Xamdi Electronics and Solar' });
    expect(d.valueOf('content-drawer-slug-input')).toBe('xamdi-electronics-and-solar');
  });

  // THE trap this file exists to catch: "has the shop touched this?" must be
  // tracked, not inferred from "does it differ from the derived value" -- a
  // shop that deliberately types the derived value would otherwise lose its
  // edit on the very next keystroke of the name.
  it('never overwrites a value the shop typed, even one identical to the derived name', () => {
    const d = mountDrawer({ shopName: 'Xamdi Electronics' });
    d.type('content-drawer-slug-input', 'xamdi-electronics');
    d.update({ shopName: 'Xamdi Electronics and Solar' });
    expect(d.valueOf('content-drawer-slug-input')).toBe('xamdi-electronics');
    expect(d.onChange).not.toHaveBeenCalledWith(expect.objectContaining({ slug: 'xamdi-electronics-and-solar' }));
  });

  it('never derives over an address that is already claimed', () => {
    const d = mountDrawer({ shopName: 'Xamdi Electronics', slug: 'xamdi', claimedSlug: 'xamdi' });
    d.update({ shopName: 'Burco Traders' });
    expect(d.valueOf('content-drawer-slug-input')).toBe('xamdi');
    expect(d.onChange).not.toHaveBeenCalledWith(expect.objectContaining({ slug: 'burco-traders' }));
  });
});

describe('a taken address costs a suffix, not a rethink', () => {
  // Drives the drawer the way the editor screen does: derive, hear back
  // "taken", and then -- because the assembled value is a NEW value -- hear
  // "checking" again while the server looks at it.
  function collide(suffixSuggestions: string[]) {
    const d = mountDrawer({ shopName: 'Xamdi Electronics', suffixSuggestions });
    d.update({ slugState: 'taken' });
    // Whatever suffix the drawer just applied makes a NEW address, so the
    // editor screen's debounced check goes back to 'checking' -- leaving the
    // prop on 'taken' here would fake a verdict the server never gave.
    d.update({ slugState: 'checking' });
    return d;
  }

  it('keeps the base and opens a suffix field rather than clearing the field', () => {
    const d = collide(['koodbuur', 'hargeisa']);
    expect(d.texts()).toContain('xamdi-electronics-');
    expect(d.has('content-drawer-suffix-input')).toBe(true);
    expect(d.onChange).not.toHaveBeenCalledWith(expect.objectContaining({ slug: '' }));
  });

  it('prefills the suffix from the shop’s primary location', () => {
    const d = collide(['koodbuur', 'hargeisa']);
    expect(d.valueOf('content-drawer-suffix-input')).toBe('koodbuur');
    expect(d.onChange).toHaveBeenCalledWith(expect.objectContaining({ slug: 'xamdi-electronics-koodbuur' }));
  });

  it('offers no number when the shop has no neighbourhood and no city', () => {
    const d = collide([]);
    expect(d.valueOf('content-drawer-suffix-input')).toBe('');
    expect(d.find('content-drawer-suffix-input').props.placeholder).toMatch(/part of town/i);
    // Not "-2", not "-1", not a counter of any shape, anywhere on screen.
    expect(d.texts()).not.toMatch(/xamdi-electronics-\d/);
    expect(d.onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ slug: expect.stringMatching(/-\d+$/) })
    );
  });

  it('treats a chip as a suggestion that free text overrides', () => {
    const d = collide(['koodbuur', 'hargeisa']);
    d.press('content-drawer-suffix-chip-hargeisa');
    expect(d.onChange).toHaveBeenCalledWith(expect.objectContaining({ slug: 'xamdi-electronics-hargeisa' }));
    d.type('content-drawer-suffix-input', 'Road No 1');
    expect(d.onChange).toHaveBeenCalledWith(expect.objectContaining({ slug: 'xamdi-electronics-road-no-1' }));
  });

  it('shows the assembled address in full, as a subdomain and never as a path', () => {
    const d = collide(['koodbuur']);
    const full = textsIn(d.find('content-drawer-full-address').props.children).join('');
    expect(full).toBe(`xamdi-electronics-koodbuur.${APP_DOMAIN}`);
    expect(d.texts()).not.toContain(`${APP_DOMAIN}/`);
    // The address the shop reads here is the address the router resolves.
    expect(slugFromHostname(full)).toBe('xamdi-electronics-koodbuur');
  });

  it('says a suffixed address is taken in the same field, without moving the shop backwards', () => {
    const d = collide(['koodbuur']);
    // The parent re-checks the assembled value and it, too, is gone.
    d.update({ slugState: 'taken' });

    expect(d.texts()).toMatch(/taken too/i);
    // The base is still frozen and the suffix is still theirs to edit --
    // nothing was cleared and no blank box appeared.
    expect(d.texts()).toContain('xamdi-electronics-');
    expect(d.valueOf('content-drawer-suffix-input')).toBe('koodbuur');
    expect(d.texts()).not.toMatch(/clear and try again/i);
    expect(d.onChange).not.toHaveBeenCalledWith(expect.objectContaining({ slug: '' }));
  });

  // Review finding #1: the derivation effect bailed on `claimedSlug` and
  // `slugTouchedRef`, but not on a held `collisionBase` -- and the suffix
  // input never sets `slugTouchedRef`. A rename while a suffix is in play
  // would silently reassemble `value.slug` (and therefore `fullAddress`, and
  // whatever Claim reads) from the FRESH derived name, while the row kept
  // showing the frozen base. The shop would see one address and claim
  // another.
  it('does not let a rename swap the address while a suffix is being typed', () => {
    const d = collide(['koodbuur', 'hargeisa']);
    d.type('content-drawer-suffix-input', 'koodbuur');
    d.update({ shopName: 'Xamdi Electronics and Solar' });

    // The row still reads the frozen base...
    expect(d.texts()).toContain('xamdi-electronics-');
    // ...and the full address -- the exact value Claim submits, since Claim
    // reads value.slug and fullAddress is built from that same value.slug --
    // still describes the SAME address the row shows, not one silently
    // rebuilt from the new name.
    const full = textsIn(d.find('content-drawer-full-address').props.children).join('');
    expect(full).toBe(`xamdi-electronics-koodbuur.${APP_DOMAIN}`);
    expect(d.onChange).not.toHaveBeenCalledWith(expect.objectContaining({ slug: 'xamdi-electronics-and-solar' }));
  });

  // Review finding #2: once a collision opened the suffix field there was no
  // way back to a plain, editable address short of reloading the app. This is
  // the quiet way out -- and, once taken, typing into the reopened field is
  // the shop's own and must survive a later rename, the same rule
  // `slugTouchedRef` already enforces for the ordinary address field.
  it('lets the shop back out of suffix mode to edit the whole address again', () => {
    const d = collide(['koodbuur', 'hargeisa']);
    expect(d.has('content-drawer-suffix-input')).toBe(true);

    d.press('content-drawer-suffix-exit');

    expect(d.has('content-drawer-suffix-input')).toBe(false);
    expect(d.has('content-drawer-slug-input')).toBe(true);

    d.type('content-drawer-slug-input', 'burco-traders');
    d.update({ shopName: 'Something Else Entirely' });
    expect(d.valueOf('content-drawer-slug-input')).toBe('burco-traders');
    expect(d.onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'something-else-entirely' })
    );
  });
});

// The one guarantee in this feature with a cost attached. Everything above is
// convenience -- an address that starts as the shop's name, a suffix instead
// of a blank box. This is the part that breaks something real if it is wrong:
// a shop puts `xamdi-electronics-koodbuur.kaiibi.com` in a WhatsApp status and
// prints it on a card, then renames itself. If the address follows the rename,
// every one of those links is dead and nobody told the shop.
describe('a claimed address does not follow a rename', () => {
  const CLAIMED = 'xamdi-electronics-koodbuur';
  const CLAIMED_ADDRESS = `${CLAIMED}.${APP_DOMAIN}`;

  // The state the editor opens in for a shop that has already claimed: the
  // row's slug IS the draft, because the screen seeds slugDraft from row.slug
  // on load. `shopName` is the name it claimed under.
  function claimed(shopName = 'Xamdi Electronics') {
    return mountDrawer({ shopName, slug: CLAIMED, claimedSlug: CLAIMED });
  }

  function shownAddress(d: ReturnType<typeof mountDrawer>): string {
    return textsIn(d.find('content-drawer-claimed-address').props.children).join('');
  }

  it('renders a claimed address read-only, in full, and as a subdomain', () => {
    const d = claimed();

    expect(shownAddress(d)).toBe(CLAIMED_ADDRESS);
    // Read-only: the field is not something a stray tap can edit.
    expect(d.find('content-drawer-slug-input').props.editable).toBe(false);
    // Still a subdomain, still built from APP_DOMAIN, and still the address
    // the real router resolves -- the thing that gets printed on a card.
    expect(d.texts()).not.toContain(`${APP_DOMAIN}/`);
    expect(slugFromHostname(shownAddress(d))).toBe(CLAIMED);
  });

  // THE test. Both halves matter: Task 2's review found a bug where exactly
  // these two diverged -- the row showed the frozen address while the value
  // Claim submitted had been silently rebuilt from the new name.
  it('keeps the address byte-identical after a rename, on screen AND in what Claim submits', () => {
    const d = claimed();
    d.update({ shopName: 'Burco Traders and Solar' });

    const shown = shownAddress(d);
    expect(shown).toBe(CLAIMED_ADDRESS);

    // What the Claim/Save path would actually send.
    d.press('content-drawer-change-address');
    expect(d.valueOf('content-drawer-slug-input')).toBe(CLAIMED);
    d.press('content-drawer-claim-button');
    expect(d.onClaimSlug).toHaveBeenCalledWith(CLAIMED);

    // Byte-identical to each other, not merely each correct in isolation.
    expect(`${d.onClaimSlug.mock.calls[0][0]}.${APP_DOMAIN}`).toBe(shown);
    // And the new name never reached the draft on the way through.
    expect(d.onChange).not.toHaveBeenCalledWith(expect.objectContaining({ slug: 'burco-traders-and-solar' }));
  });

  it('does not re-derive on a remount after a rename', () => {
    const d = claimed();
    d.update({ shopName: 'Burco Traders' });
    d.remount();

    expect(shownAddress(d)).toBe(CLAIMED_ADDRESS);
    // Not "did not write the new name" -- wrote NOTHING. A claimed address is
    // not a value this component gets to have an opinion about.
    expect(d.onChange).not.toHaveBeenCalled();
  });

  // Property 4, and the one people skip. Silence here reads as a bug: a
  // shopkeeper who expected the address to follow will assume the rename half
  // failed and go looking for what else broke.
  it('says the address did not move and that old links still work', () => {
    const d = claimed();
    d.update({ shopName: 'Burco Traders' });

    const texts = d.texts();
    expect(texts).toMatch(/has not changed/i);
    expect(texts).toMatch(/still work/i);
  });

  // 'wrong' promises an action that removes it. Nothing here is broken and
  // there is nothing to remove -- the address staying put IS the feature.
  it('says it as context, never as an error with a fix attached', () => {
    const d = claimed();
    d.update({ shopName: 'Burco Traders' });

    const note = d.caveats().find((c) => /has not changed/i.test(c.children));
    expect(note).toBeDefined();
    expect(note!.tone).toBe('context');
    expect(note!.action).toBeUndefined();
  });

  // The other half of that copy: do not tell a shop it renamed something when
  // it did not. Claiming `xamdi-electronics-koodbuur` under "Xamdi
  // Electronics" is the ORDINARY suffix outcome, not a rename.
  it('stays quiet while the claimed address still follows the shop’s name', () => {
    expect(claimed().texts()).not.toMatch(/has not changed/i);
    expect(mountDrawer({ shopName: 'Xamdi', slug: 'xamdi', claimedSlug: 'xamdi' }).texts()).not.toMatch(
      /has not changed/i
    );
  });

  it('gives the shop a way to copy the exact address on screen', async () => {
    const d = claimed();
    const writeText = jest.fn().mockResolvedValue(undefined);
    await withClipboard(writeText, async () => {
      await act(async () => {
        d.find('content-drawer-copy-address').props.onPress();
      });
    });
    expect(writeText).toHaveBeenCalledWith(CLAIMED_ADDRESS);
  });

  // Frozen against ACCIDENT, not locked. The warning the editor already shows
  // arrives with the editable field, which is the moment it means something.
  it('still lets the shop change it, deliberately, with the warning intact', () => {
    const d = claimed();
    expect(d.texts()).not.toMatch(/stops working immediately/i);

    d.press('content-drawer-change-address');

    expect(d.find('content-drawer-slug-input').props.editable).not.toBe(false);
    expect(d.texts()).toMatch(/stops working immediately/i);
    expect(d.has('content-drawer-claim-button')).toBe(true);
  });

  // A rename landing MID-CHANGE must not move the address either -- the shop
  // is looking at an editable field, which is precisely when a silent
  // overwrite would be invisible.
  it('does not let a rename reach the field while the shop is changing it', () => {
    const d = claimed();
    d.press('content-drawer-change-address');
    d.update({ shopName: 'Burco Traders' });

    expect(d.valueOf('content-drawer-slug-input')).toBe(CLAIMED);
    expect(d.onChange).not.toHaveBeenCalledWith(expect.objectContaining({ slug: 'burco-traders' }));
  });

  // Backing out of a change must put the address back exactly as claimed --
  // otherwise a half-typed edit would be what the read-only row goes on
  // showing, and the shop would read an address it never claimed.
  it('restores the claimed address exactly when a change is abandoned', () => {
    const d = claimed();
    d.press('content-drawer-change-address');
    d.type('content-drawer-slug-input', 'burco');
    d.press('content-drawer-change-cancel');

    expect(shownAddress(d)).toBe(CLAIMED_ADDRESS);
    expect(d.find('content-drawer-slug-input').props.editable).toBe(false);
  });

  // ...and a rename after that abandoned edit still cannot move it: backing
  // out must clear the "the shop typed this" flag, not leave a stale one that
  // happens to protect the right value by accident.
  it('keeps the address frozen after an abandoned change and a later rename', () => {
    const d = claimed();
    d.press('content-drawer-change-address');
    d.type('content-drawer-slug-input', 'burco');
    d.press('content-drawer-change-cancel');
    d.update({ shopName: 'Burco Traders' });

    expect(shownAddress(d)).toBe(CLAIMED_ADDRESS);
  });
});
