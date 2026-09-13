import { formatCents } from '@/lib/currency';
import type { AuditRow } from '@/lib/ledger';
import type { Account, AccountType, JournalEntry } from '@/types/models';

// What the Journals and Audit Log detail panes say about an entry: its lines
// as debit/credit, what it did in plain words, how it came to be posted, and
// the audit log folded into one row per thing that happened. Pure, so every
// sentence a shopkeeper reads can be tested without a database.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// ── descriptions ────────────────────────────────────────────────────────────

// What the posting functions write is "Sale <uuid>" / "Expense <uuid>" -- a
// description a person cannot read. Posted entries are immutable, so the
// friendlier line is worked out when shown, from what the sale or expense says
// about itself. Anything unresolved (a deleted sale, a source nobody looked
// up) keeps its words and loses only the noise: the id shrinks to 8 characters.
export type SourceNames = { sales: Map<string, string>; expenses: Map<string, string> };

export function readableDescription(description: string, names: SourceNames): string {
  const sale = description.match(/^Sale ([0-9a-f-]{36})$/i);
  if (sale && names.sales.has(sale[1])) return `Sale · ${names.sales.get(sale[1])}`;
  const expense = description.match(/^Expense ([0-9a-f-]{36})$/i);
  if (expense && names.expenses.has(expense[1])) return `Expense · ${names.expenses.get(expense[1])}`;
  return description.replace(UUID, (id) => id.slice(0, 8));
}

export function referencedIds(description: string, kind: 'sale' | 'expense'): string[] {
  const pattern = kind === 'sale' ? /sale ([0-9a-f-]{36})/gi : /expense ([0-9a-f-]{36})/gi;
  return [...description.matchAll(pattern)].map((m) => m[1].toLowerCase());
}

// ── lines ───────────────────────────────────────────────────────────────────

export type DetailLine = {
  id: string;
  code: string;
  accountName: string;
  memo: string | null;
  debitCents: number;
  creditCents: number;
};

export function detailLines(entry: JournalEntry, accounts: Map<string, Account>): {
  lines: DetailLine[];
  debitCents: number;
  creditCents: number;
} {
  const lines = entry.lines.map((line) => {
    const account = accounts.get(line.accountId);
    return {
      id: line.id,
      code: account?.code ?? '—',
      accountName: account?.name ?? 'Unknown account',
      memo: line.memo,
      debitCents: line.amountCents > 0 ? line.amountCents : 0,
      creditCents: line.amountCents < 0 ? -line.amountCents : 0,
    };
  });
  return {
    lines,
    debitCents: lines.reduce((sum, l) => sum + l.debitCents, 0),
    creditCents: lines.reduce((sum, l) => sum + l.creditCents, 0),
  };
}

// ── in plain words ──────────────────────────────────────────────────────────

// One sentence per account the entry moved, netted, in line order. Worded by
// the account's TYPE and which way it moved, with the few accounts a shop
// meets every day (cash and mobile money, receivables, stock, tax) given their
// own words. Contra accounts (returns, discounts, depreciation) move the
// opposite way to their type, so their direction is read the other way round.
export function plainWords(entry: JournalEntry, accounts: Map<string, Account>): string[] {
  const net = new Map<string, number>();
  for (const line of entry.lines) net.set(line.accountId, (net.get(line.accountId) ?? 0) + line.amountCents);

  const sentences: string[] = [];
  for (const [accountId, amount] of net) {
    if (amount === 0) continue;
    const account = accounts.get(accountId);
    if (!account) continue;
    sentences.push(sentenceFor(account, amount));
  }
  return sentences;
}

