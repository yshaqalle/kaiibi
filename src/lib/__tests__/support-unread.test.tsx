import { act, create } from 'react-test-renderer';

import { useAuth } from '@/hooks/use-auth';
import { listMyThreads, type SupportThread } from '@/lib/support';
import { resetSupportUnread, useSupportUnread } from '@/lib/support-unread';

// The behaviours covered here are ordering bugs, so every assertion is about a
// SEQUENCE -- of published counts, or of channel opens and removes. A test that
// only looked at the number left on screen at the end passes against the broken
// version of all of them.
//
// babel-plugin-jest-hoist lifts these three jest.mock() calls above the imports
// above, so those bindings are already the mocks.
jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn(() => ({ session: null })) }));

// Records what the store asked the realtime client to do, in order, and hands
// back the per-topic INSERT handler and status callback so a test can play the
// server's part.
jest.mock('@/lib/supabase', () => {
  const events: string[] = [];
  const inserts = new Map<string, any>();
  const statuses = new Map<string, any>();
  const client = {
    channel: (topic: string) => {
      events.push(`channel:${topic}`);
      const channel: any = {
        topic,
        on: (_type: any, _filter: any, handler: any) => {
          inserts.set(topic, handler);
          return channel;
        },
        subscribe: (callback?: any) => {
          events.push(`subscribe:${topic}`);
          if (callback) statuses.set(topic, callback);
          return channel;
        },
      };
      return channel;
    },
    removeChannel: (channel: any) => {
      events.push(`removeChannel:${channel.topic}`);
      return Promise.resolve('ok');
    },
  };
  return { supabase: client, __events: events, __inserts: inserts, __statuses: statuses };
});

jest.mock('@/lib/support', () => ({
  ...jest.requireActual('@/lib/support'),
  listMyThreads: jest.fn(),
}));

const realtime = jest.requireMock('@/lib/supabase') as {
  __events: string[];
  __inserts: Map<string, () => void>;
  __statuses: Map<string, (status: string) => void>;
};
const events = realtime.__events;
const asMock = (fn: unknown) => fn as jest.Mock;

function signedInAs(userId: string | null) {
  asMock(useAuth).mockReturnValue({ session: userId ? { user: { id: userId } } : null });
}

/** `n` threads that have never been read, i.e. a count of `n`. */
function unreadThreads(n: number): SupportThread[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    lastMessageAt: '2026-08-09T10:00:00Z',
    shopReadAt: null,
  })) as SupportThread[];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Stands in for one caller of the hook -- the ☰ row or the banner. */
function Consumer({ onRender }: { onRender: (count: number) => void }) {
  const { count } = useSupportUnread();
  onRender(count);
  return null;
}

beforeEach(() => {
  resetSupportUnread();
  events.length = 0;
  realtime.__inserts.clear();
  realtime.__statuses.clear();
  asMock(listMyThreads).mockReset();
  asMock(useAuth).mockReset();
  signedInAs(null);
});

