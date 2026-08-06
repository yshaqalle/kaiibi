import { act, create } from 'react-test-renderer';

// Captures whatever callback the hook registers, so the test can drive focus
// events directly. The real `useFocusEffect` needs a navigation container and a
// mounted route to fire, none of which is the behaviour under test here: what
// matters is which focuses this hook acts on.
let registered: (() => void) | null = null;
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void) => {
    registered = cb;
  },
}));

import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';

function Probe({ refresh }: { refresh: () => void }) {
  useRefreshOnFocus(refresh);
  return null;
}

function mount(refresh: () => void) {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(<Probe refresh={refresh} />);
  });
  return tree!;
}

/** One focus event, as the navigator would deliver it. */
function focus() {
  act(() => {
    registered?.();
  });
}

beforeEach(() => {
  registered = null;
});

describe('useRefreshOnFocus', () => {
  it('does not refetch on the first focus, which is just the screen mounting', () => {
    const refresh = jest.fn();
    mount(refresh);
    focus();
    // The screen's own mount effect already fetched; firing here too would make
    // every cold open request everything twice.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refetches when the user comes back to the screen', () => {
    const refresh = jest.fn();
    mount(refresh);
    focus(); // mount
    focus(); // navigated away and back
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refetches on every subsequent return, not just the first', () => {
    const refresh = jest.fn();
    mount(refresh);
    focus();
    focus();
    focus();
    focus();
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('calls the latest refresh, not the one captured at mount', () => {
    const first = jest.fn();
    const second = jest.fn();
    const tree = mount(first);
    focus(); // mount
    act(() => {
      tree.update(<Probe refresh={second} />);
    });
    focus();
    // Reload callbacks are rebuilt whenever the date range or store filter
    // changes, so a stale closure here would refetch the wrong range.
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  // The identity has to CHANGE for this to prove anything. Reload callbacks are
  // `useCallback`s over the date range and store filter, so they are rebuilt
  // constantly; if the focus subscription depended on them it would tear down
  // and re-run on every one of those, which on an already-focused screen is an
  // endless refetch loop. Re-rendering with the same function would leave
  // `useCallback` returning the same callback either way and prove nothing.
  it('keeps one stable subscription even when refresh is rebuilt', () => {
    const tree = mount(jest.fn());
    focus();
    const afterMount = registered;
    act(() => {
      tree.update(<Probe refresh={jest.fn()} />);
    });
    expect(registered).toBe(afterMount);
  });
});
