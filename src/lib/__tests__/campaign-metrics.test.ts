import { boughtWithin, countRecipients } from '@/lib/campaign-metrics';
import type { CampaignRecipient, RecipientState } from '@/types/models';

const NOW = Date.parse('2026-08-13T10:00:00Z');

function r(state: RecipientState, overrides: Partial<CampaignRecipient> = {}): CampaignRecipient {
  return {
    id: Math.random().toString(36), campaignId: 'k1', customerId: 'c1',
    state, openedAt: null, sentAt: null, ...overrides,
  };
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

describe('boughtWithin', () => {
  it('counts a recipient who bought after being sent to, inside the window', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-08-10T10:00:00Z' })];
    const sales = new Map([['c1', ['2026-08-11T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7, NOW)).toBe(1);
  });

  it('does not count a sale that happened BEFORE the message', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-08-10T10:00:00Z' })];
    const sales = new Map([['c1', ['2026-08-01T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7, NOW)).toBe(0);
  });

  it('does not count a sale outside the window', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-07-01T10:00:00Z' })];
    const sales = new Map([['c1', ['2026-07-20T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7, NOW)).toBe(0);
  });

  it('counts a customer once however many times they bought', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-08-10T10:00:00Z' })];
    const sales = new Map([['c1', ['2026-08-11T10:00:00Z', '2026-08-12T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7, NOW)).toBe(1);
  });

  it('ignores a recipient who was never marked sent', () => {
    // Nothing was claimed to have reached them, so a sale proves nothing here.
    const recipients = [r('opened', { customerId: 'c1', sentAt: null })];
    const sales = new Map([['c1', ['2026-08-11T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7, NOW)).toBe(0);
  });

  it('ignores a customer with no sales at all', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-08-10T10:00:00Z' })];
    expect(boughtWithin(recipients, new Map(), 7, NOW)).toBe(0);
  });
});
