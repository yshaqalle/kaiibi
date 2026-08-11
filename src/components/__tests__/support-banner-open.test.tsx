import { useEffect } from 'react';
import { Modal, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Below the mocks in intent, above them in source: babel-plugin-jest-hoist
// lifts every `jest.mock` above the imports regardless.
import { AdminSidebar } from '@/components/admin-sidebar';
import { listMyThreads, type SupportThread } from '@/lib/support';
import { resetSupportUnread, syncSupportUnread } from '@/lib/support-unread';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    session: { user: { id: 'user-a' } },
    shop: { id: 'shop-1', name: 'Jaalala Skincare', logoUrl: null, categories: ['Skincare'] },
    can: () => true,
    canAny: () => true,
    myMembership: { active: true },
    hasModule: () => true,
  }),
}));
jest.mock('@/hooks/use-shop-logo', () => ({ useShopLogo: () => ({ editLogo: jest.fn(), canEditLogo: true }) }));
jest.mock('@/components/location-switcher', () => ({ LocationSwitcher: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
// The two views the sheet can host. Stubbed because neither takes part in what
// is asserted here, and both reach the native document/image pickers.
jest.mock('@/components/support/support-compose', () => ({ SupportCompose: () => null }));
jest.mock('@/components/support/support-thread-view', () => ({ SupportThreadView: () => null }));
jest.mock('@/lib/supabase', () => {
  const channel: any = { topic: 'test', on: () => channel, subscribe: () => channel };
  return { supabase: { channel: () => channel, removeChannel: () => Promise.resolve('ok') } };
});
jest.mock('@/lib/support', () => ({
  ...jest.requireActual('@/lib/support'),
  listMyThreads: jest.fn(),
}));

const asMock = (fn: unknown) => fn as jest.Mock;

function threads(unread: number): SupportThread[] {
  return Array.from({ length: 2 }, (_, i) => ({
    id: `t${i}`,
    reference: `KB-200${i}`,
    subject: `Thread ${i}`,
    openedBy: 'platform',
    lastMessageAt: '2026-08-10T10:00:00Z',
    // Read threads are stamped after the last message; unread ones never were.
    shopReadAt: i < unread ? null : '2026-08-10T11:00:00Z',
  })) as SupportThread[];
}

// Stands in for the routed screen, exactly as admin-sidebar.test.tsx uses it: a
// screen that is REBUILT rather than updated runs its effects again. If opening
// the sheet ever costs the screen its state, this is what catches it.
let screenMounts = 0;
function Screen() {
  useEffect(() => { screenMounts += 1; }, []);
  return <Text>dashboard screen</Text>;
}

function texts(tree: ReactTestRenderer) {
  return tree.root.findAllByType(Text).flatMap((t) => (typeof t.props.children === 'string' ? [t.props.children] : []));
}

/**
 * The shell renders two modals, the ☰ menu and the sheet, and only ever one of
 * them at a time. A Modal renders nothing at all while hidden, so the sheet's
 * own heading is proof it is both mounted and up.
 */
function sheetVisible(tree: ReactTestRenderer) {
  const up = tree.root.findAllByType(Modal).filter((m) => m.props.visible === true);
  const heading = texts(tree).some((t) => t === 'Help & support' || t === 'Your messages');
  return up.length === 1 && heading;
}

/**
 * Found by prop rather than by component type: RN's `Pressable` is a memo around
 * a forwardRef, so `findAllByType(Pressable)` matches nothing here.
 */
function pressable(tree: ReactTestRenderer, matches: (instance: ReturnType<ReactTestRenderer['root']['findAll']>[number]) => boolean) {
  return tree.root.findAll(
    (node) => typeof node.props?.onPress === 'function' && node.props?.accessibilityRole === 'button' && matches(node),
    { deep: false }
  )[0];
}

function pressRead(tree: ReactTestRenderer) {
  const read = pressable(tree, (node) => node.findAllByType(Text).some((t) => t.props.children === 'Read'));
  act(() => { read.props.onPress(); });
}

beforeEach(() => {
  resetSupportUnread();
  screenMounts = 0;
  asMock(listMyThreads).mockReset();
});

describe('SupportBanner → SupportSheet', () => {
  // The bug this is here to prevent: tapping Read opened the sheet and it shut
  // again in the same breath. The suspicion was structural -- the banner
  // returns null the moment its count reaches zero, and the sheet's own load()
  // is what takes the count there, so opening the sheet is what removes the
  // banner. If that removal moved SupportSheet in the element tree, React would
  // rebuild it and `visible` would start over at false.
  //
  // It does not, and this is what keeps it that way: the banner sits inside a
  // slot View of its own and SupportSheet sits at a fixed index of the root, so
  // neither the banner appearing nor its disappearing can shift the other. Move
  // either of them next to a sibling that renders conditionally and this fails.
  it('stays open when the banner disappears underneath it', async () => {
    asMock(listMyThreads).mockResolvedValue(threads(1));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <AdminSidebar>
          <Screen />
        </AdminSidebar>
      );
    });
    expect(texts(tree)).toContain('You have a message from Kaiibi.');
    // Non-vacuous: `sheetVisible` has to be able to say no.
    expect(sheetVisible(tree)).toBe(false);

    // The sheet's own load() is what marks the count down: the thread list it
    // fetches is the same list the count is derived from.
    asMock(listMyThreads).mockResolvedValue(threads(0));
    pressRead(tree);
    await act(async () => { await Promise.resolve(); });

    expect(texts(tree)).not.toContain('You have a message from Kaiibi.');
    expect(sheetVisible(tree)).toBe(true);
    // And the screen behind it was updated, not rebuilt.
    expect(screenMounts).toBe(1);
  });

  // The other half of the same guarantee, from the opposite direction: the
  // banner is one of the two things holding the shared unread store open (the ☰
  // row is the other, and it unmounts every time the menu closes). Returning
  // null must not be mistaken for unmounting -- if it ever were, the store's
  // refcount would hit zero while the banner is still on screen, clear
  // `countingFor`, and quietly turn syncSupportUnread into a no-op for the rest
  // of the session.
  it('keeps counting after the banner has gone quiet', async () => {
    asMock(listMyThreads).mockResolvedValue(threads(1));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <AdminSidebar>
          <Screen />
        </AdminSidebar>
      );
    });

    asMock(listMyThreads).mockResolvedValue(threads(0));
    pressRead(tree);
    await act(async () => { await Promise.resolve(); });
    expect(texts(tree)).not.toContain('You have a message from Kaiibi.');

    // A second message lands and the sheet hands the new list over. That only
    // reaches the screen while the store still knows whose count it is holding,
    // which is what the refcount decides.
    await act(async () => { syncSupportUnread(threads(2)); });
    expect(texts(tree)).toContain('You have 2 messages from Kaiibi.');
  });
});
