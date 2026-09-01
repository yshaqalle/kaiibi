import type { ComponentProps } from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { PublishBar } from '@/components/storefront/editor/publish-bar';
import type { PublishBlocker } from '@/lib/storefront-admin';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

// Same shape as textsIn, but stops and returns the NODE the moment its whole
// flattened text content is exactly `text` -- rather than the string. A
// Pressable's rendered host View wraps a single Text child, so the View is
// the first (shallowest) node whose flattened text is exactly this one
// string; its props (accessibilityState, disabled) are what a caller
// actually wants to inspect. Requiring an EXACT single-string match (not a
// substring) keeps this from matching a shared ancestor with several texts.
function findByText(
  node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null,
  text: string
): ReactTestRendererJSON {
  if (node == null || typeof node === 'string') {
    throw new Error(`findByText: no node contains exactly "${text}"`);
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      try {
        return findByText(child, text);
      } catch {
        // keep looking at the next sibling
      }
    }
    throw new Error(`findByText: no node contains exactly "${text}"`);
  }
  const texts = textsIn(node);
  if (texts.length === 1 && texts[0] === text) return node;
  return findByText(node.children as ReactTestRendererJSON[] | null, text);
}

type PublishBarProps = ComponentProps<typeof PublishBar>;

const DEFAULT_PROPS: PublishBarProps = {
  status: 'draft',
  blockers: [] as PublishBlocker[],
  dirty: false,
  // No claimed address by default, so the share block this file says nothing
  // about stays out of every assertion here. It has its own test file
  // (storefront-share-live-page.test.tsx).
  slug: null,
  onEdit: jest.fn(),
  onFocusBlocker: jest.fn(),
  onGoToInventory: jest.fn(),
  onTogglePreview: jest.fn(),
  onPublish: jest.fn(),
  onUnpublish: jest.fn(),
};

function renderBar(overrides: Partial<PublishBarProps> = {}) {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(<PublishBar {...DEFAULT_PROPS} {...overrides} />);
  });
  return tree!;
}

function renderBarTexts(overrides: Partial<PublishBarProps> = {}) {
  const tree = renderBar(overrides);
  return textsIn(tree.toJSON() as ReactTestRendererJSON);
}

// Every caveat action the bar rendered, as { label, press } -- found through
// the pressable Caveat actually draws (accessibilityRole="link"), so a
// blocker whose action is never rendered cannot pass these.
function caveatActions(tree: ReturnType<typeof create>) {
  return tree.root
    .findAll((node) => node.props?.accessibilityRole === 'link' && typeof node.props?.onPress === 'function')
    .map((node) => ({
      label: node
        .findAllByType(Text)
        .flatMap((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]))
        .filter((c) => typeof c === 'string')
        .join('')
        .trim(),
      press: () => act(() => node.props.onPress()),
    }));
}

