import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { Chip } from '@/components/platform/kit';
import { SupportComposeModal } from '@/components/platform/support-tab';
import { callPlatformAdmin, type PlatformShopRow } from '@/lib/platform';

// The tab imports @/lib/platform for supportQueueState, which imports the live
// client; that throws at require time without env vars. Same stub the reply
// panel's tests use.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));
jest.mock('@/lib/support-attachments', () => ({ signedUrlFor: jest.fn() }));
// The taxonomy stays real. Half of what these tests check is that the composer
// offers the OPERATOR's five categories, and a stubbed list would pass while
// the console offered a store's feature-request chip to itself.
jest.mock('@/lib/platform', () => ({
  ...jest.requireActual('@/lib/platform'),
  callPlatformAdmin: jest.fn(),
}));

const callPlatformAdminMock = callPlatformAdmin as jest.MockedFunction<typeof callPlatformAdmin>;

function shop(over: Partial<PlatformShopRow> & { shopId: string; shopName: string }): PlatformShopRow {
  return {
    ownerId: `${over.shopId}-owner`,
    planName: 'Growth',
    status: 'active',
    manualStatus: 'active',
    ...over,
  } as PlatformShopRow;
}

const SHOPS = [
  shop({ shopId: 'shop-1', shopName: 'Hooyo Market' }),
  shop({ shopId: 'shop-2', shopName: 'Berbera Books' }),
];

function flat(children: unknown): string {
  return Array.isArray(children) ? children.map(flat).join('') : String(children);
}

function texts(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((t) => flat(t.props.children));
}

// By handler rather than by component type: Pressable renders through a
// forwardRef whose identity findAllByType does not match under this preset.
function labelled(tree: ReactTestRenderer, label: string) {
  return tree.root
    .findAll((node) => typeof node.props.onPress === 'function')
    .find((p) => p.findAllByType(Text).some((t) => flat(t.props.children) === label));
}

function press(tree: ReactTestRenderer, label: string): void {
  const target = labelled(tree, label);
  if (!target) throw new Error(`nothing pressable is labelled "${label}"`);
  act(() => {
    target.props.onPress();
  });
}

const onClose = jest.fn();
const onDone = jest.fn(() => Promise.resolve());

function renderComposer(initialShopId: string | null = null): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <SupportComposeModal shops={SHOPS} initialShopId={initialShopId} onDone={onDone} onClose={onClose} />
    );
  });
  return tree!;
}

function fields(tree: ReactTestRenderer) {
  return tree.root.findAllByType(TextInput);
}

/**
 * The labels of the chip row sitting under a heading.
 *
 * Scoped by position rather than by type alone: the recipients and the five
 * categories are all Chips, so counting every Chip in the composer counts both
 * rows, and filtering them by the labels under test would assume the answer the
 * count is there to check.
 */
function chipsUnder(tree: ReactTestRenderer, heading: string): string[] {
  const label = tree.root.findAllByType(Text).find((t) => flat(t.props.children) === heading);
  if (!label) throw new Error(`no heading "${heading}"`);
  const siblings = label.parent!.children.filter(
    (child): child is ReactTestInstance => typeof child !== 'string'
  );
  const row = siblings[siblings.indexOf(label) + 1];
  if (!row) throw new Error(`nothing follows "${heading}"`);
  return row.findAllByType(Chip).map((chip) => String(chip.props.label));
}

function type(input: ReactTestInstance, value: string): void {
  act(() => {
    input.props.onChangeText(value);
  });
}

/** Picks a store the way an operator does — by typing and pressing a match. */
function pickStore(tree: ReactTestRenderer, name: string): void {
  const search = fields(tree).find((f) => f.props.placeholder === 'Search stores…');
  if (!search) throw new Error('no store search box');
  type(search, name.slice(0, 5));
  press(tree, name);
}

/** Fills the subject and the message, which are the only two fields left. */
function write(tree: ReactTestRenderer, subject: string, message: string): void {
  const [subjectField, messageField] = fields(tree);
  type(subjectField, subject);
  type(messageField, message);
}

beforeEach(() => {
  jest.resetAllMocks();
  callPlatformAdminMock.mockResolvedValue({});
});

