// '@/lib/support' constructs the real Supabase client at module load and throws
// without EXPO_PUBLIC_SUPABASE_* env vars, and support-list imports isUnread
// from it. Everything under test here is pure; this only unblocks the import.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

import type { SupportThread } from '@/lib/support';
import {
  categoryLine,
  groupThreads,
  previewLine,
  shortWhen,
  statusChip,
  threadGroup,
} from '@/lib/support-list';

// Read at 11:00, last message at 10:00, so a thread is READ unless a field
// below says otherwise. The unread comparison is last_message_at > shop_read_at
// (isUnread, src/lib/support.ts).
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

describe('threadGroup', () => {
  it('files an unread thread under waiting whatever its status', () => {
    expect(threadGroup(thread({ shopReadAt: null }))).toBe('waiting');
    // The case this ordering exists for: answered and closed in one move. Filed
    // under Closed, the answer would sit behind the heading nobody opens.
    expect(threadGroup(thread({ shopReadAt: null, status: 'closed' }))).toBe('waiting');
  });

  it('splits the read ones by status', () => {
    expect(threadGroup(thread())).toBe('open');
    expect(threadGroup(thread({ status: 'closed' }))).toBe('closed');
  });
});

describe('groupThreads', () => {
  it('orders the groups and keeps each list in the order given', () => {
    const sections = groupThreads([
      thread({ id: 'read-open' }),
      thread({ id: 'closed', status: 'closed' }),
      thread({ id: 'unread-a', shopReadAt: null }),
      thread({ id: 'unread-b', shopReadAt: null }),
    ]);

    expect(sections.map((section) => section.group)).toEqual(['waiting', 'open', 'closed']);
    expect(sections[0].label).toBe('Waiting on you');
    expect(sections[0].threads.map((t) => t.id)).toEqual(['unread-a', 'unread-b']);
  });

  it('drops empty groups rather than rendering a heading over nothing', () => {
    expect(groupThreads([thread()]).map((section) => section.group)).toEqual(['open']);
    expect(groupThreads([])).toEqual([]);
  });
});

describe('statusChip', () => {
  it('is the one loud chip only when something is waiting on the reader', () => {
    expect(statusChip(thread({ shopReadAt: null }))).toEqual({ label: 'New reply', tone: 'accent' });
    expect(statusChip(thread()).tone).toBe('plain');
  });

  it('does not call the first message on a thread we opened a reply', () => {
    expect(statusChip(thread({ shopReadAt: null, openedBy: 'platform' })).label).toBe('New message');
  });

  it('says whose move it is on a read, open thread', () => {
    expect(statusChip(thread({ lastAuthorKind: 'shop' })).label).toBe('Waiting for us');
    expect(statusChip(thread({ lastAuthorKind: 'platform' })).label).toBe('Answered');
  });

  it('claims nothing about whose move it is when the author is unknown', () => {
    // A row from a database without migration 20260825000800. Guessing here
    // would tell somebody we are working on a thread we never saw.
    expect(statusChip(thread({ lastAuthorKind: null })).label).toBe('Open');
  });

  it('calls a closed thread resolved', () => {
    expect(statusChip(thread({ status: 'closed', lastAuthorKind: 'shop' })).label).toBe('Resolved');
  });
});

describe('previewLine', () => {
  it('names the end that wrote it', () => {
    expect(previewLine(thread())).toEqual({
      who: 'Kaiibi',
      body: 'Found it — the refund sheet was holding focus',
    });
    expect(previewLine(thread({ lastAuthorKind: 'shop' }))?.who).toBe('You');
  });

  it('is absent rather than half-drawn when either half is missing', () => {
    expect(previewLine(thread({ lastMessagePreview: null }))).toBeNull();
    expect(previewLine(thread({ lastAuthorKind: null }))).toBeNull();
  });
});

describe('categoryLine', () => {
  it('reads what it is, then where', () => {
    expect(categoryLine(thread())).toBe('Broken · POS & checkout');
  });

  it('prefers the store’s own words over the list they picked them from', () => {
    expect(categoryLine(thread({ area: 'other', areaOther: 'Cash drawer wiring' }))).toBe(
      'Broken · Cash drawer wiring'
    );
  });

  it('drops the area when there is none, and survives one it does not know', () => {
    expect(categoryLine(thread({ category: 'billing', area: null }))).toBe('Billing');
    expect(categoryLine(thread({ area: 'nowhere-in-particular' }))).toBe('Broken');
    // Stored by an operator (OPERATOR_CATEGORIES), which the store's own list
    // does not contain -- it still has to render.
    expect(categoryLine(thread({ category: 'changed' as SupportThread['category'], area: null }))).toBe(
      "Something's changed"
    );
  });
});

describe('shortWhen', () => {
  const now = new Date('2026-08-10T12:00:00Z');

  it('counts minutes, then hours', () => {
    expect(shortWhen('2026-08-10T11:59:40Z', now)).toBe('now');
    expect(shortWhen('2026-08-10T11:40:00Z', now)).toBe('20m');
    expect(shortWhen('2026-08-10T10:00:00Z', now)).toBe('2h');
    expect(shortWhen('2026-08-09T13:00:00Z', now)).toBe('23h');
  });

  it('names the day inside a week, then the date', () => {
    // 8 Aug 2026 is a Saturday. Rendered in the device's own zone, which the
    // suite pins to America/New_York -- 03:00Z is still the 7th there.
    expect(shortWhen('2026-08-08T15:00:00Z', now)).toBe('Sat');
    expect(shortWhen('2026-07-12T15:00:00Z', now)).toBe('12 Jul');
    expect(shortWhen('2025-11-03T15:00:00Z', now)).toBe('Nov 2025');
  });

  it('says now rather than a negative age when the device clock is behind', () => {
    expect(shortWhen('2026-08-10T14:00:00Z', now)).toBe('now');
  });

  it('renders nothing at all for a timestamp it cannot read', () => {
    expect(shortWhen('not a date', now)).toBe('');
  });
});
