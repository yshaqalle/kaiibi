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

import { STALE_AFTER_MS, useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';

// The hook reads the wall clock to decide whether data has gone stale, so the
// tests own the clock rather than sleeping through a real minute.
let now = 1_000_000;
const advance = (ms: number) => {
  now += ms;
};

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
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  jest.restoreAllMocks();
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

  it('refetches when the user comes back after the data has gone stale', () => {
    const refresh = jest.fn();
    mount(refresh);
    focus(); // mount
    advance(STALE_AFTER_MS);
    focus(); // navigated away and back, a minute later
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // The reason the window exists: tab switching is constant at a counter, and
  // refetching on each one put 20 queries on the wire every time someone
  // glanced at the Dashboard.
  it('does NOT refetch when the user flicks back within the window', () => {
    const refresh = jest.fn();
    mount(refresh);
    focus();
    advance(STALE_AFTER_MS - 1);
    focus();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refetches once per window, not once per return', () => {
    const refresh = jest.fn();
    mount(refresh);
    focus();
    advance(STALE_AFTER_MS);
    focus(); // stale -> refetch
    focus(); // straight back again -> too soon
    advance(1_000);
    focus(); // still inside the new window
    expect(refresh).toHaveBeenCalledTimes(1);
    advance(STALE_AFTER_MS);
    focus();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('calls the latest refresh, not the one captured at mount', () => {
    const first = jest.fn();
    const second = jest.fn();
    const tree = mount(first);
    focus(); // mount
    act(() => {
      tree.update(<Probe refresh={second} />);
    });
    advance(STALE_AFTER_MS);
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