describe('picking the store', () => {
  it('finds a store by name and addresses the thread to its id', async () => {
    const tree = renderComposer();
    pickStore(tree, 'Berbera Books');
    write(tree, 'Your payment cleared', 'It landed this morning.');
    press(tree, 'Send');
    await act(async () => {});

    expect(callPlatformAdminMock.mock.calls[0][1]).toMatchObject({ shopId: 'shop-2' });
  });

  it('opens with the store already filled in when it came from that store', () => {
    expect(texts(renderComposer('shop-1')).some((t) => t.startsWith('Hooyo Market'))).toBe(true);
  });

  // The drawer hands over an id, and the console can have reloaded without that
  // store between the two. Falling back to the search box in silence looks
  // exactly like a composer opened from nowhere.
  it('says so when the store it was opened for is not in the loaded list', () => {
    const tree = renderComposer('shop-closed-since');
    expect(texts(tree).some((t) => t.startsWith('That store is not in the list'))).toBe(true);
    expect(texts(tree)).toContain('Search for it →');
  });

  it('shows nothing until the operator types', () => {
    // Every store on Kaiibi is in this list; an arbitrary six of them offered
    // up front is an invitation to pick whichever looks closest.
    expect(texts(renderComposer())).not.toContain('Hooyo Market');
  });

  it('refuses to send with no store picked, and calls nothing', async () => {
    const tree = renderComposer();
    write(tree, 'Subject', 'Message');
    press(tree, 'Send');
    await act(async () => {});

    expect(callPlatformAdminMock).not.toHaveBeenCalled();
    expect(texts(tree)).toContain('Pick a store first.');
  });
});

// The whole privacy guarantee of the feature. `addressed_user_id` null is read
// by the policy in 20260825000000 as "holders of settings.access"; an id makes
// the thread that one person's, invisible to their colleagues.
describe('who at the store can read it', () => {
  it('addresses the store itself by default, which is not the same as everyone', async () => {
    const tree = renderComposer('shop-1');
    write(tree, 'Your payment cleared', 'It landed this morning.');
    press(tree, 'Send');
    await act(async () => {});

    expect(callPlatformAdminMock).toHaveBeenCalledWith(
      'open_support',
      {
        shopId: 'shop-1',
        support: { category: 'billing', subject: 'Your payment cleared', addressedUserId: null },
      },
      'It landed this morning.'
    );
  });

  it("sends to the owner alone when that is what was chosen", async () => {
    const tree = renderComposer('shop-1');
    press(tree, 'The owner only');
    write(tree, 'About your account', 'Just for you.');
    press(tree, 'Send');
    await act(async () => {});

    expect(callPlatformAdminMock.mock.calls[0][1]).toEqual({
      shopId: 'shop-1',
      support: { category: 'billing', subject: 'About your account', addressedUserId: 'shop-1-owner' },
    });
  });

  it('says who can actually read it, and that neither answer is the whole team', () => {
    const tree = renderComposer('shop-1');
    expect(
      texts(tree).some((t) => t.startsWith('Anyone at Hooyo Market who can reach Settings can read this'))
    ).toBe(true);

    press(tree, 'The owner only');
    expect(texts(tree).some((t) => t.startsWith('Only the owner of Hooyo Market can open this.'))).toBe(true);
  });

  // The recipient is a choice about a shop. Held as an id, the last store's
  // owner would ride along to the next one -- which open_support refuses, and
  // which would be this feature's one promise broken if it ever stopped.
  it('does not carry one store’s owner over to the next store', async () => {
    const tree = renderComposer('shop-1');
    press(tree, 'The owner only');
    press(tree, 'Hooyo Market  ✕');
    pickStore(tree, 'Berbera Books');
    write(tree, 'Hello', 'Hello there.');
    press(tree, 'Send');
    await act(async () => {});

    expect(callPlatformAdminMock.mock.calls[0][1]).toEqual({
      shopId: 'shop-2',
      support: { category: 'billing', subject: 'Hello', addressedUserId: null },
    });
  });

  // Only the owner's id rides on PlatformShopRow. An operator cannot read a
  // shop's roster at all -- shop_members carries no policy for them -- so a
  // picker of named people is a picker this console cannot fill.
  // Counted, not just looked for: a third chip -- a member picker filled from a
  // roster this console cannot read, or "everyone at the shop", which no policy
  // implements -- would leave both of these present and the promise broken.
  it('offers exactly two recipients', () => {
    expect(chipsUnder(renderComposer('shop-1'), 'Who at the store')).toEqual([
      'Everyone who runs it',
      'The owner only',
    ]);
  });
});

