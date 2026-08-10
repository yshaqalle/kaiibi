import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The tab imports @/lib/platform for supportQueueState, which imports the live
// client; that throws at require time without env vars. Same stub the settings
// panel tests use.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

import { SupportTab } from '@/components/platform/support-tab';
import type { PlatformShopRow, PlatformSupportThread } from '@/lib/platform';

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

const SHOPS = [{ shopId: 'shop-1', shopName: 'Hooyo Market', planName: 'Growth' } as PlatformShopRow];

function render(threads: PlatformSupportThread[], now: number = NOON, truncated = false) {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <SupportTab
        threads={threads}
        shops={SHOPS}
        now={now}
        truncated={truncated}
        onOpen={jest.fn()}
        onCompose={jest.fn()}
      />
    );
  });
  return tree!.root
    .findAllByType(Text)
    .map((t) => (Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children)));
}

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
