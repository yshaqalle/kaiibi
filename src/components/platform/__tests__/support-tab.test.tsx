import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SupportTab } from '@/components/platform/support-tab';
import { openExternalUrl } from '@/lib/external-url';
import { callPlatformAdmin, type PlatformShopRow, type PlatformSupportThread } from '@/lib/platform';
import { listMessages, type SupportMessage } from '@/lib/support';

// The tab imports @/lib/platform for supportQueueState, which imports the live
// client; that throws at require time without env vars. Same stub the settings
// panel tests use.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// Only the calls that leave the process are replaced. `whatsAppLink`,
// `supportQueueState` and the taxonomy stay real, because half of what these
// tests check is that the panel asks THOSE the right question -- a stubbed link
// builder would pass a test that a Somaliland 063 number silently fails in the
// app.
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));
jest.mock('@/lib/support-attachments', () => ({ signedUrlFor: jest.fn() }));
jest.mock('@/lib/support', () => ({
  ...jest.requireActual('@/lib/support'),
  listMessages: jest.fn(),
}));
jest.mock('@/lib/platform', () => ({
  ...jest.requireActual('@/lib/platform'),
  callPlatformAdmin: jest.fn(),
}));

const listMessagesMock = listMessages as jest.MockedFunction<typeof listMessages>;
const callPlatformAdminMock = callPlatformAdmin as jest.MockedFunction<typeof callPlatformAdmin>;
const openExternalUrlMock = openExternalUrl as jest.MockedFunction<typeof openExternalUrl>;

const NOON = Date.parse('2026-08-09T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function thread(over: Partial<PlatformSupportThread> & { id: string }): PlatformSupportThread {
  return {
    reference: `KB-${over.id}`,
    shopId: 'shop-1',
    shopName: 'Hooyo Market',
    subject: over.id,
    category: 'billing',
    area: null,
    areaOther: null,
    status: 'open',
    openedBy: 'shop',
    contactPreference: 'in_app',
    clientContext: {},
    lastMessageAt: new Date(NOON - HOUR).toISOString(),
    platformReadAt: null,
    shopReadAt: null,
    authorUserId: null,
    authorName: null,
    messageCount: 1,
    attachmentCount: 0,
    lastAuthorKind: 'shop',
    authorPhone: null,
    ...over,
  };
}

const SHOPS = [
  {
    shopId: 'shop-1',
    shopName: 'Hooyo Market',
    planName: 'Growth',
    status: 'active',
    trialEndsAt: null,
    currentPeriodEnd: '2026-11-02T12:00:00.000Z',
    manualStatus: 'active',
  } as PlatformShopRow,
];

function message(over: Partial<SupportMessage> & { id: string }): SupportMessage {
  return {
    threadId: 't',
    authorKind: 'shop',
    body: over.id,
    createdAt: new Date(NOON - HOUR).toISOString(),
    attachments: [],
    ...over,
  };
}

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

function renderTab(threads: PlatformSupportThread[], now: number = NOON, truncated = false): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <SupportTab
        threads={threads}
        shops={SHOPS}
        now={now}
        truncated={truncated}
        compact={false}
        onDone={() => Promise.resolve()}
        onCompose={jest.fn()}
      />
    );
  });
  return tree!;
}

function render(threads: PlatformSupportThread[], now: number = NOON, truncated = false): string[] {
  return texts(renderTab(threads, now, truncated));
}

// Opens the panel the way an operator does -- by pressing the row -- so the
// modal wiring is under test too, and flushes the message load it starts.
async function openPanel(one: PlatformSupportThread): Promise<ReactTestRenderer> {
  const tree = renderTab([one]);
  // Prefix, not equality: a thread we started has "(we started this)" appended
  // to its subject in the row.
  const row = tree.root
    .findAll((node) => typeof node.props.onPress === 'function')
    .find((p) => p.findAllByType(Text).some((t) => flat(t.props.children).startsWith(one.subject)));
  if (!row) throw new Error(`no queue row for ${one.subject}`);
  act(() => {
    row.props.onPress();
  });
  await act(async () => {});
  return tree;
}