describe('what it is about', () => {
  it("offers the operator's categories, not the store's", () => {
    const shown = texts(renderComposer('shop-1'));

    expect(shown).toContain('💳 Billing');
    expect(shown).toContain('🔐 Their account');
    expect(shown).toContain('🐞 A problem we found');
    expect(shown).toContain("📣 Something's changed");
    expect(shown).toContain('🗒 Something else');
    // The store's own list. An operator never files a feature request or a
    // hardware fault against a customer, and 20260825000100 constrains the
    // column to the five above for a platform-opened thread anyway.
    expect(shown).not.toContain('✨ Feature request');
    expect(shown).not.toContain('🖨 Scanner, printer or till');
  });

  it('sends the category the operator chose', async () => {
    const tree = renderComposer('shop-1');
    press(tree, '🐞 A problem we found');
    write(tree, 'We broke something', 'Sorry about that.');
    press(tree, 'Send');
    await act(async () => {});

    expect(callPlatformAdminMock.mock.calls[0][1]).toMatchObject({
      support: expect.objectContaining({ category: 'problem' }),
    });
  });
});

describe('sending', () => {
  // platform-admin requires a reason on every action, and for support the body
  // IS the justification -- so the audit log records what was actually said
  // rather than a second sentence about it.
  it('passes the message body as the reason, trimmed', async () => {
    const tree = renderComposer('shop-1');
    write(tree, '  Your payment cleared  ', '  It landed this morning.  ');
    press(tree, 'Send');
    await act(async () => {});

    expect(callPlatformAdminMock).toHaveBeenCalledWith(
      'open_support',
      { shopId: 'shop-1', support: { category: 'billing', subject: 'Your payment cleared', addressedUserId: null } },
      'It landed this morning.'
    );
  });

  it('refuses a message with no subject, and a subject with no message', async () => {
    const tree = renderComposer('shop-1');
    write(tree, '', 'Just a body.');
    press(tree, 'Send');
    await act(async () => {});
    expect(callPlatformAdminMock).not.toHaveBeenCalled();
    expect(texts(tree)).toContain('A subject and a message are both needed.');

    write(tree, 'Just a subject', '   ');
    press(tree, 'Send');
    await act(async () => {});
    expect(callPlatformAdminMock).not.toHaveBeenCalled();
  });

  // open_support is an insert with nothing on the server to collapse a
  // duplicate into the first, so the store would get the same message twice in
  // two separate conversations.
  it('does not open two conversations when Send is pressed twice', () => {
    callPlatformAdminMock.mockReturnValue(new Promise(() => {}));
    const tree = renderComposer('shop-1');
    write(tree, 'Once', 'Only once.');
    // Held rather than looked up twice: the second press is the one that lands
    // before the first has re-rendered the button.
    const button = labelled(tree, 'Send');
    act(() => {
      button?.props.onPress();
      button?.props.onPress();
    });

    expect(callPlatformAdminMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a message the column would reject, without spending the request', async () => {
    const tree = renderComposer('shop-1');
    write(tree, 'Long', 'a'.repeat(4001));

    // The button is the barrier an operator meets; the guard inside send() is
    // the second line behind it, reachable only by calling the handler as the
    // press below does. Asserting the guard alone would pass just as happily
    // with a Send that stayed live and sent a request the server refuses.
    expect(labelled(tree, 'Send')?.props.disabled).toBe(true);

    press(tree, 'Send');
    await act(async () => {});

    expect(callPlatformAdminMock).not.toHaveBeenCalled();
    expect(
      texts(tree).some((t) => t.includes('4001 of 4000 characters. Shorten it by 1 to send.'))
    ).toBe(true);
  });

  // Order matters, not just that both happen: a composer still on screen while
  // the console refreshes is holding the draft of a message that has already
  // been sent, and a refresh that fails would leave it there to be sent twice.
  it('closes the moment the thread is on the server, then reloads the console', async () => {
    const tree = renderComposer('shop-1');
    write(tree, 'Your payment cleared', 'It landed this morning.');
    press(tree, 'Send');
    await act(async () => {});

    expect(callPlatformAdminMock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onDone.mock.invocationCallOrder[0]);
  });

  it('stays open with the draft intact when the send fails', async () => {
    callPlatformAdminMock.mockRejectedValue(new Error('That person does not work at this shop.'));
    const tree = renderComposer('shop-1');
    write(tree, 'Your payment cleared', 'It landed this morning.');
    press(tree, 'Send');
    await act(async () => {});

    expect(texts(tree)).toContain('That person does not work at this shop.');
    expect(onClose).not.toHaveBeenCalled();
    expect(fields(tree)[1].props.value).toBe('It landed this morning.');
  });
});
