import type { AuditRow } from '@/lib/ledger';
import {
  detailLines,
  eventMeta,
  eventTitle,
  fieldChanges,
  groupAuditEvents,
  plainWords,
  postingHow,
  readableDescription,
  referencedIds,
} from '@/lib/ledger-detail';
import type { Account, JournalEntry } from '@/types/models';

const SALE_ID = '6669e945-7521-4f64-8875-d297cb7bce85';

function account(id: string, code: string, name: string, type: Account['type'], isContra = false): Account {
  return { id, shopId: 's', code, name, type, isContra, archivedAt: null };
}

const ACCOUNTS = new Map(
  [
    account('ar', '1100', 'Accounts Receivable', 'asset'),
    account('cash', '1000', 'Cash on Hand', 'asset'),
    account('inv', '1200', 'Inventory', 'asset'),
    account('tax', '2100', 'Sales Tax Payable', 'liability'),
    account('rev', '4000', 'Sales Revenue', 'revenue'),
    account('ret', '4100', 'Sales Returns', 'revenue', true),
    account('cogs', '5000', 'Cost of Goods Sold', 'cost_of_sales'),
    account('rent', '6000', 'Rent', 'expense'),
  ].map((a) => [a.id, a])
);

// JE-2026-0063 as it sits in the database: $2.05 left on account.
const SALE_ENTRY: JournalEntry = {
  id: 'e63', shopId: 's', entryDate: '2026-09-05', reference: 'JE-2026-0063', description: `Sale ${SALE_ID}`,
  source: 'sale', status: 'posted', locationId: null, reversesEntryId: null, createdAt: '2026-09-05T20:51:11Z',
  lines: [
    { id: 'l1', accountId: 'ar', amountCents: 205, locationId: null, memo: 'Left on account' },
    { id: 'l2', accountId: 'rev', amountCents: -200, locationId: null, memo: 'Sale at list' },
    { id: 'l3', accountId: 'tax', amountCents: -5, locationId: null, memo: 'Sales tax' },
    { id: 'l4', accountId: 'cogs', amountCents: 200, locationId: null, memo: 'Cost of goods sold' },
    { id: 'l5', accountId: 'inv', amountCents: -200, locationId: null, memo: 'Stock sold' },
  ],
};

describe('readableDescription', () => {
  const names = { sales: new Map([[SALE_ID, 'QA Amina Hersi']]), expenses: new Map<string, string>() };

  it('names the sale instead of printing its id', () => {
    expect(readableDescription(`Sale ${SALE_ID}`, names)).toBe('Sale · QA Amina Hersi');
  });

  it('shortens an id it cannot resolve, keeping the words around it', () => {
    expect(readableDescription('Reversal of JE-2026-0078 — sale a5187370-9c1c-4c13-94da-c88e7af61a85 was deleted', names))
      .toBe('Reversal of JE-2026-0078 — sale a5187370 was deleted');
  });

  it('finds the sale ids a description points at', () => {
    expect(referencedIds(`Delivery on order #2 (sale ${SALE_ID})`, 'sale')).toEqual([SALE_ID]);
  });
});

describe('detailLines', () => {
  it('splits signed amounts into debit and credit columns that balance', () => {
    const { lines, debitCents, creditCents } = detailLines(SALE_ENTRY, ACCOUNTS);
    expect(lines[0]).toMatchObject({ code: '1100', accountName: 'Accounts Receivable', debitCents: 205, creditCents: 0 });
    expect(lines[1]).toMatchObject({ code: '4000', debitCents: 0, creditCents: 200 });
    expect(debitCents).toBe(405);
    expect(creditCents).toBe(405);
  });
});

describe('plainWords', () => {
  it('reads a credit sale the way a shopkeeper would say it', () => {
    expect(plainWords(SALE_ENTRY, ACCOUNTS)).toEqual([
      'A customer now owes you $2.05 more.',
      'You earned $2.00 of Sales Revenue.',
      '$0.05 is tax you hold for the government.',
      '$2.00 became Cost of Goods Sold.',
      '$2.00 of stock left the shelf.',
    ]);
  });

  it('reads a contra revenue account the other way round', () => {
    const refund = { ...SALE_ENTRY, lines: [
      { id: 'a', accountId: 'ret', amountCents: 500, locationId: null, memo: null },
      { id: 'b', accountId: 'cash', amountCents: -500, locationId: null, memo: null },
    ] };
    expect(plainWords(refund, ACCOUNTS)).toEqual(['$5.00 came off your sales as Sales Returns.', '$5.00 went out of Cash on Hand.']);
  });

  it('nets two lines on one account into one sentence', () => {
    const entry = { ...SALE_ENTRY, lines: [
      { id: 'a', accountId: 'rent', amountCents: 300, locationId: null, memo: null },
      { id: 'b', accountId: 'rent', amountCents: 200, locationId: null, memo: null },
      { id: 'c', accountId: 'cash', amountCents: -500, locationId: null, memo: null },
    ] };
    expect(plainWords(entry, ACCOUNTS)).toEqual(['$5.00 was spent on Rent.', '$5.00 went out of Cash on Hand.']);
  });
});

describe('postingHow', () => {
  it('tells a hand entry from an automatic one', () => {
    expect(postingHow(SALE_ENTRY)).toEqual({ automatic: true, text: 'Posted automatically when the sale was recorded' });
    expect(postingHow({ ...SALE_ENTRY, source: 'manual' }).automatic).toBe(false);
  });

  it('says a reversal came from a deletion', () => {
    expect(postingHow({ ...SALE_ENTRY, reference: 'JE-2026-0078R', description: 'Reversal of JE-2026-0078 — sale x was deleted' }).text)
      .toBe('Written automatically when the source was deleted');
  });
});

function audit(overrides: Partial<AuditRow>): AuditRow {
  return { id: 'a', actorId: 'u1', action: 'insert', subjectTable: 'journal_entries', subjectId: 'e63', before: null, after: null, createdAt: '2026-09-05T20:51:11Z', ...overrides };
}

describe('groupAuditEvents', () => {
  const entryRow = audit({ id: 'r0', after: { reference: 'JE-2026-0063', source: 'sale', status: 'posted' } });
  const lineRows = [205, -200, -5].map((amount, i) =>
    audit({ id: `r${i + 1}`, subjectTable: 'journal_lines', subjectId: `l${i}`, after: { entry_id: 'e63', amount_cents: amount } })
  );

  it('folds a posting and its lines into one event', () => {
    const events = groupAuditEvents([...lineRows, entryRow]);
    expect(events).toHaveLength(1);
    expect(events[0].lines).toHaveLength(3);
    expect(eventTitle(events[0])).toBe('Posted JE-2026-0063');
    expect(eventMeta(events[0])).toBe('Sale · 3 lines · $2.05');
  });

  it('keeps a line visible when its entry fell outside the window', () => {
    const events = groupAuditEvents(lineRows.slice(0, 1));
    expect(events).toHaveLength(1);
    expect(eventTitle(events[0])).toBe('Created entry line');
  });

  it('names a reversal and shows only the fields that changed', () => {
    const row = audit({
      action: 'update',
      before: { reference: 'JE-2026-0078', status: 'posted', reverses_entry_id: null },
      after: { reference: 'JE-2026-0078', status: 'reversed', reverses_entry_id: 'abc' },
    });
    const [event] = groupAuditEvents([row]);
    expect(eventTitle(event)).toBe('Reversed JE-2026-0078');
    expect(fieldChanges(row)).toEqual([
      { field: 'Status', before: 'posted', after: 'reversed' },
      { field: 'Mirror entry', before: null, after: 'abc' },
    ]);
  });
});
