// '@/lib/support' constructs the real Supabase client at module load and throws
// without EXPO_PUBLIC_SUPABASE_* env vars -- same reason billing-period.test.ts
// mocks this module. Everything under test here is pure; this only unblocks the
// import.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  buildClientContext,
  unreadCount,
  validateDraft,
  whatsAppLink,
  type SupportDraft,
  type SupportThread,
} from '@/lib/support';

const validDraft: SupportDraft = {
  category: 'broken',
  area: 'pos',
  areaOther: '',
  subject: 'Scanner stops reading after a refund',
  details: 'It beeps but nothing lands in the cart.',
  contactPreference: 'in_app',
};

function thread(over: Partial<SupportThread>): SupportThread {
  return {
    id: 'thread-1',
    reference: 'KB-2481',
    subject: 'Subject',
    category: 'broken',
    area: null,
    areaOther: null,
    status: 'open',
    openedBy: 'shop',
    contactPreference: 'in_app',
    lastMessageAt: '2026-08-09T10:00:00.000Z',
    shopReadAt: '2026-08-09T10:00:00.000Z',
    createdAt: '2026-08-09T09:00:00.000Z',
    ...over,
  };
}

describe('validateDraft', () => {
  it('accepts a complete draft', () => {
    expect(validateDraft(validDraft)).toEqual({ ok: true });
  });

  it('names the first empty required field', () => {
    expect(validateDraft({ ...validDraft, subject: '   ' })).toEqual({
      ok: false,
      field: 'subject',
      message: 'Give this a short subject so we can find it again.',
    });
    expect(validateDraft({ ...validDraft, details: '' }).ok).toBe(false);
    expect(validateDraft({ ...validDraft, category: null }).ok).toBe(false);
  });

  // The area itself is optional on purpose -- someone whose till is frozen
  // must not be blocked by a field about taxonomy.
  it('accepts a draft with no area', () => {
    expect(validateDraft({ ...validDraft, area: null })).toEqual({ ok: true });
  });

  // ...but if they reached for the escape hatch, the capture is the point.
  it('requires the free text once "something else" is picked', () => {
    const draft = { ...validDraft, area: 'other', areaOther: '' };
    expect(validateDraft(draft)).toEqual({
      ok: false,
      field: 'areaOther',
      message: 'Tell us in a few words what this is about.',
    });
    expect(validateDraft({ ...draft, areaOther: 'Training' })).toEqual({ ok: true });
  });

  it('requires the free text for the "other" category too', () => {
    expect(validateDraft({ ...validDraft, category: 'other', area: null, areaOther: '' }).ok).toBe(false);
  });

  it('refuses details longer than the column allows', () => {
    const result = validateDraft({ ...validDraft, details: 'x'.repeat(4001) });
    expect(result).toEqual({ ok: false, field: 'details', message: 'That is longer than we can store — please trim it to 4000 characters.' });
  });
});

describe('buildClientContext', () => {
  it('records what we know about where this came from', () => {
    expect(
      buildClientContext({
        appVersion: '1.4.2',
        buildNumber: '118',
        platform: 'android',
        isTablet: true,
        screen: '/pos',
        locationName: 'Main branch',
      })
    ).toEqual({
      appVersion: '1.4.2',
      buildNumber: '118',
      platform: 'android',
      deviceClass: 'tablet',
      screen: '/pos',
      locationName: 'Main branch',
    });
  });

  it('omits what it does not know rather than writing "undefined"', () => {
    const context = buildClientContext({
      appVersion: null,
      buildNumber: null,
      platform: 'web',
      isTablet: false,
      screen: '/dashboard',
      locationName: null,
    });
    expect(context).toEqual({ platform: 'web', deviceClass: 'phone', screen: '/dashboard' });
    expect(Object.values(context).every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
  });
});

describe('whatsAppLink', () => {
  it('delegates number normalisation to lib/whatsapp', () => {
    expect(whatsAppLink('+252 63 442 1180', 'hi')).toBe('https://wa.me/252634421180?text=hi');
  });

  it('percent-encodes the message', () => {
    expect(whatsAppLink('252634421180', 'Found it — fixed in 1.4.3')).toBe(
      'https://wa.me/252634421180?text=Found%20it%20%E2%80%94%20fixed%20in%201.4.3'
    );
  });

  it('returns null when there is no usable number', () => {
    expect(whatsAppLink('', 'hi')).toBeNull();
    expect(whatsAppLink('   ', 'hi')).toBeNull();
    expect(whatsAppLink('not a phone', 'hi')).toBeNull();
  });
});

describe('unreadCount', () => {
  it('counts threads whose last message arrived after the store last looked', () => {
    expect(
      unreadCount([
        thread({ id: 'a', lastMessageAt: '2026-08-09T12:00:00.000Z', shopReadAt: '2026-08-09T11:00:00.000Z' }),
        thread({ id: 'b', lastMessageAt: '2026-08-09T12:00:00.000Z', shopReadAt: '2026-08-09T12:00:00.000Z' }),
      ])
    ).toBe(1);
  });

  it('treats a never-read thread as unread', () => {
    expect(unreadCount([thread({ shopReadAt: null })])).toBe(1);
  });

  it('is zero for an empty list', () => {
    expect(unreadCount([])).toBe(0);
  });
});
