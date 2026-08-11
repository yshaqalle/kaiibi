// The one place the support taxonomy is defined. The store's sheet, the
// operator's filter chips and the database's check constraints all read from
// here, so adding a category is one edit rather than four.
//
// Two levels on purpose: the category says WHAT KIND of thing this is, the
// area says WHERE. The area is always optional -- someone whose till is
// frozen must never be blocked by a field about taxonomy.

export type SupportCategory =
  | 'broken'
  | 'help'
  | 'billing'
  | 'access'
  | 'data'
  | 'hardware'
  | 'feature'
  | 'other';

export type AreaOption = { key: string; label: string };

export type CategoryMeta = {
  key: SupportCategory;
  glyph: string;
  /** Full chip text, used when there is room. */
  label: string;
  /** Narrow-screen chip text. */
  shortLabel: string;
  detailsLabel: string;
  detailsHint: string;
  /** Label above the second dropdown; null when the category has no dropdown. */
  areaLabel: string | null;
  areas: readonly AreaOption[];
};

/**
 * The escape hatch every dropdown ends in. Picking it reveals a free-text box
 * whose answer is stored on the thread -- a category list guessed up front is
 * always wrong, and this is the mechanism that corrects it.
 */
export const OTHER_AREA_KEY = 'other';

// Mirrors the sidebar's own words (POS, Inventory, People, Accounting,
// Settings) so nobody has to translate what they were looking at into our
// vocabulary. Signing in and receipts are added because both sit outside the
// nav and both generate support.
const APP_AREAS: readonly AreaOption[] = [
  { key: 'pos', label: 'POS & checkout' },
  { key: 'inventory', label: 'Inventory & products' },
  { key: 'people', label: 'People & staff' },
  { key: 'customers', label: 'Customers' },
  { key: 'accounting', label: 'Accounting & reports' },
  { key: 'settings', label: 'Settings' },
  { key: 'signin', label: 'Signing in' },
  { key: 'receipts', label: 'Receipts & printing' },
  { key: OTHER_AREA_KEY, label: 'Somewhere else' },
];

export const SUPPORT_CATEGORIES: readonly CategoryMeta[] = [
  {
    key: 'broken',
    glyph: '🐞',
    label: "Something's broken",
    shortLabel: 'Broken',
    detailsLabel: 'What happened?',
    detailsHint:
      'Helps most: what you did, what you expected, what happened instead — and whether it happens every time.',
    areaLabel: 'Where in the app?',
    areas: APP_AREAS,
  },
  {
    key: 'help',
    glyph: '💬',
    label: 'I need help using it',
    shortLabel: 'Help',
    detailsLabel: 'What are you trying to do?',
    detailsHint: "What you're trying to get done, and where you got stuck.",
    areaLabel: 'Where in the app?',
    areas: APP_AREAS,
  },
  {
    key: 'billing',
    glyph: '💳',
    label: 'Billing or payment',
    shortLabel: 'Billing',
    detailsLabel: 'What do you need?',
    detailsHint: 'Helps most: the amount, the number you sent from, and the confirmation reference.',
    areaLabel: 'What kind?',
    areas: [
      { key: 'unmatched', label: "A payment I've made isn't showing" },
      { key: 'change_plan', label: 'I want to change plan' },
      { key: 'wrong_charge', label: 'I was charged wrong' },
      { key: 'invoice', label: 'I need an invoice or receipt' },
      { key: 'lapsed', label: "My plan lapsed and I'm locked out" },
      { key: OTHER_AREA_KEY, label: 'Something else' },
    ],
  },
  {
    key: 'access',
    glyph: '🔐',
    label: 'Account or access',
    shortLabel: 'Access',
    detailsLabel: "What's happening?",
    detailsHint: 'Helps most: which email or phone you sign in with, and what it says when you try.',
    areaLabel: 'What kind?',
    areas: [
      { key: 'cant_sign_in', label: "I can't sign in" },
      { key: 'forgot_password', label: 'I forgot my password' },
      { key: 'wrong_role', label: "Someone's role is wrong" },
      { key: 'add_remove_person', label: 'Add or remove a person' },
      { key: 'add_branch', label: 'Add a branch' },
      { key: OTHER_AREA_KEY, label: 'Something else' },
    ],
  },
  {
    key: 'data',
    glyph: '📊',
    label: 'Wrong numbers or missing data',
    shortLabel: 'Numbers',
    detailsLabel: "What's wrong, and what should it say?",
    detailsHint:
      'What it shows, what you expected, and roughly when it went wrong. The gap between the two is the whole report.',
    areaLabel: 'Which numbers?',
    areas: [
      { key: 'stock', label: 'Stock counts' },
      { key: 'sale', label: "A sale that's missing or duplicated" },
      { key: 'reports', label: 'Dashboard or reports' },
      { key: 'payroll', label: 'Payroll or hours' },
      { key: 'customers', label: 'Customer records' },
      { key: OTHER_AREA_KEY, label: 'Something else' },
    ],
  },
  {
    key: 'hardware',
    glyph: '🖨',
    label: 'Scanner, printer or till',
    shortLabel: 'Hardware',
    detailsLabel: "What's it doing?",
    detailsHint: 'Helps most: the make and model if you know it, and whether it ever worked.',
    areaLabel: 'Which one?',
    areas: [
      { key: 'scanner', label: 'Barcode scanner' },
      { key: 'printer', label: 'Receipt printer' },
      { key: 'drawer', label: 'Cash drawer' },
      { key: 'terminal', label: 'Card or mobile-money terminal' },
      { key: 'device', label: 'The tablet or phone itself' },
      { key: OTHER_AREA_KEY, label: 'Something else' },
    ],
  },
  {
    key: 'feature',
    glyph: '✨',
    label: 'Feature request',
    shortLabel: 'Feature',
    detailsLabel: 'What would you like it to do?',
    detailsHint: "What you'd use it for. Knowing the job it does for you shapes what we build.",
    areaLabel: 'Where would it live?',
    areas: APP_AREAS,
  },
  {
    key: 'other',
    glyph: '🗒',
    label: 'Something else',
    shortLabel: 'Else',
    detailsLabel: 'Tell us more',
    detailsHint: 'Anything at all.',
    areaLabel: null,
    areas: [],
  },
];

