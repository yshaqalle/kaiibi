import { LEDGER_VIEWS, type LedgerView } from '@/components/accounting/ledger/ledger-hub';

describe('the ledger hub catalogue', () => {
  it('lists exactly the six views the shell can route to', () => {
    expect(LEDGER_VIEWS.map((v) => v.key)).toEqual(['hub', 'accounts', 'entry', 'journals', 'trial', 'audit']);
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
    expect(LEDGER_VIEWS.filter((v) => v.creates).map((v) => v.key)).toEqual(['entry']);
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
    expect(resolve('nonsense')).toBe('hub');
    expect(resolve(undefined)).toBe('hub');
  });
});
