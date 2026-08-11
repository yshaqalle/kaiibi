import { createElement } from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SupportBanner } from '@/components/support/support-banner';
import { useSupportUnread } from '@/lib/support-unread';

jest.mock('@/lib/support-unread', () => ({ useSupportUnread: jest.fn() }));

const asMock = (fn: unknown) => fn as jest.Mock;

function setCount(count: number) {
  asMock(useSupportUnread).mockReturnValue({ count, refresh: jest.fn() });
}

function texts(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap((node) => (typeof node.props.children === 'string' ? [node.props.children] : []));
}

function dismiss(tree: ReactTestRenderer) {
  const button = tree.root.find(
    (node) => typeof node.props?.onPress === 'function' && node.props?.accessibilityLabel === 'Dismiss'
  );
  act(() => {
    button.props.onPress();
  });
}

function rerender(tree: ReactTestRenderer, count: number) {
  setCount(count);
  act(() => {
    tree.update(createElement(SupportBanner, { onOpen: jest.fn() }));
  });
}

// The banner is the only surface that reaches somebody who was not already
// opening the ☰ menu. Dismissal used to be a boolean, which made ✕ a one-way
// latch: every later message raised the badge and left this line hidden.
describe('SupportBanner dismissal', () => {
  it('comes back when a message arrives after it was dismissed', () => {
    setCount(1);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(createElement(SupportBanner, { onOpen: jest.fn() }));
    });
    expect(texts(tree)).toContain('You have a message from Kaiibi.');

    dismiss(tree);
    expect(texts(tree)).toEqual([]);

    rerender(tree, 2);
    expect(texts(tree)).toContain('You have 2 messages from Kaiibi.');
  });

  it('can be dismissed again at the new count', () => {
    setCount(1);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(createElement(SupportBanner, { onOpen: jest.fn() }));
    });
    dismiss(tree);
    rerender(tree, 2);
    dismiss(tree);
    expect(texts(tree)).toEqual([]);

    // And stays dismissed while nothing changes -- a banner that returns on the
    // next render is one people learn to swipe past.
    rerender(tree, 2);
    expect(texts(tree)).toEqual([]);
  });

  it('shows nothing at all when there is nothing unread', () => {
    setCount(0);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(createElement(SupportBanner, { onOpen: jest.fn() }));
    });
    expect(texts(tree)).toEqual([]);
  });
});
