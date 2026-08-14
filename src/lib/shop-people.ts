// Who works at a store, and where — as pure functions over already-fetched
// rows.
//
// Split out of the console's components for the reason src/lib/attention.ts is
// split out of dashboard.tsx: the rules here are easy to get subtly wrong and
// impossible to check by looking at one store's data on a screen. One of them
// is load-bearing on a security boundary's MEANING (see branchAccessLabel), so
// it is worth a test rather than a glance.

export type ShopPerson = {
  userId: string;
  shopId: string;
  /** Already falls back to the email's local part upstream; never empty. */
  name: string;
  email: string | null;
  phone: string | null;
  roleName: string;
  permissions: string[];
  /** True when shops.owner_id names them. Authority, not a role label. */
  isOwner: boolean;
  active: boolean;
  joinedAt: string;
  /**
   * The branches they are assigned to. EMPTY MEANS EVERY BRANCH — see
   * can_access_location() in 20260814000000. Never read this as "no access".
   */
  branchNames: string[];
};

export type Branch = {
  id: string;
  name: string;
  city: string | null;
  neighborhood: string | null;
  phone: string | null;
  isPrimary: boolean;
};

/**
 * What to put on a person's row about where they can work.
 *
 * Empty `branchNames` is access to everything, which is the opposite of what
 * the array looks like. The owner is hard-coded to the same answer because
 * their access comes from owns_shop() and never from an assignment row at all.
 *
 * Returns '' for a single-branch store — there is no access question to
 * answer, and a chip reading "All branches" beside a store with one branch is
 * noise.
 */
export function branchAccessLabel(person: ShopPerson, branchCount: number): string {
  if (branchCount <= 1) return '';
  const everywhere = person.isOwner || person.branchNames.length === 0 || person.branchNames.length >= branchCount;
  if (everywhere) return branchCount === 2 ? 'Both branches' : 'All branches';
  if (person.branchNames.length === 1) return person.branchNames[0];
  return `${person.branchNames.length} branches`;
}

/** Owner first, then everyone still working there, then everyone who has left. */
export function sortPeople(people: ShopPerson[]): ShopPerson[] {
  const rank = (p: ShopPerson) => (p.isOwner ? 0 : p.active ? 1 : 2);
  return [...people].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The first word of a name — what a person is called in a summary line. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * The one line that stands in for the whole team in the drawer. Often the
 * entire answer, which saves opening the roster at all.
 *
 * Null for a one-person shop: an owner with nobody else is a complete answer,
 * not a shortfall, and "0 others" is a worse way of saying it.
 */
export function teamSummary(people: ShopPerson[]): string | null {
  const others = people.filter((p) => !p.isOwner);
  if (others.length === 0) return null;
  const active = sortPeople(others.filter((p) => p.active));
  const gone = others.length - active.length;
  const named = active.slice(0, 3).map((p) => firstName(p.name));
  const extra = active.length - named.length;
  const parts: string[] = [];
  if (named.length > 0) parts.push(named.join(', ') + (extra > 0 ? ` +${extra}` : ''));
  if (gone > 0) parts.push(`${gone} who ${gone === 1 ? 'has' : 'have'} left`);
  return parts.join(' · ');
}

/**
 * Which number to offer for a store, in order: the owner's own, then the
 * primary branch's — the one printed on their receipts, which is today's
 * behaviour kept as the fallback rather than removed.
 */
export function contactPhone(person: ShopPerson | null, branches: Branch[]): string | null {
  if (person?.phone) return person.phone;
  const primary = branches.find((b) => b.isPrimary) ?? branches[0];
  return primary?.phone ?? null;
}

/** Digits only, so a search for "8820" finds "063 441 8820". */
function digits(value: string): string {
  return value.replace(/\D/g, '');
}

export function personMatchesQuery(person: ShopPerson, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (person.name.toLowerCase().includes(q)) return true;
  if (person.email?.toLowerCase().includes(q)) return true;
  const qDigits = digits(q);
  if (qDigits.length >= 3 && person.phone && digits(person.phone).includes(qDigits)) return true;
  return false;
}

/**
 * Where the business is, for a one-line cell: the primary branch's city, plus a
 * count when there are others. Three towns competing with the owner's name for
 * one line is how that line stops being readable.
 */
export function cityLabel(branches: Branch[]): string | null {
  const primary = branches.find((b) => b.isPrimary) ?? branches[0];
  if (!primary?.city) return null;
  const others = branches.length - 1;
  return others > 0 ? `${primary.city} +${others}` : primary.city;
}
