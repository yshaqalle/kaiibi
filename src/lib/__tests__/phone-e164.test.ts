import { toE164, formatE164ForDisplay } from '@/lib/phone-e164';

describe('toE164', () => {
  it('keeps an already-correct number', () => {
    expect(toE164('+252634456789')).toBe('+252634456789');
  });

  it('strips spaces, hyphens and brackets', () => {
    expect(toE164('+252 63 4 45 67 89')).toBe('+252634456789');
    expect(toE164('+252-63-4456789')).toBe('+252634456789');
  });

  it('turns a 00 prefix into a plus', () => {
    expect(toE164('00252634456789')).toBe('+252634456789');
  });

  it('adds the default country to a local number, dropping the trunk zero', () => {
    expect(toE164('0634456789')).toBe('+252634456789');
    expect(toE164('634456789')).toBe('+252634456789');
  });

  it('rejects something too short to be a number', () => {
    expect(toE164('6344')).toBeNull();
  });

  it('rejects letters', () => {
    expect(toE164('call me')).toBeNull();
    expect(toE164('')).toBeNull();
  });

  it('rejects a plus followed by nothing usable', () => {
    expect(toE164('+')).toBeNull();
  });
});

describe('toE164 — malformed international input', () => {
  it('collapses a 00 prefix even when the user also typed a plus', () => {
    expect(toE164('+00252634456789')).toBe('+252634456789');
  });

  it('rejects a plus followed by a trunk zero, because no country code starts with zero', () => {
    expect(toE164('+0634456789')).toBeNull();
  });

  it('still passes through a genuine international number untouched', () => {
    expect(toE164('+447700900123')).toBe('+447700900123');
  });

  it('prefixes a local number that merely starts with the country digits', () => {
    // A 9-digit local subscriber number beginning 252 is NOT already international.
    expect(toE164('252456789')).toBe('+252252456789');
  });

  it('still recognises a real international number typed without its plus', () => {
    expect(toE164('252634456789')).toBe('+252634456789');
  });
});

describe('formatE164ForDisplay', () => {
  it('groups a Somali number readably', () => {
    expect(formatE164ForDisplay('+252634456789')).toBe('+252 63 4456789');
  });

  it('returns anything it does not recognise unchanged', () => {
    expect(formatE164ForDisplay('+4407700900000')).toBe('+4407700900000');
  });
});
