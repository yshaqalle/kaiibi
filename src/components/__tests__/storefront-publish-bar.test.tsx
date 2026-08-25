import type { ComponentProps } from 'react';
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
  onEdit: jest.fn(),
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

  it('offers no Unpublish action for a page that was never published', () => {
    const tree = renderBar({ status: 'draft' });
    const unpublishButton = tree.root.findAll((node) => node.props?.testID === 'publish-bar-unpublish');
    expect(unpublishButton).toHaveLength(0);
  });
});