beforeEach(() => {
  // Reset, not clear: a test that gives openExternalUrl a throwing body would
  // otherwise leave it throwing for every test after it.
  jest.resetAllMocks();
  listMessagesMock.mockResolvedValue([]);
  callPlatformAdminMock.mockResolvedValue({});
});

describe('SupportTab', () => {
  // The whole point of the tab: one operator answers all of this, and a list
  // ordered by age puts a thread we answered ten minutes ago above one nobody
  // has touched.
  it('ranks the queue by whose move it is, not by how recent it is', () => {
    const texts = render([
      // Newest first, which is the order the query returns.
      thread({ id: 'closed', status: 'closed', lastMessageAt: new Date(NOON - HOUR).toISOString() }),
      thread({
        id: 'seen',
        lastAuthorKind: 'platform',
        lastMessageAt: new Date(NOON - 2 * HOUR).toISOString(),
        shopReadAt: new Date(NOON - HOUR).toISOString(),
      }),
      thread({ id: 'unopened', lastAuthorKind: 'platform', lastMessageAt: new Date(NOON - 3 * HOUR).toISOString() }),
      thread({ id: 'waiting', lastMessageAt: new Date(NOON - 4 * HOUR).toISOString() }),
    ]);

    const states = texts.filter((t) =>
      ['Needs a reply', 'Unread by them', 'Waiting on them', 'Closed'].includes(t)
    );
    expect(states).toEqual(['Needs a reply', 'Unread by them', 'Waiting on them', 'Closed']);
  });

  // The plan is not on the thread; it is joined from the shops list the console
  // has already loaded.
  it('shows the store tier beside the reference', () => {
    expect(render([thread({ id: 'a' })])).toContain('KB-a · Hooyo Market · Growth');
  });

  it('counts a thread past a day with no reply and says why it matters', () => {
    const texts = render([thread({ id: 'old', lastMessageAt: new Date(NOON - 30 * HOUR).toISOString() })]);
    expect(texts).toContain('1 unanswered > 24h');
    expect(texts.some((t) => t.startsWith('1 conversation is past a day with no reply.'))).toBe(true);
  });

  // A thread we already answered is not "unanswered", however old it is.
  it('leaves a thread waiting on the store out of the stale count', () => {
    const texts = render([
      thread({
        id: 'answered',
        lastAuthorKind: 'platform',
        lastMessageAt: new Date(NOON - 30 * HOUR).toISOString(),
        shopReadAt: new Date(NOON - 29 * HOUR).toISOString(),
      }),
    ]);
    expect(texts).toContain('0 unanswered > 24h');
  });

  // listSupportThreads caps the queue at 200 rows so the console load stays
  // fast; a cap that bites silently reads as a short queue instead of a
  // truncated one, so the operator has to be told.
  it('says so when the 200-row queue cap has been hit', () => {
    const texts = render([thread({ id: 'a' })], NOON, true);
    expect(texts.some((t) => t.startsWith('Showing the 200 most recently active conversations.'))).toBe(true);
  });

  it('says nothing about the cap when the queue is under it', () => {
    const texts = render([thread({ id: 'a' })], NOON, false);
    expect(texts.some((t) => t.startsWith('Showing the 200 most recently active conversations.'))).toBe(false);
  });
});