describe('PublishBar', () => {
  it('never disables Publish, even with every blocker present', () => {
    const tree = renderBar({ blockers: ['no_slug', 'no_whatsapp', 'no_products'] });
    const publish = findByText(tree.toJSON() as ReactTestRendererJSON, 'Publish');
    expect(publish.props.accessibilityState?.disabled).toBeFalsy();
    expect(publish.props.disabled).toBeFalsy();
  });

  it('distinguishes a draft from a live page with unsaved edits', () => {
    expect(renderBarTexts({ status: 'draft', dirty: false })).toContain('Draft');
    expect(renderBarTexts({ status: 'live', dirty: true })).toContain('Unsaved changes');
  });

  it('reads Live for a published page with nothing unsaved', () => {
    const texts = renderBarTexts({ status: 'live', dirty: false });
    expect(texts).toContain('Live');
    expect(texts).not.toContain('Unsaved changes');
  });

  // The property this file exists for: pressing Publish with blockers still
  // fires onPublish. The bar hands the decision of what to do about the
  // blockers to the caller -- it never silently swallows the tap.
  it('calls onPublish when pressed, blockers or not', () => {
    const onPublish = jest.fn();
    const tree = renderBar({ blockers: ['no_slug'], onPublish });
    const trigger = tree.root.findAll((node) => node.props?.testID === 'publish-bar-publish');
    act(() => {
      trigger[0].props.onPress();
    });
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  // Plain words, never the raw enum -- a shopkeeper reads sentences, not
  // internal identifiers.
  it('explains each blocker in plain words instead of the raw enum', () => {
    const texts = renderBarTexts({ blockers: ['no_slug', 'no_whatsapp', 'no_products'] });
    const joined = texts.join(' ');
    expect(joined).not.toMatch(/no_slug|no_whatsapp|no_products/);
    expect(joined.toLowerCase()).toMatch(/address/);
    expect(joined.toLowerCase()).toMatch(/whatsapp/);
    expect(joined.toLowerCase()).toMatch(/product/);
  });

  it('renders no blocker caveats when nothing is blocking', () => {
    const texts = renderBarTexts({ blockers: [] });
    expect(texts.join(' ').toLowerCase()).not.toMatch(/address|whatsapp number|product/);
  });

  // Unpublishing is reversible (a two-step confirm, not instant) and says
  // plainly what happens: the page stops being reachable.
  it('unpublishing needs a confirm and says plainly the page stops being reachable', () => {
    const onUnpublish = jest.fn();
    const tree = renderBar({ status: 'live', onUnpublish });

    const unpublishButton = tree.root.findAll((node) => node.props?.testID === 'publish-bar-unpublish');
    act(() => {
      unpublishButton[0].props.onPress();
    });
    expect(onUnpublish).not.toHaveBeenCalled();

    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ').toLowerCase();
    expect(texts).toMatch(/reach/);

    const confirmButton = tree.root.findAll((node) => node.props?.testID === 'publish-bar-unpublish-confirm');
    act(() => {
      confirmButton[0].props.onPress();
    });
    expect(onUnpublish).toHaveBeenCalledTimes(1);
  });

  // caveat.tsx's own header: a 'wrong' caveat with no fix trains people to
  // ignore the whole family. Every blocker here is tone="wrong", so every one
  // of them must carry an action that does something.
  it('gives every blocker an action that fires', () => {
    const onFocusBlocker = jest.fn();
    const onGoToInventory = jest.fn();
    const actions = caveatActions(
      renderBar({ blockers: ['no_slug', 'no_whatsapp', 'no_products'], onFocusBlocker, onGoToInventory })
    );
    expect(actions).toHaveLength(3);
    actions.forEach((a) => a.press());
    expect(onFocusBlocker.mock.calls.length + onGoToInventory.mock.calls.length).toBe(3);
  });

  // The fix for no_products is a product marked to sell online, which lives in
  // Inventory -- a different screen. So the label says where it goes, and the
  // press actually goes there.
  it('sends the no-products blocker to Inventory, and says so on the label', () => {
    const onFocusBlocker = jest.fn();
    const onGoToInventory = jest.fn();
    const actions = caveatActions(renderBar({ blockers: ['no_products'], onFocusBlocker, onGoToInventory }));

    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe('Go to Inventory →');
    actions[0].press();
    expect(onGoToInventory).toHaveBeenCalledTimes(1);
    expect(onFocusBlocker).not.toHaveBeenCalled();
  });

  // The other two are fixed by a field in this very drawer, so "Fix this" is
  // honest for them -- and it must land on THEIR field, which is why the
  // blocker travels with the call.
  it('keeps the slug and WhatsApp blockers on the in-place Fix this', () => {
    const onFocusBlocker = jest.fn();
    const onGoToInventory = jest.fn();
    const actions = caveatActions(renderBar({ blockers: ['no_slug', 'no_whatsapp'], onFocusBlocker, onGoToInventory }));

    expect(actions.map((a) => a.label)).toEqual(['Fix this →', 'Fix this →']);
    actions.forEach((a) => a.press());
    expect(onFocusBlocker.mock.calls).toEqual([['no_slug'], ['no_whatsapp']]);
    expect(onGoToInventory).not.toHaveBeenCalled();
  });

  it('offers no Unpublish action for a page that was never published', () => {
    const tree = renderBar({ status: 'draft' });
    const unpublishButton = tree.root.findAll((node) => node.props?.testID === 'publish-bar-unpublish');
    expect(unpublishButton).toHaveLength(0);
  });
});

// Preview and Edit are NAVIGATION AIDS for the stacked layout: Edit opens the
// content drawer as a sheet, Preview scrolls down to where the preview sits.
// On a wide screen the drawer and the preview are both already on screen as
// their own columns, so both handlers were guarded `if (!isWide)` and did
// nothing -- while the bar rendered the buttons anyway. Two controls that look
// live, press like buttons and shrug.
//
// This is the rule theme-shared.tsx states for the customer-facing Ask button
// ("the customer taps and the app shrugs"), broken in the admin editor. A
// control that cannot act must not render.
describe('Preview and Edit only exist where they can act', () => {
  it('offers both on a narrow screen, where they navigate', () => {
    const texts = renderBarTexts({ isWide: false });
    expect(texts).toContain('Preview');
    expect(texts).toContain('Edit');
  });

  it('offers neither on a wide screen, where both would do nothing', () => {
    const texts = renderBarTexts({ isWide: true });
    expect(texts).not.toContain('Preview');
    expect(texts).not.toContain('Edit');
  });

  // Unpublish and Publish act on the PAGE, not on this screen's layout, so
  // they are unaffected by width and must survive the change above.
  it('keeps the controls that act on the page at every width', () => {
    const texts = renderBarTexts({ isWide: true, status: 'live' });
    expect(texts).toContain('Unpublish');
    expect(texts).toContain('Publish');
  });
});

// "Unpublish" only ARMS the confirm -- the page stays live until "Unpublish
// now". The banner in between described the consequence in a settled tense
// ("Customers won't be able to reach your page..."), which reads as a status
// the shop is already in rather than one it is being asked to choose.
describe('the unpublish confirm asks rather than announces', () => {
  it('does not state the consequence as though it had already happened', () => {
    const tree = renderBar({ status: 'live' });
    // Same approach the unpublish tests above use -- the testID is on the
    // Pressable, which is where onPress lives.
    const unpublish = tree.root.findAll((node) => node.props?.testID === 'publish-bar-unpublish');
    act(() => {
      unpublish[0].props.onPress();
    });

    const copy = textsIn(tree.toJSON()).join(' ');
    // Still live at this point -- the confirm is armed, nothing has changed.
    expect(copy).toContain('Unpublish now');
    expect(copy).toMatch(/\?/);
  });
});
