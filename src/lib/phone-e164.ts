// WhatsApp deep links take a number in E.164 and nothing else. `wa.me/252634456789`
// works; `wa.me/0634456789` opens a chat with nobody.
//
// Deliberately not a full libphonenumber. This app serves the Horn of Africa and
// the only default that matters is 252; anything already carrying its own country
// code passes through untouched. Adding a 300kB dependency to normalise one field
// would be the wrong trade.

const DEFAULT_COUNTRY = '252';

export function toE164(input: string, defaultCountry: string = DEFAULT_COUNTRY): string | null {
  if (typeof input !== 'string') return null;

  // Keep a leading plus, then digits only.
  const trimmed = input.trim();
  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (!hadPlus && digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (!hadPlus) {
    // A local number: drop the trunk zero, then prepend the country code.
    if (digits.startsWith('0')) digits = digits.slice(1);
    if (!digits.startsWith(defaultCountry)) digits = defaultCountry + digits;
  }

  // E.164 allows 15 digits maximum; anything under 8 is not a phone number.
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function formatE164ForDisplay(e164: string): string {
  const m = /^\+252(\d{2})(\d{7})$/.exec(e164);
  return m ? `+252 ${m[1]} ${m[2]}` : e164;
}
