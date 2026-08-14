import { boughtWithin, countRecipients, hasRecipientsLeftToActOn, reachableRecipientCount, recipientsProcessed } from '@/lib/campaign-metrics';
import type { CampaignRecipient, Customer, RecipientState } from '@/types/models';


function r(state: RecipientState, overrides: Partial<CampaignRecipient> = {}): CampaignRecipient {
  return {
    id: Math.random().toString(36), campaignId: 'k1', customerId: 'c1',
    state, openedAt: null, sentAt: null, ...overrides,
  };
}

function customer(id: string, overrides: Partial<Customer> = {}): Customer {
  return {
    id, shopId: 's1', firstName: 'Hodan', lastName: 'Ali', email: null,
    phone: '063 771 4402', street: null, city: null, neighborhood: null,
    tags: [], notes: null, pointsBalance: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Customer;
}

describe('countRecipients', () => {
  it('counts each state separately', () => {
    const counts = countRecipients([
      r('sent'), r('sent'), r('opened'), r('waiting'), r('skipped'), r('unreachable'),
    ]);
    expect(counts).toEqual({ audience: 6, markedSent: 2, opened: 1, skipped: 1, unreachable: 1 });
  });

  it('does not count an opened chat as sent — that is the whole point', () => {
    const counts = countRecipients([r('opened'), r('opened')]);
    expect(counts.markedSent).toBe(0);
    expect(counts.opened).toBe(2);
  });

  it('handles an empty campaign', () => {
    expect(countRecipients([])).toEqual({ audience: 0, markedSent: 0, opened: 0, skipped: 0, unreachable: 0 });
  });
});

describe('recipientsProcessed', () => {
  it('counts marked-sent, opened, skipped and explicitly-unreachable as worked through', () => {
    const recipients = [r('sent'), r('opened'), r('skipped'), r('unreachable'), r('waiting')];
    expect(recipientsProcessed(recipients)).toBe(4);
  });

  it('is zero for an untouched queue', () => {
    expect(recipientsProcessed([r('waiting'), r('waiting')])).toBe(0);
  });
});

describe('reachableRecipientCount', () => {
  it('counts only rows whose customer WhatsApp can reach', () => {
    const customersById = new Map([
      ['a', customer('a', { phone: '063 771 4402' })],
      ['b', customer('b', { phone: null })],
    ]);
    const recipients = [r('waiting', { customerId: 'a' }), r('waiting', { customerId: 'b' })];
    expect(reachableRecipientCount(recipients, customersById)).toBe(1);
  });

  it('is a durable count, not a live re-match -- a row stays counted after the customer no longer matches whatever filter added them', () => {
    // The exact "Sending 10 of 6" bug: the row is still there and the
    // customer is still reachable, so this must not shrink just because a
    // win-back customer bought again and dropped out of the audience filter.
    const customersById = new Map([['a', customer('a')]]);
    const recipients = [r('sent', { customerId: 'a' })];
    expect(reachableRecipientCount(recipients, customersById)).toBe(1);
  });

  it('is zero when the customer row is missing entirely', () => {
    expect(reachableRecipientCount([r('waiting', { customerId: 'ghost' })], new Map())).toBe(0);
  });
});

describe('hasRecipientsLeftToActOn', () => {
  it('is true for a reachable waiting recipient', () => {
    const customersById = new Map([['a', customer('a')]]);
    expect(hasRecipientsLeftToActOn([r('waiting', { customerId: 'a' })], customersById)).toBe(true);
  });

  it('is false for a waiting recipient with no usable number -- they can never become current', () => {
    const customersById = new Map([['a', customer('a', { phone: null })]]);
    expect(hasRecipientsLeftToActOn([r('waiting', { customerId: 'a' })], customersById)).toBe(false);
  });

  it('is true for an opened recipient regardless of reachability -- an unanswered question is still work', () => {
    const customersById = new Map([['a', customer('a', { phone: null })]]);
    expect(hasRecipientsLeftToActOn([r('opened', { customerId: 'a' })], customersById)).toBe(true);
  });

  it('is false once everyone is sent, skipped or unreachable', () => {
    const customersById = new Map([
      ['a', customer('a')],
      ['b', customer('b')],
      ['c', customer('c')],
    ]);
    const recipients = [r('sent', { customerId: 'a' }), r('skipped', { customerId: 'b' }), r('unreachable', { customerId: 'c' })];
    expect(hasRecipientsLeftToActOn(recipients, customersById)).toBe(false);
  });

  it('is false for an empty campaign', () => {
    expect(hasRecipientsLeftToActOn([], new Map())).toBe(false);
  });
});

describe('boughtWithin', () => {
  it('counts a recipient who bought after being sent to, inside the window', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-08-10T10:00:00Z' })];
    const sales = new Map([['c1', ['2026-08-11T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7)).toBe(1);
  });

  it('does not count a sale that happened BEFORE the message', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-08-10T10:00:00Z' })];
    const sales = new Map([['c1', ['2026-08-01T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7)).toBe(0);
  });

  it('does not count a sale outside the window', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-07-01T10:00:00Z' })];
    const sales = new Map([['c1', ['2026-07-20T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7)).toBe(0);
  });

  it('counts a customer once however many times they bought', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-08-10T10:00:00Z' })];
    const sales = new Map([['c1', ['2026-08-11T10:00:00Z', '2026-08-12T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7)).toBe(1);
  });

  it('ignores a recipient who was never marked sent', () => {
    // Nothing was claimed to have reached them, so a sale proves nothing here.
    const recipients = [r('opened', { customerId: 'c1', sentAt: null })];
    const sales = new Map([['c1', ['2026-08-11T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7)).toBe(0);
  });

  it('ignores a customer with no sales at all', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-08-10T10:00:00Z' })];
    expect(boughtWithin(recipients, new Map(), 7)).toBe(0);
  });
});
