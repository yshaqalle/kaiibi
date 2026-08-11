// supportQueueState is pure, but it lives beside the query whose rows it
// classifies, and that module builds a Supabase client at import time. The
// mock also backs the listSupportThreads mapping tests at the bottom: those
// rows are the shape PostgREST hands back, so everything from that boundary
// inward is the real function.
//
// Author profiles come through the support_author_profiles() rpc rather than
// a plain `.from('profiles')` select (20260825000400 -- the table's select
// grant is column-unrestricted, so a row-scoped policy alone would hand back
// more than the name and phone the console shows). `rpc` is mocked
// separately from `from` for that reason.
jest.mock('@/lib/supabase', () => {
  const tables: Record<string, any[]> = {};
  const rpcResults: Record<string, any[]> = {};
  const client = {
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        in: () => builder,
        then: (resolve: any, reject: any) =>
          Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve, reject),
      };
      return builder;
    },
    rpc: (fn: string) => Promise.resolve({ data: rpcResults[fn] ?? [], error: null }),
  };
  return { supabase: client, __tables: tables, __rpcResults: rpcResults };
});

import { listSupportThreads, supportQueueState, type PlatformSupportThread } from '@/lib/platform';

const { __tables: tables, __rpcResults: rpcResults } = jest.requireMock('@/lib/supabase') as {
  __tables: Record<string, any[]>;
  __rpcResults: Record<string, any[]>;
};

function thread(over: Partial<PlatformSupportThread>): PlatformSupportThread {
  return {
    id: 't', reference: 'KB-1', shopId: 's', shopName: 'Shop',
    subject: 'Subject', category: 'billing', area: null, areaOther: null,
    status: 'open', openedBy: 'shop', contactPreference: 'in_app', clientContext: {},
    lastMessageAt: '2026-08-09T12:00:00.000Z',
    platformReadAt: null, shopReadAt: null,
    authorUserId: null, authorName: 'Amina', authorPhone: null,
    messageCount: 1, attachmentCount: 0,
    lastAuthorKind: 'shop',
    ...over,
  };
}

describe('supportQueueState', () => {
  // Whose move it is, not how old it is. A one-operator queue sorted by age
  // buries the thing that has been answered under the thing that has not.
  it('is needs_reply when they wrote last', () => {
    expect(supportQueueState(thread({ lastAuthorKind: 'shop' }))).toBe('needs_reply');
  });

  it('is unread_by_them when we wrote last and nobody has opened it', () => {
    expect(
      supportQueueState(thread({ lastAuthorKind: 'platform', shopReadAt: null }))
    ).toBe('unread_by_them');
  });

  it('is waiting_on_them once they have read what we wrote', () => {
    expect(
      supportQueueState(
        thread({
          lastAuthorKind: 'platform',
          lastMessageAt: '2026-08-09T12:00:00.000Z',
          shopReadAt: '2026-08-09T12:30:00.000Z',
        })
      )
    ).toBe('waiting_on_them');
  });

  it('is closed regardless of who wrote last', () => {
    expect(supportQueueState(thread({ status: 'closed', lastAuthorKind: 'shop' }))).toBe('closed');
  });

  // A read stamp older than the message it is meant to cover is the store
  // having read the PREVIOUS reply, not this one -- the same unread thread the
  // null case describes, reached through a stamp instead of its absence.
  it('is unread_by_them when their read stamp predates our latest message', () => {
    expect(
      supportQueueState(
        thread({
          lastAuthorKind: 'platform',
          lastMessageAt: '2026-08-09T12:00:00.000Z',
          shopReadAt: '2026-08-09T11:30:00.000Z',
        })
      )
    ).toBe('unread_by_them');
  });
});

describe('listSupportThreads', () => {
  beforeEach(() => {
    for (const key of Object.keys(tables)) delete tables[key];
    for (const key of Object.keys(rpcResults)) delete rpcResults[key];
  });

  it('reads the last author and the attachment count out of the messages it embeds', async () => {
    tables.support_threads = [
      {
        id: 'thread-1',
        reference: 'KB-2001',
        shop_id: 'shop-1',
        author_user_id: 'user-1',
        subject: 'Payment not showing',
        category: 'billing',
        area: 'unmatched',
        area_other: null,
        status: 'open',
        opened_by: 'shop',
        contact_preference: 'whatsapp',
        client_context: { screen: 'pos' },
        last_message_at: '2026-08-09T12:00:00.000Z',
        platform_read_at: null,
        shop_read_at: '2026-08-09T12:00:00.000Z',
        shops: { name: 'Hooyo Market' },
        support_messages: [
          // Deliberately out of order: PostgREST does not sort an embedded
          // resource, so a mapper that trusts the array order picks the wrong
          // author and puts the thread in the wrong queue.
          { author_kind: 'platform', created_at: '2026-08-09T11:00:00.000Z', support_attachments: [] },
          { author_kind: 'shop', created_at: '2026-08-09T10:00:00.000Z', support_attachments: [{ id: 'a1' }, { id: 'a2' }] },
        ],
      },
    ];
    rpcResults.support_author_profiles = [{ id: 'user-1', full_name: 'Amina', phone: '634000000' }];

    const { threads: [thread], truncated } = await listSupportThreads();
    expect(truncated).toBe(false);

    expect(thread.lastAuthorKind).toBe('platform');
    expect(thread.messageCount).toBe(2);
    expect(thread.attachmentCount).toBe(2);
    expect(thread.shopName).toBe('Hooyo Market');
    expect(thread.authorName).toBe('Amina');
    expect(thread.authorPhone).toBe('634000000');
    expect(supportQueueState(thread)).toBe('waiting_on_them');
  });

  it('falls back to opened_by when a thread has no messages yet', async () => {
    tables.support_threads = [
      {
        id: 'thread-2',
        reference: 'KB-2002',
        shop_id: 'shop-1',
        author_user_id: null,
        subject: 'Your payment cleared',
        category: 'billing',
        area: null,
        area_other: null,
        status: 'open',
        opened_by: 'platform',
        contact_preference: 'in_app',
        client_context: null,
        last_message_at: '2026-08-09T12:00:00.000Z',
        platform_read_at: '2026-08-09T12:00:00.000Z',
        shop_read_at: null,
        shops: null,
        support_messages: [],
      },
    ];

    const { threads: [thread] } = await listSupportThreads();

    expect(thread.lastAuthorKind).toBe('platform');
    expect(thread.authorName).toBeNull();
    expect(thread.clientContext).toEqual({});
    expect(supportQueueState(thread)).toBe('unread_by_them');
  });

  // The query's own .limit(200) is real Postgres behaviour a mock can't
  // exercise, so this pins the other half: the app-level signal that decides
  // whether the operator gets told the queue was cut off.
  it('reports truncated once the row count reaches the queue cap', async () => {
    tables.support_threads = Array.from({ length: 200 }, (_, i) => ({
      id: `thread-${i}`,
      reference: `KB-${i}`,
      shop_id: 'shop-1',
      author_user_id: null,
      subject: 'Subject',
      category: 'billing',
      area: null,
      area_other: null,
      status: 'open',
      opened_by: 'shop',
      contact_preference: 'in_app',
      client_context: null,
      last_message_at: '2026-08-09T12:00:00.000Z',
      platform_read_at: null,
      shop_read_at: null,
      shops: null,
      support_messages: [],
    }));

    const { threads, truncated } = await listSupportThreads();
    expect(threads).toHaveLength(200);
    expect(truncated).toBe(true);
  });
});
