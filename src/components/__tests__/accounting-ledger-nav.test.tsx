import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { backfillFooter, LEDGER_VIEWS, visibleLedgerViews, type LedgerView } from '@/components/accounting/ledger/ledger-hub';
import type { Permission } from '@/lib/permissions';

/** A `can` that grants exactly the permissions named. */
const holding = (...granted: Permission[]) => (permission: Permission) => granted.includes(permission);

describe('the ledger hub catalogue', () => {
  it('lists exactly the twelve views the shell can route to', () => {
    // In hub order, which is also the order the groups render in: the ledger
    // and its journals, then the three statements they add up to, then
    // oversight. The three statements sit between Post History and the Audit
    // Log rather than at the end, so that 'Financial statements' is a group
    // between the other two rather than after them.
    //
    // Close a Period joins Oversight, ahead of the Audit Log: closing is
    // control of the books rather than a way of writing to them, and every
    // close and re-open lands in the log next door.
    //
    // Fixed Assets sits between the statements and Oversight, in a group of its
    // own: what the shop OWNS is not a way of writing to the books and not
    // control of them, it is a thing the books describe.
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
      'assets',
      'close',
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
    // So does Close a Period: a close posts a journal entry that zeroes every
    // P&L account into 3900 Retained Earnings. So does Fixed Assets: recording
    // equipment posts Dr the 15xx account / Cr the money.
    expect(LEDGER_VIEWS.filter((v) => v.creates).map((v) => v.key)).toEqual([
      'entry',
      'backfill',
      'assets',
      'close',
    ]);
  });

  it('starts a creating action with a plus and a reading action without one', () => {
    for (const view of LEDGER_VIEWS) {
      if (view.group === null) continue;
      expect(view.action.startsWith('+')).toBe(view.creates);
    }
  });

  it('gives every catalogued view a branch in the shell that actually renders it', () => {
    // The first test in this file says the catalogue "lists exactly the twelve
    // views the shell can route to" -- and nothing checked that the shell can.
    // Measured: deleting the `view === 'assets'` branch from accounting.tsx
    // left the whole suite green. The card would still appear on the hub, the
    // crumb would still say Fixed Assets, and the body below it would be empty.
    //
    // Read off the SOURCE rather than by rendering the tab twelve times: the
    // shell needs a shop, a session, a date range and a permission set per
    // view, and a test that expensive is one that gets skipped. What can go
    // wrong here is a key added to the catalogue and not to the shell, and the
    // source says whether it was.
    const shell = readFileSync(
      join(__dirname, '..', '..', 'app', '(admin)', '(tabs)', 'accounting.tsx'),
      'utf8'
    );
    // Guard the guard: if the shell ever stops matching this shape, every
    // assertion below would pass vacuously.
    expect(shell).toContain("view === 'trial'");
    for (const view of LEDGER_VIEWS) {
      // The hub is what the shell falls back to, not a branch of its own.
      if (view.key === 'hub') continue;
      expect(shell).toContain(`view === '${view.key}'`);
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

  it('hides only that card, leaving the rest of its group intact', () => {
    // A gate that took the group with it would strip Chart of Accounts, the
    // journals and the trial balance from every reader who is not an owner.
    // Close a Period is absent for the same reason Post History is -- it is
    // gated on ledger.close too -- while the Audit Log keeps Oversight standing.
    expect(visibleLedgerViews(holding('ledger.view')).map((v) => v.key)).toEqual([
      'hub',
      'accounts',
      'entry',
      'journals',
      'trial',
      'income',
      'balance',
      'cashflow',
      'assets',
      'audit',
    ]);
  });

  it('names ledger.close on the card itself, so the gate and the RPC cannot drift apart', () => {
    expect(LEDGER_VIEWS.find((v) => v.key === 'backfill')?.requires).toBe('ledger.close');
  });
});

describe('Close a Period is gated on ledger.close, not on the ledger.view it reads with', () => {
  // The screen reads through list_accounting_periods(), which gates on
  // ledger.view -- but every ACTION on it (close, close anyway, re-open) runs
  // close_accounting_period() or reopen_accounting_period(), and both raise
  // without ledger.close.
  //
  // So ledger.view is the wrong gate, and the counter-example is not a corner
  // case: migration 20260904000000 gives the SEEDED MANAGER ledger.view and not
  // ledger.close. Gated on ledger.view, every shop's second role would be
  // offered a screen whose every button refuses.
  it('shows the card to a user holding ledger.close', () => {
    expect(visibleLedgerViews(holding('ledger.close')).map((v) => v.key)).toContain('close');
  });

  it('hides it from the seeded Manager, who holds ledger.view and cannot close', () => {
    // The exact permission set migration 20260904000000 seeds for the Manager
    // role. It holds ledger.view -- so a gate on ledger.view would show them
    // this card -- and it does not hold ledger.close.
    const SEEDED_MANAGER: Permission[] = [
      'pos.access', 'inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer',
      'sales.view', 'sales.edit', 'customers.view', 'customers.edit', 'dashboard.view',
      'expenses.view', 'expenses.manage', 'invoices.view', 'invoices.manage',
      'budgets.manage', 'registers.manage', 'discounts.apply', 'discounts.manual',
      'ledger.view',
    ];
    expect(visibleLedgerViews(holding(...SEEDED_MANAGER)).map((v) => v.key)).not.toContain('close');
  });

  it('hides it from a bookkeeper who may post entries but not close a month', () => {
    // The near miss. ledger.post writes one entry; ledger.close shuts a month
    // and re-opens it, and close_accounting_period says so at its own door.
    expect(visibleLedgerViews(holding('ledger.view', 'ledger.post')).map((v) => v.key)).not.toContain('close');
  });

  it('leaves Oversight standing when the card goes, because the Audit Log is ungated', () => {
    const groups = new Set(visibleLedgerViews(holding('ledger.view')).map((v) => v.group));
    expect(groups.has('Oversight')).toBe(true);
  });

  it('names ledger.close on the card, so the gate and the two RPCs cannot drift apart', () => {
    expect(LEDGER_VIEWS.find((v) => v.key === 'close')?.requires).toBe('ledger.close');
  });

  it('does not promise the shell date range it ignores', () => {
    // The screen lists every period a shop has, newest first, and never reads
    // the picker. A card that named a window would be believed.
    expect(LEDGER_VIEWS.find((v) => v.key === 'close')?.scope).toBe('Every month');
  });
});

describe('the three statements are gated on ledger.view', () => {
  // THE DEFAULT MANAGER, ON DAY ONE, IN EVERY SHOP. /accounting is gated on
  // `sales.view` (permissions.ts) and the seeded Manager role (0020) holds
  // sales.view and NOT ledger.view -- so this is the second role every shop
  // starts with, not a corner case.
  //
  // statement_lines(), balance_sheet() and cash_flow() are all `security
  // definer` and RAISE P0001 without ledger.view. That is what separates the
  // three statements from the six older cards, which read tables under RLS and
  // answer a reader without the permission with an honest empty state. A card
  // that opens a screen saying "you do not have permission" is worse than a
  // card that is not offered.
  const MANAGER: Permission[] = ['pos.access', 'inventory.view', 'inventory.edit', 'sales.view', 'sales.edit', 'dashboard.view'];

  it('shows all three to a reader holding ledger.view', () => {
    const keys = visibleLedgerViews(holding('ledger.view')).map((v) => v.key);
    expect(keys).toEqual(expect.arrayContaining(['income', 'balance', 'cashflow']));
  });

  it('hides all three from the seeded Manager role', () => {
    const keys = visibleLedgerViews(holding(...MANAGER)).map((v) => v.key);
    expect(keys).not.toContain('income');
    expect(keys).not.toContain('balance');
    expect(keys).not.toContain('cashflow');
  });

  it('takes the whole Financial statements group with them rather than leaving an empty heading', () => {
    const groups = new Set(visibleLedgerViews(holding(...MANAGER)).map((v) => v.group));
    expect(groups.has('Financial statements')).toBe(false);
    // ...and leaves the other two groups standing, so the hub is not emptied.
    expect(groups.has('Ledger and journals')).toBe(true);
    expect(groups.has('Oversight')).toBe(true);
  });

  it('names ledger.view on each card, so the gate and the three RPCs cannot drift apart', () => {
    for (const key of ['income', 'balance', 'cashflow']) {
      expect(LEDGER_VIEWS.find((v) => v.key === key)?.requires).toBe('ledger.view');
    }
  });

  it('gates exactly the six cards whose RPC raises, and no others', () => {
    // The six ungated cards read TABLES under RLS: a reader without the
    // permission gets no rows and an empty state, not an exception. Gating
    // those too would be a different decision and is not this one.
    //
    // Fixed Assets belongs to the RAISING family: list_fixed_assets() and
    // fixed_asset_summary() are security definer and raise P0001 without
    // ledger.view, exactly as the three statements do. Its WRITE doors need
    // ledger.post, and the screen says so itself rather than the card hiding
    // from a bookkeeper who may legitimately read the register.
    expect(LEDGER_VIEWS.filter((v) => v.requires !== null).map((v) => v.key)).toEqual([
      'backfill',
      'income',
      'balance',
      'cashflow',
      'assets',
      'close',
    ]);
  });
});

describe('the hub cards say what window their screen actually uses', () => {
  // A scope is not decoration: a reader who believes "7 days" will misread a
  // report they have set to 30. Seven days is only the range selector's OPENING
  // preset -- it also offers 30 and a custom pair -- and all three statement
  // screens follow whatever is chosen.
  it('does not promise a fixed window for the two statements that follow the range', () => {
    for (const key of ['income', 'cashflow']) {
      expect(LEDGER_VIEWS.find((v) => v.key === key)?.scope).toBe('The chosen range');
    }
  });

  it('says the balance sheet is as at the range END, which is not always today', () => {
    // A position read at an instant, and the instant is the window's end: a
    // custom range ending last month gives last month's balance sheet. The card
    // said "As of today", which was true only of the default preset.
    expect(LEDGER_VIEWS.find((v) => v.key === 'balance')?.scope).toBe('As at the range end');
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
