import { createElement, useState } from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SupportSheet } from '@/components/support/support-sheet';
import { listMyThreads, type SupportThread } from '@/lib/support';
import { supportUnreadSnapshot } from '@/lib/support-unread';

// The reason this test is a file of its own.
//
// The closing half of the reported bug -- "same happens when closing the
// message" -- was the sheet resetting to the compose form BEFORE the fade, so it
// changed into a screen nobody asked for on the way out. That frame only exists
// while the modal is dismissing, and Jest's Modal renders null the instant
// `visible` is false, so in every other test file the frame is unobservable and
// any assertion about it passes for the wrong reason.
//
// So AppModal is stubbed to keep rendering its children regardless, which is
// what RN's Modal genuinely does on iOS through a dismissal (Modal.js
// `_shouldShowModal`: `visible === true || isRendered === true`). What is under
// test is this component's own contract -- closing changes nothing about what
// the body is showing -- not the platform's animation.
jest.mock('@/components/ui/app-modal', () => {
  const react = require('react');
  return { AppModal: ({ children }: { children: React.ReactNode }) => react.createElement(react.Fragment, null, children) };
});
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/support', () => ({
  ...jest.requireActual('@/lib/support'),
  listMyThreads: jest.fn(),
}));
jest.mock('@/lib/support-unread', () => ({
  supportUnreadSnapshot: jest.fn(() => 0),
  syncSupportUnread: jest.fn(),
}));
const mockCompose = { mounts: 0 };
jest.mock('@/components/support/support-compose', () => {
  const react = require('react');
  const rn = require('react-native');
  return {
    SupportCompose: () => {
      react.useEffect(() => {
        mockCompose.mounts += 1;
      }, []);
      return react.createElement(rn.Text, null, 'compose form');
    },
  };
});
jest.mock('@/components/support/support-thread-view', () => ({ SupportThreadView: () => null }));

const asMock = (fn: unknown) => fn as jest.Mock;

const unreadThread = {
  id: 't1',
  shopId: 'shop-1',
  reference: 'KB-2001',
  subject: 'Scanner stops after a refund',
  category: 'broken',
  area: 'pos',
  areaOther: null,
  status: 'open',
  openedBy: 'shop',
  contactPreference: 'in_app',
  lastMessageAt: '2026-08-10T10:00:00Z',
  shopReadAt: null,
  createdAt: '2026-08-09T09:00:00Z',
  lastMessagePreview: 'Found it — the refund sheet was holding focus',
  lastAuthorKind: 'platform',
} as SupportThread;

function titles(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap((node) => (typeof node.props.children === 'string' ? [node.props.children] : []));
}

beforeEach(() => {
  mockCompose.mounts = 0;
  asMock(listMyThreads).mockReset().mockResolvedValue([unreadThread]);
  asMock(supportUnreadSnapshot).mockReset().mockReturnValue(1);
});

// Closed the way a person closes it -- the ✕ inside the sheet -- rather than by
// setting the prop from outside. That is the path the bug was on: the sheet's
// own close handler reset the view and then told the shell to hide it, in that
// order.
function Shell() {
  const [visible, setVisible] = useState(true);
  return createElement(SupportSheet, { visible, onClose: () => setVisible(false) });
}

it('closes as whatever you were looking at', async () => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(Shell));
  });
  expect(titles(tree)).toContain('Your messages');

  const close = tree.root.find(
    (node) => typeof node.props?.onPress === 'function' && node.props?.accessibilityLabel === 'Close'
  );
  await act(async () => {
    close.props.onPress();
  });

  expect(titles(tree)).toContain('Your messages');
  expect(titles(tree)).not.toContain('Help & support');
  // The old reset ran on the way out and would have mounted the form here.
  expect(mockCompose.mounts).toBe(0);
});
