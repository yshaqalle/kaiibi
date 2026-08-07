// How the signed-in person is named in chrome -- the Dashboard header's user
// chip today, and anywhere else that has room for a person but not a full row.
//
// Header space is the constraint. A name has to survive next to a search field
// on a laptop and an avatar alone on a phone, so this shortens rather than
// truncates: "Abdi M." is still recognisably you, where an ellipsis at
// character 12 ("Abdi Mohame…") is just damage. Truncation is the fallback
// (numberOfLines on the Text), not the plan.

/** Whitespace-collapsed, or null when there is nothing usable. */
function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : null;
}

// One resolved source for both functions below, so a name and its initials can
// never disagree about who they are describing.
//
// The email local part is the last resort rather than the raw address: the
// domain is the same for everyone on a team and costs the width that the part
// that identifies them needs.
function source(fullName: string | null | undefined, email: string | null | undefined): string | null {
  return clean(fullName) ?? clean((email ?? '').split('@')[0]);
}

/**
 * A person's name at header width: first name plus a last initial.
 *
 * A single-word name is left alone -- "Abdi" is already short, and "Abdi A."
 * would invent an initial that isn't theirs. Middle names are dropped, not
 * initialised, because "Abdi M. H." reads as a form field rather than a person.
 */
export function shortPersonName(fullName: string | null | undefined, email?: string | null): string {
  const resolved = source(fullName, email);
  if (!resolved) return 'Signed in';
  const words = resolved.split(' ');
  if (words.length === 1) return words[0];
  return `${words[0]} ${words[words.length - 1].charAt(0).toUpperCase()}.`;
}

/**
 * One or two letters for an avatar. First and LAST initial, matching
 * `shortPersonName` -- the chip shows both together, and taking the middle
 * name's letter for one and the surname's for the other would read as two
 * different people.
 */
export function personInitials(fullName: string | null | undefined, email?: string | null): string {
  const resolved = source(fullName, email);
  if (!resolved) return '?';
  const words = resolved.split(' ');
  const first = words[0].charAt(0);
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : '';
  return (first + last).toUpperCase();
}
