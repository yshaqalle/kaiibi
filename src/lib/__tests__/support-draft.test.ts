import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { clearStoredDraft, readStoredDraft, writeStoredDraft } from '@/lib/support-draft';
import type { SupportDraft } from '@/lib/support';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

// Must match the key inside support-draft.ts. Duplicated rather than exported,
// because a key this module hands out is a key another module can write, and
// the point of these tests is that only this one does.
const keyFor = (userId: string) => `kaiibi.support.draft.${userId}`;
const KEY = keyFor(USER);

const draft: SupportDraft = {
  category: 'broken',
  area: 'pos',
  areaOther: '',
  subject: 'Scanner stops reading after a refund',
  details: 'It beeps but nothing lands in the cart.',
  contactPreference: 'whatsapp',
};

const thread = { id: '33333333-3333-4333-8333-333333333333', reference: 'KB-1042' };

// The writes are fire-and-forget by design, so the test has to wait for the
// promise nobody kept a handle on before it reads back.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Both storage paths are exercised, because they are separate code and the
// suite runs on one platform at a time. `OS` is a plain property on RN's
// Platform object under Jest; each test sets what it needs.
function onPlatform(os: typeof Platform.OS) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

const originalOS = Platform.OS;

// Jest's environment here is React Native's, which has a `window` but no
// localStorage, so the web path needs one to run against at all.
const webStorage = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (key: string) => webStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void webStorage.set(key, value),
  removeItem: (key: string) => void webStorage.delete(key),
};
Object.defineProperty(window, 'localStorage', { configurable: true, value: fakeLocalStorage });

describe.each(['web', 'ios'] as const)('support draft on %s', (os) => {
  beforeEach(async () => {
    onPlatform(os);
    webStorage.clear();
    await AsyncStorage.clear();
  });

  afterAll(() => onPlatform(originalOS));

  async function store(raw: string, key = KEY) {
    if (os === 'web') {
      webStorage.set(key, raw);
      return;
    }
    await AsyncStorage.setItem(key, raw);
  }

  const stored = (body: object) => JSON.stringify({ draft: { ...draft, ...body }, thread: null });

  it('round-trips a draft', async () => {
    writeStoredDraft(USER, draft, null);
    await settle();

    expect(await readStoredDraft(USER)).toEqual({ draft, thread: null });
  });

  // The whole point of the thread riding along: a send that opened a thread and
  // then died must be resumable, not re-filed.
  it('round-trips the thread a part-finished send opened', async () => {
    writeStoredDraft(USER, draft, thread);
    await settle();

    expect(await readStoredDraft(USER)).toEqual({ draft, thread });
  });

  // A shop tablet is signed in and out of all shift. A cashier's unsent
  // complaint about their manager must not be waiting in the manager's form.
  it("does not show one person another person's draft", async () => {
    writeStoredDraft(USER, draft, thread);
    await settle();

    expect(await readStoredDraft(OTHER_USER)).toBeNull();

    // ...and the second person's own draft does not disturb the first's.
    writeStoredDraft(OTHER_USER, { ...draft, subject: 'Card reader is offline' }, null);
    await settle();

    expect((await readStoredDraft(USER))?.draft.subject).toBe(draft.subject);
    expect((await readStoredDraft(OTHER_USER))?.draft.subject).toBe('Card reader is offline');
  });

  it("clearing one person's draft leaves the other's alone", async () => {
    writeStoredDraft(USER, draft, null);
    writeStoredDraft(OTHER_USER, draft, null);
    await settle();
    clearStoredDraft(OTHER_USER);
    await settle();

    expect(await readStoredDraft(USER)).toEqual({ draft, thread: null });
    expect(await readStoredDraft(OTHER_USER)).toBeNull();
  });

  it('reads nothing when nothing was written', async () => {
    expect(await readStoredDraft(USER)).toBeNull();
  });

  it('forgets the draft once it is cleared', async () => {
    writeStoredDraft(USER, draft, thread);
    await settle();
    clearStoredDraft(USER);
    await settle();

    expect(await readStoredDraft(USER)).toBeNull();
  });

  // The stored string was written by whatever build was installed last, and a
  // category dropped since then would throw in categoryMeta() the moment the
  // sheet rendered it.
  it('refuses a category that no longer exists', async () => {
    await store(stored({ category: 'printers' }));

    expect(await readStoredDraft(USER)).toBeNull();
  });

  it('keeps a draft whose category is still null', async () => {
    await store(stored({ category: null, area: null }));

    expect(await readStoredDraft(USER)).toEqual({
      draft: { ...draft, category: null, area: null },
      thread: null,
    });
  });

  it('survives corrupt JSON', async () => {
    await store('{"draft":{"category":"broken",');

    expect(await readStoredDraft(USER)).toBeNull();
  });

  // JSON.parse succeeds here and hands back something with no properties at
  // all, which is the case a plain try/catch around parse would miss.
  it('survives JSON that is not an object', async () => {
    await store('null');

    expect(await readStoredDraft(USER)).toBeNull();
  });

  // A record written before the thread was persisted alongside it.
  it('reads a record with no thread on it', async () => {
    await store(JSON.stringify({ draft }));

    expect(await readStoredDraft(USER)).toEqual({ draft, thread: null });
  });

  it('drops a thread that is missing its reference', async () => {
    await store(JSON.stringify({ draft, thread: { id: thread.id } }));

    expect(await readStoredDraft(USER)).toEqual({ draft, thread: null });
  });

  it('replaces fields of the wrong type with empty ones', async () => {
    await store(JSON.stringify({ draft: { category: 'billing', area: 7, subject: null, details: ['a'] } }));

    expect(await readStoredDraft(USER)).toEqual({
      draft: {
        category: 'billing',
        area: null,
        areaOther: '',
        subject: '',
        details: '',
        contactPreference: 'in_app',
      },
      thread: null,
    });
  });

  // 'sms' was never a contact preference, but a build that added one and then
  // removed it would leave this behind, and the value is written straight into
  // a checked column on send.
  it('falls back to in-app for an unknown contact preference', async () => {
    await store(stored({ contactPreference: 'sms' }));

    expect((await readStoredDraft(USER))?.draft.contactPreference).toBe('in_app');
  });
});
