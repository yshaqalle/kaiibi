import { useCallback, useState, type ReactNode } from 'react';
import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';

import { useHeaderActions } from '@/components/accounting/use-header-actions';

/**
 * The feedback loop this file exists to prevent.
 *
 * `useHeaderActions` publishes a tab's buttons into SHELL state. That is a
 * closed circuit: shell state changes -> shell re-renders -> the tab re-renders
 * -> if the tab's `deps` are new objects, the effect fires again -> shell state
 * changes. Nothing stops it, and React eventually gives up with "Maximum update
 * depth exceeded".
 *
 * So every caller MUST hand this hook dependencies that are stable across
 * renders. Cash & Budgets did not -- it passed two inline arrow functions
 * straight into its header component, so `[onNewBill, onMoveMoney]` were new on
 * every render and the circuit ran away. It was latent for a while: the loop
 * has to nest ~50 deep before React complains, and how deep it gets at mount
 * depends on how much else the shell is doing that render.
 *
 * The harness below is a miniature of the real shell/tab pair, with a hard cap
 * so a regression fails the test rather than hanging the suite.
 */
const CAP = 40;

function Harness({ stable, onPublish }: { stable: boolean; onPublish: () => void }) {
  const [actions, setActions] = useState<ReactNode>(null);
  return (
    <>
      {actions}
      <Tab stable={stable} setActions={setActions} onPublish={onPublish} />
    </>
  );
}

function Tab({
  stable,
  setActions,
  onPublish,
}: {
  stable: boolean;
  setActions: (node: ReactNode) => void;
  onPublish: () => void;
}) {
  const [, setBump] = useState(0);
  // The handler a real tab hands its header component. `useCallback` is the
  // whole difference between the two cases.
  const stableHandler = useCallback(() => setBump((n) => n + 1), []);
  const handler = stable ? stableHandler : () => setBump((n) => n + 1);
  return <Header handler={handler} setActions={setActions} onPublish={onPublish} />;
}

function Header({
  handler,
  setActions,
  onPublish,
}: {
  handler: () => void;
  setActions: (node: ReactNode) => void;
  onPublish: () => void;
}) {
  onPublish();
  useHeaderActions(setActions, <Text onPress={handler}>+ New bill</Text>, [handler]);
  return null;
}

describe('publishing a tab’s buttons into the shell', () => {
  it('settles after one publish when the handlers are stable', () => {
    let renders = 0;
    act(() => {
      create(
        <Harness
          stable
          onPublish={() => {
            renders++;
            if (renders > CAP) throw new Error(`runaway: header rendered ${renders} times`);
          }}
        />
      );
    });
    // One render, one publish, one re-render of the shell to show it. Well
    // under the cap, and crucially not growing.
    expect(renders).toBeLessThan(CAP);
  });

  it('runs away when a handler is rebuilt on every render — the Cash & Budgets bug', () => {
    let renders = 0;
    expect(() => {
      act(() => {
        create(
          <Harness
            stable={false}
            onPublish={() => {
              renders++;
              if (renders > CAP) throw new Error(`runaway: header rendered ${renders} times`);
            }}
          />
        );
      });
    }).toThrow(/runaway/);
  });
});