function sentenceFor(account: Account, signedCents: number): string {
  const money = formatCents(Math.abs(signedCents));
  const debit = signedCents > 0;
  const name = account.name;
  const code = Number(account.code);

  if (account.type === 'asset') {
    if (account.isContra) return debit ? `${money} came off ${name}.` : `${money} was added to ${name}.`;
    if (code >= 1000 && code < 1100) return debit ? `${money} came into ${name}.` : `${money} went out of ${name}.`;
    if (code >= 1100 && code < 1200) return debit ? `A customer now owes you ${money} more.` : `${money} a customer owed you was cleared.`;
    if (code >= 1200 && code < 1300) return debit ? `${money} of stock came onto the shelf.` : `${money} of stock left the shelf.`;
    return debit ? `${name} went up by ${money}.` : `${name} went down by ${money}.`;
  }
  if (account.type === 'liability') {
    if (code >= 2100 && code < 2200) return debit ? `${money} less tax is owed to the government.` : `${money} is tax you hold for the government.`;
    return debit ? `You owe ${money} less on ${name}.` : `You owe ${money} more on ${name}.`;
  }
  if (account.type === 'equity') {
    return debit ? `${money} came out of ${name}.` : `${money} was added to ${name}.`;
  }
  if (account.type === 'revenue') {
    if (account.isContra) return debit ? `${money} came off your sales as ${name}.` : `${money} of ${name} was undone.`;
    return debit ? `${money} of ${name} was taken back.` : `You earned ${money} of ${name}.`;
  }
  // cost_of_sales and expense
  const kind: AccountType = account.type;
  if (account.isContra) return debit ? `${money} of ${name} was undone.` : `${money} was recorded as ${name}.`;
  if (kind === 'cost_of_sales') return debit ? `${money} became ${name}.` : `${money} of ${name} was taken back.`;
  return debit ? `${money} was spent on ${name}.` : `${money} of ${name} was taken back.`;
}

// ── how it was posted ───────────────────────────────────────────────────────

export type PostingHow = { automatic: boolean; text: string };

// From the source the posting function stamped and the description it wrote.
// A reversal carries its original's source, so the description is what tells
// a deletion from an edit.
export function postingHow(entry: Pick<JournalEntry, 'source' | 'description' | 'reversesEntryId' | 'reference'>): PostingHow {
  const isReversal = Boolean(entry.reference?.endsWith('R'));
  if (isReversal) {
    if (/was deleted/i.test(entry.description)) return { automatic: true, text: 'Written automatically when the source was deleted' };
    if (/edit/i.test(entry.description)) return { automatic: true, text: 'Written automatically when the source was edited' };
    if (entry.source === 'manual') return { automatic: false, text: 'Reversed by hand on the Journals screen' };
    return { automatic: true, text: 'Written automatically to undo the original' };
  }
  switch (entry.source) {
    case 'manual': return { automatic: false, text: 'Entered by hand on the Journal Entry screen' };
    case 'sale': return { automatic: true, text: 'Posted automatically when the sale was recorded' };
    case 'refund': return { automatic: true, text: 'Posted automatically when the refund was given' };
    case 'settlement': return { automatic: true, text: 'Posted automatically when the balance was paid' };
    case 'bill': return { automatic: true, text: 'Posted automatically when the expense or bill was logged' };
    case 'payroll': return { automatic: true, text: 'Posted automatically when the pay run was posted' };
    case 'opening': return { automatic: true, text: 'Posted when past history was brought into the books' };
    default: return { automatic: true, text: `Posted automatically (${entry.source})` };
  }
}

// ── the audit log, one row per event ────────────────────────────────────────

export type AuditEvent = {
  key: string;
  row: AuditRow;
  // Entry lines written with this entry, folded in rather than listed.
  lines: AuditRow[];
};

// A posting writes one journal_entries row and a journal_lines row per line,
// all in one transaction. Listing each line as its own "Created entry line"
// turned one sale into six rows of noise. Lines whose entry's own row is in
// the fetched window fold into it; a line whose entry fell outside the window
// stays visible on its own rather than vanishing.
export function groupAuditEvents(rows: AuditRow[]): AuditEvent[] {
  const entryInserts = new Map<string, AuditEvent>();
  const events: AuditEvent[] = [];
  for (const row of rows) {
    if (row.subjectTable === 'journal_entries' && row.action === 'insert') {
      const event = { key: row.id, row, lines: [] };
      entryInserts.set(row.subjectId, event);
    }
  }
  for (const row of rows) {
    if (row.subjectTable === 'journal_lines') {
      const entryId = String((row.after ?? row.before ?? {}).entry_id ?? '');
      const parent = entryInserts.get(entryId);
      if (parent && row.action === 'insert') {
        parent.lines.push(row);
        continue;
      }
    }
    if (row.subjectTable === 'journal_entries' && row.action === 'insert') {
      events.push(entryInserts.get(row.subjectId)!);
      continue;
    }
    events.push({ key: row.id, row, lines: [] });
  }
  return events;
}

