// WhatsApp deep links take a number in E.164 and nothing else. `wa.me/252634456789`
// works; `wa.me/0634456789` opens a chat with nobody.
//
// Deliberately not a full libphonenumber. This app serves the Horn of Africa and
// the only default that matters is 252. Adding a 300kB dependency to normalise
// one field would be the wrong trade.
//
// A leading `+` is NOT treated as proof that the rest of the input is a valid
// international number — a user can type `+00...` (both the plus and the
// international access code) or `+0...` (a plus glued to a trunk zero) and
// neither is a real country code. Both `+` and a leading `00` are read as the
// same claim — "what follows is a country code" — and that claim is checked:
// a country code never starts with 0, so anything that still does after the
// `00` is collapsed is rejected rather than passed through. Only input that
// makes no such claim is treated as a bare local number, and even then the
// default country is prepended unless enough digits already follow it to be
// a plausible subscriber number, not just a coincidental prefix match.

const DEFAULT_COUNTRY = '252';

export function toE164(input: string, defaultCountry: string = DEFAULT_COUNTRY): string | null {
  if (typeof input !== 'string') return null;

  // Keep a leading plus, then digits only.
  const trimmed = input.trim();
  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  // A leading + and a leading 00 both claim "what follows is already a
  // country code" — collapse the 00 access code so both forms are checked
  // the same way, regardless of whether the user also typed a plus.
  const claimsInternational = hadPlus || digits.startsWith('00');
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (claimsInternational) {
    // No country code begins with 0; a trunk zero here means the claim was
    // false, so this cannot be repaired — reject it rather than guess.
    if (digits.startsWith('0')) return null;
  } else {
    // A local number: drop the trunk zero, then prepend the country code —
    // unless what remains after a matching country-code prefix is already
    // long enough to be a real subscriber number, in which case the prefix
    // match was coincidental, not evidence the code is already present.
    if (digits.startsWith('0')) digits = digits.slice(1);
    const afterCountryCode = digits.startsWith(defaultCountry)
      ? digits.slice(defaultCountry.length)
      : null;
    if (afterCountryCode === null || afterCountryCode.length < 7) {
      digits = defaultCountry + digits;
    }
  }

  // E.164 allows 15 digits maximum; anything under 8 is not a phone number.
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function formatE164ForDisplay(e164: string): string {
  const m = /^\+252(\d{2})(\d{7})$/.exec(e164);
  return m ? `+252 ${m[1]} ${m[2]}` : e164;
}
