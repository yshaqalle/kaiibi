import { whatsappLink } from '@/lib/whatsapp';

// openWhatsApp isn't tested here: it only picks a link and hands it to
// openExternalUrl, which is platform code (Linking / a DOM anchor). The
// normalization is the part with rules, and it is all in whatsappLink.

describe('whatsappLink', () => {
  it('assumes 252 for a local number written with a leading zero', () => {
    expect(whatsappLink('063 400 0000')).toBe('https://wa.me/252634000000');
  });

  it('keeps a number that already carries the country code', () => {
    expect(whatsappLink('252634000000')).toBe('https://wa.me/252634000000');
  });

  it('strips a leading +', () => {
    expect(whatsappLink('+252 63 400 0000')).toBe('https://wa.me/252634000000');
  });

  // 00 is how the international prefix is dialled locally; wa.me wants neither
  // it nor the +, just the country code onwards.
  it('strips a 00 international prefix', () => {
    expect(whatsappLink('00252634000000')).toBe('https://wa.me/252634000000');
  });

  it('prefixes a bare nine-digit local number', () => {
    expect(whatsappLink('634000000')).toBe('https://wa.me/252634000000');
  });

  // Punctuation merchants actually type: spaces, dashes, brackets, dots.
  it('ignores separators', () => {
    expect(whatsappLink('(063) 400-00.00')).toBe('https://wa.me/252634000000');
  });

  it('leaves a foreign number alone once it is long enough to be one', () => {
    expect(whatsappLink('+44 7700 900123')).toBe('https://wa.me/447700900123');
  });

  // Pins three behaviours at once, against a regression that over-corrected
  // toE164's guessing bug into refusing every unmarked foreign number:
  // a local number still gets 252 prefixed, an explicitly international
  // number still passes through untouched, and a long bare-digit number --
  // typed with no + and no leading 00 or 0 -- is used exactly as typed
  // rather than 252-prefixed (toE164's old bug) or refused (toE164's own,
  // correct behaviour for a value about to be stored).
  it('still prefixes a local number with 252', () => {
    expect(whatsappLink('0634456789')).toBe('https://wa.me/252634456789');
  });

  it('still passes an explicitly international number through untouched', () => {
    expect(whatsappLink('+447700900123')).toBe('https://wa.me/447700900123');
  });

  it('uses a long bare-digit foreign number exactly as typed, neither guessing nor refusing', () => {
    expect(whatsappLink('447700900123')).toBe('https://wa.me/447700900123');
  });

  it('returns null for a missing number', () => {
    expect(whatsappLink(null)).toBeNull();
    expect(whatsappLink(undefined)).toBeNull();
    expect(whatsappLink('')).toBeNull();
  });

  // The reason callers can ask this question instead of rendering a button
  // that opens an empty chat: too short to be a phone number at all.
  it('returns null for a number too short to dial', () => {
    expect(whatsappLink('1234')).toBeNull();
    expect(whatsappLink('n/a')).toBeNull();
  });

  it('appends an encoded message when one is given', () => {
    expect(whatsappLink('063 400 0000', 'Total: $5 & change')).toBe(
      'https://wa.me/252634000000?text=Total%3A%20%245%20%26%20change'
    );
  });

  it('omits the query entirely when there is no message', () => {
    expect(whatsappLink('063 400 0000')).not.toContain('?');
  });
});