// The rail is the whole argument for answering here rather than on WhatsApp:
// what an operator would otherwise go hunting for is already beside the box
// they are typing into.
describe('the reply panel rail', () => {
  it('names the store, the person and where the money stands', async () => {
    const tree = await openPanel(
      thread({ id: 'a', authorUserId: 'u1', authorName: 'Hodan Ali', authorPhone: '063 555 1234' })
    );
    const shown = texts(tree);

    expect(shown).toContain('Hooyo Market');
    expect(shown).toContain('Hodan Ali');
    expect(shown).toContain('063 555 1234');
    expect(shown).toContain('Growth');
    expect(shown).toContain('active');
    expect(shown).toContain('Renews');
    expect(shown).toContain('2 Nov 2026');
  });

  // Two different nulls. `authorUserId` is what tells them apart, and calling
  // an unreadable profile "we started this" would be a lie about who is
  // waiting.
  it('tells a thread we started apart from a name we could not read', async () => {
    expect(texts(await openPanel(thread({ id: 'a', openedBy: 'platform' })))).toContain('We started this');
    expect(texts(await openPanel(thread({ id: 'b', authorUserId: 'u1' })))).toContain('Name not on file');
  });

  it('shows what they were holding when it broke', async () => {
    const tree = await openPanel(
      thread({
        id: 'a',
        clientContext: { platform: 'android', deviceClass: 'tablet', screen: 'POS', appVersion: '1.4.2' },
      })
    );
    const shown = texts(tree);

    expect(shown).toContain('Device');
    expect(shown).toContain('tablet');
    expect(shown).toContain('Screen');
    expect(shown).toContain('POS');
    expect(shown).toContain('App version');
    expect(shown).toContain('1.4.2');
  });

  it('says the device context is missing rather than showing an empty card', async () => {
    expect(texts(await openPanel(thread({ id: 'a' })))).toContain('Nothing recorded');
  });

  it('says which conversation this is and what it is about', async () => {
    const tree = await openPanel(thread({ id: 'a', category: 'broken', area: 'pos' }));
    expect(texts(tree).some((t) => t.startsWith("KB-a · Something's broken · POS & checkout · Open"))).toBe(true);
  });

  it('shows the messages, and offers the attachments they sent', async () => {
    listMessagesMock.mockResolvedValue([
      message({
        id: 'm1',
        body: 'The till will not open',
        attachments: [{ id: 'a1', fileName: 'shot.png', storagePath: 'shop-1/t/shot.png', byteSize: 10 }],
      }),
    ]);
    const tree = await openPanel(thread({ id: 'a', authorUserId: 'u1', authorName: 'Hodan Ali' }));

    expect(texts(tree)).toContain('The till will not open');
    expect(texts(tree)).toContain('📎 shot.png');
  });
});

describe('the reply panel send controls', () => {
  it('writes the body as the reason, so the audit log records what was said', async () => {
    const tree = await openPanel(thread({ id: 'a' }));
    typeReply(tree, '  We have matched your payment.  ');
    press(tree, 'Send reply');
    await act(async () => {});

    expect(callPlatformAdminMock).toHaveBeenCalledTimes(1);
    expect(callPlatformAdminMock).toHaveBeenCalledWith(
      'reply_support',
      { support: { threadId: 'a' } },
      'We have matched your payment.'
    );
  });

  it('refuses an empty reply without calling anything', async () => {
    const tree = await openPanel(thread({ id: 'a' }));
    press(tree, 'Send reply');
    await act(async () => {});

    expect(callPlatformAdminMock).not.toHaveBeenCalled();
    expect(texts(tree)).toContain('Write something first.');
  });

  it('closes the conversation only after the reply has landed', async () => {
    const tree = await openPanel(thread({ id: 'a' }));
    typeReply(tree, 'All sorted.');
    press(tree, 'Send & close');
    await act(async () => {});

    expect(callPlatformAdminMock.mock.calls.map((c) => c[0])).toEqual(['reply_support', 'close_support']);
    expect(callPlatformAdminMock.mock.calls[1]).toEqual(['close_support', { support: { threadId: 'a' } }, 'All sorted.']);
  });

  // The reply is already on the server when a close fails, so a retry must not
  // be allowed to re-run the send.
  it('retries only the close when closing is the thing that failed', async () => {
    callPlatformAdminMock.mockImplementation((action: string) =>
      action === 'close_support' ? Promise.reject(new Error('That conversation is already closed.')) : Promise.resolve({})
    );
    const tree = await openPanel(thread({ id: 'a' }));
    typeReply(tree, 'All sorted.');
    press(tree, 'Send & close');
    await act(async () => {});

    expect(texts(tree)).toContain('That conversation is already closed.');

    // Caveat draws its action as "Try again →".
    press(tree, 'Try again →');
    await act(async () => {});

    expect(callPlatformAdminMock.mock.calls.filter((c) => c[0] === 'reply_support')).toHaveLength(1);
    expect(callPlatformAdminMock.mock.calls.filter((c) => c[0] === 'close_support')).toHaveLength(2);
  });

  it('does not send twice when the button is pressed twice', async () => {
    callPlatformAdminMock.mockReturnValue(new Promise(() => {}));
    const tree = await openPanel(thread({ id: 'a' }));
    typeReply(tree, 'Once.');
    // Held rather than looked up twice: the second press is the one that lands
    // before the first has re-rendered the button, which is exactly the race
    // the in-flight ref exists for.
    const button = labelled(tree, 'Send reply');
    act(() => {
      button?.props.onPress();
      button?.props.onPress();
    });

    expect(callPlatformAdminMock).toHaveBeenCalledTimes(1);
  });

  it('says so when the reply itself does not go through', async () => {
    callPlatformAdminMock.mockRejectedValue(new Error('Network request failed.'));
    const tree = await openPanel(thread({ id: 'a' }));
    typeReply(tree, 'Hello.');
    press(tree, 'Send reply');
    await act(async () => {});

    expect(texts(tree)).toContain('Network request failed.');
  });
});

