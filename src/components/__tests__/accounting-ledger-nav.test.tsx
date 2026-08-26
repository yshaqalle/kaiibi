import { backfillFooter, LEDGER_VIEWS, visibleLedgerViews, type LedgerView } from '@/components/accounting/ledger/ledger-hub';
import type { Permission } from '@/lib/permissions';

/** A `can` that grants exactly the permissions named. */
const holding = (...granted: Permission[]) => (permission: Permission) => granted.includes(permission);

describe('the ledger hub catalogue', () => {
  it('lists exactly the ten views the shell can route to', () => {
    // In hub order, which is also the order the groups render in: the ledger
    // and its journals, then the three statements they add up to, then
    // oversight. The three statements sit between Post History and the Audit
    // Log rather than at the end, so that 'Financial statements' is a group
    // between the other two rather than after them.
    expect(LEDGER_VIEWS.map((v) => v.key)).toEqual([
      'hub',
      'accounts',
      'entry',
      'journals',
      'trial',
      'backfill',
      'income',
      'balance',
      'cashflow',
      'audit',
    ]);
  });

  it('gives every non-hub view a group, so none can be added without a home on the hub', () => {
    for (const view of LEDGER_VIEWS) {
      if (view.key === 'hub') continue;
      expect(view.group).toBeTruthy();
    }
  });

  it('gives every view a label and a blurb, because the shell renders both in the title row', () => {
    for (const view of LEDGER_VIEWS) {
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.blurb.length).toBeGreaterThan(0);
    }
  });

  it('gives every card on the hub a scope and an action, because the footer renders both', () => {
    for (const view of LEDGER_VIEWS) {
      // The hub is not one of its own cards -- it has no group, so no footer.
      if (view.group === null) continue;
      expect(view.scope.length).toBeGreaterThan(0);
      expect(view.action.length).toBeGreaterThan(0);
      expect(view.icon.length).toBeGreaterThan(0);
    }
  });

  it('marks exactly the views that create something, so only those get the filled button', () => {
    // The distinction the footer's two button styles rest on. Reading a report
    // and writing to the ledger should not look like the same act.
    // Post History joins it: replaying a shop's history writes to the books.
    expect(LEDGER_VIEWS.filter((v) => v.creates).map((v) => v.key)).toEqual(['entry', 'backfill']);
  });

  it('starts a creating action with a plus and a reading action without one', () => {
    for (const view of LEDGER_VIEWS) {
      if (view.group === null) continue;
      expect(view.action.startsWith('+')).toBe(view.creates);
    }
  });

  it('resolves an unknown view back to the hub rather than rendering nothing', () => {
    const resolve = (raw: string | undefined): LedgerView =>
      LEDGER_VIEWS.some((v) => v.key === raw) ? (raw as LedgerView) : 'hub';
    expect(resolve('trial')).toBe('trial');
    expect(resolve('backfill')).toBe('backfill');
    expect(resolve('nonsense')).toBe('hub');
    expect(resolve(undefined)).toBe('hub');
  });
});

describe('Post History is gated on ledger.close', () => {
  // backfill_shop_ledger refuses anyone without ledger.close, in its own first
  // ten lines: replaying a whole history is heavier than posting one entry.
  // A card that offers a button which raises is worse than no card.
  it('shows the card to a user holding ledger.close', () => {
    expect(visibleLedgerViews(holding('ledger.close')).map((v) => v.key)).toContain('backfill');
  });

  it('hides it from a user who holds ledger.post but not ledger.close', () => {
    // The near miss, and the one an implementation is most likely to get wrong:
    // a bookkeeper who may write manual entries still may not rewrite history.
    expect(visibleLedgerViews(holding('ledger.post')).map((v) => v.key)).not.toContain('backfill');
  });

  it('hides it from a user holding nothing at all', () => {
    expect(visibleLedgerViews(holding()).map((v) => v.key)).not.toContain('backfill');
  });

  it('hides only that card, leaving the rest of the hub intact', () => {
    // A gate that took the group with it would strip Chart of Accounts, the
    // journals and the trial balance from every reader who is not an owner.
    expect(visibleLedgerViews(holding()).map((v) => v.key)).toEqual([
      'hub',
      'accounts',
      'entry',
      'journals',
      'trial',
      'income',
      'balance',
      'cashflow',
      'audit',
    ]);
  });

  it('names ledger.close on the card itself, so the gate and the RPC cannot drift apart', () => {
    expect(LEDGER_VIEWS.find((v) => v.key === 'backfill')?.requires).toBe('ledger.close');
  });

  it('leaves every other card ungated', () => {
    expect(LEDGER_VIEWS.filter((v) => v.requires !== null).map((v) => v.key)).toEqual(['backfill']);
  });
});

describe("Post History's footer", () => {
  it('falls back to the static scope while the count is unknown', () => {
    // Never a guessed "Nothing unposted": a shop with two years outside its
    // books would read that as "nothing to do" and close the card.
    expect(backfillFooter(null)).toEqual({ scope: 'Past trading', action: '+ Post history', creates: true });
  });

  it('states the count, and keeps the filled create button, when rows are waiting', () => {
    const footer = backfillFooter(3973);
    expect(footer.scope).toBe('3,973 unposted');
    expect(footer.creates).toBe(true);
    expect(footer.action.startsWith('+')).toBe(true);
  });

  it('goes quiet and drops the plus when there is nothing to post', () => {
    // The common case after the first run. Opening it then creates nothing, so
    // it must not look like it does.
    const footer = backfillFooter(0);
    expect(footer).toEqual({ scope: 'Nothing unposted', action: 'Check', creates: false });
    expect(footer.action.startsWith('+')).toBe(false);
  });
});