export type OperatorCategory = 'billing' | 'account' | 'problem' | 'changed' | 'other';

// Shorter than the store's on purpose: an operator never files a feature
// request or a hardware fault against a customer.
export const OPERATOR_CATEGORIES: readonly { key: OperatorCategory; glyph: string; label: string }[] = [
  { key: 'billing', glyph: '💳', label: 'Billing' },
  { key: 'account', glyph: '🔐', label: 'Their account' },
  { key: 'problem', glyph: '🐞', label: 'A problem we found' },
  { key: 'changed', glyph: '📣', label: "Something's changed" },
  { key: 'other', glyph: '🗒', label: 'Something else' },
];

/**
 * Every category a stored thread can carry, in one list, for the operator's
 * filter chips.
 *
 * The two lists above are the two things either END may file, and the queue
 * holds both. Filtering on the store's list alone left `account`, `problem` and
 * `changed` reachable under "All" and under no chip at all — visible as chip
 * counts that do not add up to the All count, and invisible as three kinds of
 * conversation an operator cannot pull up.
 *
 * De-duplicated on key, store list first: `billing` and `other` exist on both
 * sides and are the same stored value, so two chips would filter identically
 * and double-count the same threads.
 */
export const FILTER_CATEGORIES: readonly { key: string; label: string }[] = [
  ...SUPPORT_CATEGORIES.map((category) => ({ key: category.key as string, label: category.shortLabel })),
  ...OPERATOR_CATEGORIES.map((category) => ({ key: category.key as string, label: category.label })),
].filter((category, index, all) => all.findIndex((c) => c.key === category.key) === index);

const CATEGORY_KEYS: readonly string[] = SUPPORT_CATEGORIES.map((category) => category.key);

export function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === 'string' && CATEGORY_KEYS.includes(value);
}

// Throws rather than returning undefined: every caller renders the result
// straight into the UI, and a silent undefined there is a blank screen with no
// clue why.
export function categoryMeta(key: SupportCategory): CategoryMeta {
  const found = SUPPORT_CATEGORIES.find((category) => category.key === key);
  if (!found) throw new Error(`unknown support category: ${key}`);
  return found;
}

export function needsAreaOther(category: SupportCategory, area: string | null): boolean {
  if (category === 'other') return true;
  return area === OTHER_AREA_KEY;
}