// WhatsApp is a hand-off, not a channel: Kaiibi never sends the message, it
// opens the operator's own chat with the reply already written.
describe('the WhatsApp hand-off', () => {
  const wants = (over: Partial<PlatformSupportThread> = {}) =>
    thread({ id: 'a', contactPreference: 'whatsapp', authorUserId: 'u1', authorPhone: '063 555 1234', ...over });

  it('offers the hand-off when they asked for it and can be reached', async () => {
    expect(labelled(await openPanel(wants()), 'Send & open WhatsApp')).toBeDefined();
  });

  it('does not offer it when they did not ask for it', async () => {
    const tree = await openPanel(wants({ contactPreference: 'in_app' }));
    expect(labelled(tree, 'Send & open WhatsApp')).toBeUndefined();
  });

  it('does not offer it when there is no number to reach them on', async () => {
    expect(labelled(await openPanel(wants({ authorPhone: null })), 'Send & open WhatsApp')).toBeUndefined();
  });

  // A local 063 number is not dialable as typed, and whatsappLink returns null
  // rather than a link to an empty chat.
  it('does not offer it when the number cannot be dialled', async () => {
    expect(labelled(await openPanel(wants({ authorPhone: '12' })), 'Send & open WhatsApp')).toBeUndefined();
  });

  it('writes the reply into the thread BEFORE it opens the chat, with the text pre-filled', async () => {
    const tree = await openPanel(wants());
    typeReply(tree, 'Your payment is matched.');
    press(tree, 'Send & open WhatsApp');
    await act(async () => {});

    expect(callPlatformAdminMock).toHaveBeenCalledWith(
      'reply_support',
      { support: { threadId: 'a' } },
      'Your payment is matched.'
    );
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      `https://wa.me/252635551234?text=${encodeURIComponent('Your payment is matched.')}`
    );
    expect(callPlatformAdminMock.mock.invocationCallOrder[0]).toBeLessThan(
      openExternalUrlMock.mock.invocationCallOrder[0]
    );
  });

  // The ordering is the point: the thread has the record whatever the browser
  // does with the link.
  it('keeps the reply on the record when the hand-off is what fails', async () => {
    openExternalUrlMock.mockImplementation(() => {
      throw new Error('popup blocked');
    });
    const tree = await openPanel(wants());
    typeReply(tree, 'Your payment is matched.');
    press(tree, 'Send & open WhatsApp');
    await act(async () => {});

    expect(callPlatformAdminMock).toHaveBeenCalledTimes(1);
    expect(texts(tree)).toContain('The reply is on the thread, but WhatsApp did not open.');
  });

  it('opens a bare chat from the rail, with nothing written in it', async () => {
    press(await openPanel(wants()), 'Open chat');
    expect(openExternalUrlMock).toHaveBeenCalledWith('https://wa.me/252635551234');
    expect(callPlatformAdminMock).not.toHaveBeenCalled();
  });
});

function typeReply(tree: ReactTestRenderer, value: string): void {
  const input = tree.root.findAllByType(TextInput)[0];
  act(() => {
    input.props.onChangeText(value);
  });
}
