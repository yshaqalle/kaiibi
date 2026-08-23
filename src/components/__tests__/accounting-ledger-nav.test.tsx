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

  it('resolves an unknown view back to the hub rather than rendering nothing', () => {
    const resolve = (raw: string | undefined): LedgerView =>
      LEDGER_VIEWS.some((v) => v.key === raw) ? (raw as LedgerView) : 'hub';
    expect(resolve('trial')).toBe('trial');
    expect(resolve('nonsense')).toBe('hub');
    expect(resolve(undefined)).toBe('hub');
  });
});
