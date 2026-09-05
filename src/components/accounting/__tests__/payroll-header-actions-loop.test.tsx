import { useState, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';

import { PayrollTab } from '@/components/accounting/payroll-tab';

/**
 * Payroll's instance of the header-actions runaway.
 *
 * __tests__/header-actions-loop.test.tsx pins the CONTRACT -- publish into
 * shell state with an unstable dependency and the circuit never settles. This
 * file pins one CALLER actually obeying it, because the contract on its own did
 * not stop the same bug happening a second time.
 *
 * What happened: PayrollTab handed `onNew={openCreate}` to PayrollHeaderActions,
 * which puts it in useHeaderActions' dependency array. `openCreate` was a bare
 * `const openCreate = async () => …` declared BELOW the `if (!allowed)` early
 * return, so it was rebuilt on every render. Shell state changed, the shell
 * re-rendered, the tab re-rendered, the effect saw a new `onNew` and published
 * again -- "Maximum update depth exceeded".
 *
 * Note WHY it was unmemoised, because it is the interesting part: hooks cannot
 * follow a conditional return, so useCallback was illegal where the function
 * was written. Hoisting it above the early return is what made the memo
 * possible. A future edit that moves it back down will be forced to drop the
 * useCallback, and this test is what will notice.
 *
 * The harness is the real shell/tab pair reduced to the one thing that matters:
 * `headerActions` in the parent's state, exactly as accounting.tsx holds it.
 */

// `mock`-prefixed so babel-plugin-jest-hoist allows the factories below to
// close over them. ONE object per mock, never a fresh literal per call: a
// factory returning `{ shop: {...} }` each render would give every useCallback
// over `shop` a new identity and manufacture the very loop under test.
const mockAuth = { shop: { id: 'shop-1' }, can: () => true };

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => mockAuth }));
// useRefreshOnFocus reaches for expo-router's navigation object, which does not
// exist outside a NavigationContainer. Its behaviour has its own suite.
jest.mock('@/hooks/use-refresh-on-focus', () => ({ useRefreshOnFocus: () => {} }));
jest.mock('@/lib/payroll', () => ({
  listPayrollRuns: () => Promise.resolve([]),
  createPayrollRun: () => Promise.resolve(null),
  deletePayrollRun: () => Promise.resolve(),
  getPayrollRun: () => Promise.resolve(null),
  postPayrollRun: () => Promise.resolve(),
  unpostPayrollRun: () => Promise.resolve(),
  updatePayrollRunLine: () => Promise.resolve(),
}));
jest.mock('@/lib/staff', () => ({ listStaff: () => Promise.resolve([]) }));
jest.mock('@/lib/time-entries', () => ({ listShopTimeEntries: () => Promise.resolve([]) }));

// Well above a settled mount, far below the ~50 deep React needs before it
// complains -- so a regression fails this test rather than hanging the suite.
const CAP = 40;

function Shell({ onRender }: { onRender: () => void }) {
  // The shell's own state, which is what closes the circuit.
  const [headerActions, setHeaderActions] = useState<ReactNode>(null);
  const [, setRefresh] = useState<(() => Promise<void> | void) | null>(null);
  onRender();
  return (
    <>
      {headerActions}
      <PayrollTab
        dateRange={{ since: new Date(2026, 8, 1), until: new Date(2026, 8, 30) }}
        setHeaderActions={setHeaderActions}
        setRefresh={setRefresh}
      />
    </>
  );
}

describe('PayrollTab publishing its "+ New pay run" button', () => {
  it('settles instead of running away', async () => {
    let renders = 0;
    await act(async () => {
      create(
        <Shell
          onRender={() => {
            renders++;
            if (renders > CAP) throw new Error(`runaway: shell rendered ${renders} times`);
          }}
        />
      );
    });
    expect(renders).toBeLessThan(CAP);
  });
});