describe('useSupportUnread across accounts', () => {
  it('drops to zero on sign-out and ignores the previous account\'s count landing late', async () => {
    const counts: number[] = [];
    const render = (count: number) => counts.push(count);
    signedInAs('user-a');
    asMock(listMyThreads).mockResolvedValue(unreadThreads(2));

    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Consumer onRender={render} />); });
    expect(counts[counts.length - 1]).toBe(2);

    // A count for user A that is still in flight when they sign out. On a
    // shared tablet this is the ordinary case: an incoming message fires a
    // refetch, the next person takes the tablet before it lands.
    const inFlight = deferred<SupportThread[]>();
    asMock(listMyThreads).mockReturnValue(inFlight.promise);
    act(() => { realtime.__inserts.get('support-unread-1')!(); });

    signedInAs(null);
    await act(async () => { tree.update(<Consumer onRender={render} />); });
    expect(counts[counts.length - 1]).toBe(0);
    // Signing out closes the channel: it authorises with the token of the
    // account that just left.
    expect(events).toContain('removeChannel:support-unread-1');

    const afterSignOut = counts.length;
    await act(async () => { inFlight.resolve(unreadThreads(3)); await inFlight.promise; });
    // The point of the test: A's number must not reappear on B's screen.
    expect(counts.slice(afterSignOut)).not.toContain(3);
    expect(counts[counts.length - 1]).toBe(0);
  });

  it('shows the next user zero on their very first render, not the last user\'s number', async () => {
    signedInAs('user-a');
    asMock(listMyThreads).mockResolvedValue(unreadThreads(2));
    const first: number[] = [];
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Consumer onRender={(c) => first.push(c)} />); });
    expect(first[first.length - 1]).toBe(2);

    // Sign-out on a shared tablet unmounts the shells, so the store has no
    // consumers at all before the next person's first render.
    await act(async () => { tree.unmount(); });

    signedInAs('user-b');
    asMock(listMyThreads).mockResolvedValue(unreadThreads(0));
    const second: number[] = [];
    await act(async () => { create(<Consumer onRender={(c) => second.push(c)} />); });
    // The first render reads the store directly, before any effect has run. It
    // must not paint user A's 2, even for the one frame.
    expect(second[0]).toBe(0);
    expect(second).not.toContain(2);
    // And the new account gets its own channel rather than the one authorised
    // with the old token.
    expect(events.filter((e) => e.startsWith('channel:'))).toEqual(['channel:support-unread-1', 'channel:support-unread-2']);
  });
});

describe('useSupportUnread channel lifecycle', () => {
  it('keeps the channel while any consumer is mounted and opens a fresh one after the last unmounts', async () => {
    signedInAs('user-a');
    asMock(listMyThreads).mockResolvedValue(unreadThreads(1));
    const counts: number[] = [];
    const both = (
      <>
        <Consumer onRender={() => {}} />
        <Consumer onRender={(c) => counts.push(c)} />
      </>
    );
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(both); });
    expect(events.filter((e) => e.startsWith('channel:'))).toEqual(['channel:support-unread-1']);

    // The ☰ row unmounts every time the menu closes; the banner stays.
    await act(async () => { tree.update(<Consumer onRender={(c) => counts.push(c)} />); });
    expect(events).not.toContain('removeChannel:support-unread-1');
    // Still delivering to the consumer left on screen -- the refcount exists
    // for this and nothing else.
    asMock(listMyThreads).mockResolvedValue(unreadThreads(4));
    await act(async () => { realtime.__inserts.get('support-unread-1')!(); await Promise.resolve(); });
    expect(counts[counts.length - 1]).toBe(4);

    await act(async () => { tree.unmount(); });
    expect(events).toContain('removeChannel:support-unread-1');

    await act(async () => { create(<Consumer onRender={() => {}} />); });
    // removeChannel() only drops the channel from the client's list after
    // unsubscribe() resolves, so a remount under the previous topic would be
    // handed the dying channel back. Hence a topic per generation, and hence
    // the order of these three.
    expect(events.filter((e) => e.includes('support-unread-1') || e.includes('support-unread-2'))).toEqual([
      'channel:support-unread-1',
      'subscribe:support-unread-1',
      'removeChannel:support-unread-1',
      'channel:support-unread-2',
      'subscribe:support-unread-2',
    ]);
  });

  it('retries on the next mount after a subscription that never came up', async () => {
    signedInAs('user-a');
    asMock(listMyThreads).mockResolvedValue(unreadThreads(1));
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Consumer onRender={() => {}} />); });

    // The banner stays mounted through this, so nothing ever takes the consumer
    // count to zero: without the status callback the failed channel is still
    // the store's channel and every later mount is turned away by it.
    act(() => { realtime.__statuses.get('support-unread-1')!('CHANNEL_ERROR'); });

    await act(async () => {
      tree.update(
        <>
          <Consumer onRender={() => {}} />
          <Consumer onRender={() => {}} />
        </>,
      );
    });
    expect(events.filter((e) => e.startsWith('channel:'))).toEqual(['channel:support-unread-1', 'channel:support-unread-2']);
  });
});