const SUBJECT_LABELS: Record<string, string> = {
  journal_entries: 'journal entry',
  journal_lines: 'entry line',
  accounts: 'account',
  accounting_periods: 'period',
};

// The event's headline, naming the record rather than the table.
export function eventTitle(event: AuditEvent): string {
  const { row } = event;
  const after = row.after ?? {};
  const before = row.before ?? {};
  const ref = typeof after.reference === 'string' ? after.reference : typeof before.reference === 'string' ? before.reference : null;

  if (row.subjectTable === 'journal_entries') {
    if (row.action === 'insert') return `Posted ${ref ?? 'a journal entry'}`;
    if (before.status !== after.status && after.status === 'reversed') return `Reversed ${ref ?? 'a journal entry'}`;
    if (row.action === 'delete') return `Deleted ${ref ?? 'a journal entry'}`;
    return `Changed ${ref ?? 'a journal entry'}`;
  }
  if (row.subjectTable === 'accounts') {
    const label = `${after.code ?? before.code ?? ''} ${after.name ?? before.name ?? ''}`.trim();
    if (row.action === 'insert') return `Added account ${label}`;
    if (!before.archived_at && after.archived_at) return `Archived account ${label}`;
    return row.action === 'delete' ? `Deleted account ${label}` : `Changed account ${label}`;
  }
  if (row.subjectTable === 'accounting_periods') {
    const month = periodLabel(String(after.starts_on ?? before.starts_on ?? ''));
    if (row.action === 'insert') return `Opened ${month}`;
    if (before.status !== after.status) return `${capitalise(String(after.status ?? 'changed'))} ${month}`;
    return `Changed ${month}`;
  }
  const verb = row.action === 'insert' ? 'Created' : row.action === 'update' ? 'Changed' : 'Deleted';
  return `${verb} ${SUBJECT_LABELS[row.subjectTable] ?? row.subjectTable}`;
}

// The smaller line under the headline.
export function eventMeta(event: AuditEvent): string | undefined {
  const after = event.row.after ?? {};
  if (event.row.subjectTable === 'journal_entries' && event.row.action === 'insert') {
    const debits = event.lines.reduce((sum, l) => sum + Math.max(0, Number((l.after ?? {}).amount_cents ?? 0)), 0);
    const parts = [capitalise(String(after.source ?? 'entry'))];
    if (event.lines.length > 0) parts.push(`${event.lines.length} line${event.lines.length === 1 ? '' : 's'}`, formatCents(debits));
    return parts.join(' · ');
  }
  if (event.row.subjectTable === 'accounts' && typeof after.type === 'string') return `Account · ${after.type.replace('_', ' ')}`;
  if (event.row.subjectTable === 'journal_lines') {
    const cents = Number((event.row.after ?? event.row.before ?? {}).amount_cents ?? 0);
    return `${cents >= 0 ? 'Debit' : 'Credit'} ${formatCents(Math.abs(cents))}`;
  }
  return undefined;
}

export type FieldChange = { field: string; before: string | null; after: string | null };

// Fields that are ids, timestamps the row already shows, or plumbing.
const HIDDEN_FIELDS = new Set(['id', 'shop_id', 'period_id', 'created_at', 'updated_at', 'created_by', 'entry_id', 'account_id', 'location_id']);

// For an update, only what differs. For an insert or delete, what the record
// held -- the reader wants to see what was written or lost.
export function fieldChanges(row: AuditRow): FieldChange[] {
  const before = row.before ?? {};
  const after = row.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !HIDDEN_FIELDS.has(k));
  const show = (value: unknown): string | null =>
    value === null || value === undefined ? null : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return keys
    .map((field) => ({ field: fieldLabel(field), before: show(before[field]), after: show(after[field]) }))
    .filter((change) => row.action !== 'update' || change.before !== change.after);
}

function fieldLabel(field: string): string {
  if (field === 'reverses_entry_id') return 'Mirror entry';
  if (field === 'amount_cents') return 'Amount (cents)';
  return capitalise(field.replace(/_/g, ' '));
}

function periodLabel(startsOn: string): string {
  const match = startsOn.match(/^(\d{4})-(\d{2})/);
  if (!match) return 'a period';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
