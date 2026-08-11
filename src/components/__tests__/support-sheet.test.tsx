import { createElement } from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Below the mocks in intent, above them in source: babel-plugin-jest-hoist
// lifts every `jest.mock` above the imports regardless.
import { SupportSheet } from '@/components/support/support-sheet';
import { listMyThreads, type SupportThread } from '@/lib/support';
import { supportUnreadSnapshot } from '@/lib/support-unread';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/support', () => ({
  ...jest.requireActual('@/lib/support'),
  listMyThreads: jest.fn(),
}));
jest.mock('@/lib/support-unread', () => ({
  supportUnreadSnapshot: jest.fn(() => 0),
  syncSupportUnread: jest.fn(),
}));

// Counted rather than stubbed to null: the reported bug was the compose form
// appearing for one frame and being replaced, and a mount count is the only
// thing that sees a frame nobody kept.
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

function thread(over: Partial<SupportThread> = {}): SupportThread {
  return {
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
    shopReadAt: '2026-08-10T11:00:00Z',
    createdAt: '2026-08-09T09:00:00Z',
    lastMessagePreview: 'Found it — the refund sheet was holding focus',
    lastAuthorKind: 'platform',
    ...over,
  };
}

// One string per Text, with its own string pieces joined back together --
// `{unread} waiting on you` reaches the renderer as two children, and a nested
// <Text> (the bold "Kaiibi:" on a preview line) reaches it as an element, which
// is why this is neither a flatMap nor the `typeof children === 'string'` filter
// the older support tests use. The nested Text is found separately, on its own
// pass of findAllByType.
function texts(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((node) => {
    const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
    return children.filter((child: unknown) => typeof child === 'string' || typeof child === 'number').join('');
  });
}

function render(visible = true) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(createElement(SupportSheet, { visible, onClose: jest.fn() }));
  });
  return tree;
}

// Mounted hidden and then opened, which is the only way this sheet is ever
// reached in the app -- every shell renders it permanently and flips `visible`.
// It matters here beyond realism: RN's Modal only keeps rendering its children
// through the iOS dismissal once it has SEEN a false→true transition
// (Modal.js sets `isRendered` in componentDidUpdate), so a sheet created
// already-visible would close to an empty tree and take the closing tests below
// with it.
function open() {
  const tree = render(false);
  setVisible(tree, true);
  return tree;
}

function setVisible(tree: ReactTestRenderer, visible: boolean) {
  act(() => {
    tree.update(createElement(SupportSheet, { visible, onClose: jest.fn() }));
  });
}

const settle = async (tree: ReactTestRenderer) => {
  await act(async () => {
    await Promise.resolve();
  });
  return tree;
};

beforeEach(() => {
  mockCompose.mounts = 0;
  asMock(listMyThreads).mockReset().mockResolvedValue([]);
  asMock(supportUnreadSnapshot).mockReset().mockReturnValue(0);
});

// The bug: the sheet painted the compose form, then `listMyThreads` landed and
// swapped it for the list. Reported as "it tries to go to the support modal
// then goes to your messages" -- one tap, two screens.
describe('SupportSheet opens settled', () => {
  it('opens straight on the list when the badge already says something is waiting', async () => {
    asMock(supportUnreadSnapshot).mockReturnValue(1);
    asMock(listMyThreads).mockResolvedValue([thread({ shopReadAt: null })]);

    const tree = render();
    // Before the fetch has answered -- this is the frame the flicker lived in.
    expect(texts(tree)).toContain('Your messages');
    expect(mockCompose.mounts).toBe(0);

    await settle(tree);
    expect(texts(tree)).toContain('Your messages');
    expect(texts(tree)).not.toContain('Help & support');
    // Never rendered, not rendered-and-replaced.
    expect(mockCompose.mounts).toBe(0);
  });

  it('does not swap the form for the list once the fetch lands', async () => {
    asMock(supportUnreadSnapshot).mockReturnValue(0);
    asMock(listMyThreads).mockResolvedValue([thread({ shopReadAt: null })]);

    const tree = render();
    await settle(tree);

    expect(texts(tree)).toContain('Help & support');
    expect(mockCompose.mounts).toBe(1);
    // The compensating affordance: the unread the count did not know about is
    // still one tap away, as a line of text rather than a screen that moved.
    expect(texts(tree)).toContain('Your messages · 1 unread →');
  });

  it('says nothing at all rather than "Nothing yet." while the list is in flight', async () => {
    asMock(supportUnreadSnapshot).mockReturnValue(1);
    let resolve!: (threads: SupportThread[]) => void;
    asMock(listMyThreads).mockReturnValue(new Promise<SupportThread[]>((r) => { resolve = r; }));

    const tree = render();
    expect(texts(tree)).not.toContain('Nothing yet.');

    await act(async () => { resolve([]); });
    expect(texts(tree)).toContain('Nothing yet.');
  });
});

// The other half of the reported bug -- the sheet turning back into the form as
// it fades out -- is in support-sheet-close.test.tsx, which has to stub AppModal
// to see it: Jest's Modal drops its children the instant `visible` goes false,
// so the dismissal frame does not exist in this file.
describe('SupportSheet closing', () => {
  it('starts the next open over rather than reopening where it left off', async () => {
    asMock(supportUnreadSnapshot).mockReturnValue(1);
    asMock(listMyThreads).mockResolvedValue([thread({ shopReadAt: null })]);
    const tree = open();
    await settle(tree);
    setVisible(tree, false);

    // Read in the meantime, so the count -- and with it the view this should
    // open on -- has changed.
    asMock(supportUnreadSnapshot).mockReturnValue(0);
    asMock(listMyThreads).mockResolvedValue([thread()]);
    setVisible(tree, true);

    expect(texts(tree)).toContain('Help & support');
    expect(mockCompose.mounts).toBe(1);
    // The reopen started a second fetch; settled so it does not land on a torn
    // -down renderer as an unwrapped update.
    await settle(tree);
  });
});

// What the row has to answer before somebody decides whether to open it. The
// old row said a subject and a reference, which answers none of it -- so the
// only way to find out whether we had replied was to file another thread.
describe('SupportSheet list rows', () => {
  it('says whose move it is, who spoke last and what it is about', async () => {
    asMock(supportUnreadSnapshot).mockReturnValue(1);
    asMock(listMyThreads).mockResolvedValue([
      thread({ shopReadAt: null }),
      thread({ id: 't2', reference: 'KB-2003', subject: 'Paid on ZAAD, still unpaid', category: 'billing', area: null, lastAuthorKind: 'shop', lastMessagePreview: 'Sent 45,000 SLSH' }),
      thread({ id: 't3', reference: 'KB-2004', subject: 'Two receipts?', status: 'closed', category: 'feature', area: null }),
    ]);

    const tree = render();
    await settle(tree);
    const shown = texts(tree);

    expect(shown).toEqual(expect.arrayContaining(['Waiting on you', 'Open', 'Closed']));
    expect(shown).toContain('1 waiting on you');
    expect(shown).toContain('New reply');
    expect(shown).toContain('Waiting for us');
    expect(shown).toContain('Resolved');
    expect(shown).toContain('Kaiibi: ');
    expect(shown).toContain('Found it — the refund sheet was holding focus');
    expect(shown).toContain('You: ');
    expect(shown).toContain('Broken · POS & checkout');
    expect(shown).toContain('KB-2001');
    // Demoted, but still there.
    expect(shown).toContain('＋ New request');
  });
});
