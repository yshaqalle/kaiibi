import { useState } from 'react';
import { act, create } from 'react-test-renderer';

import { useTabRefresh, type TabRefresh } from '@/components/accounting/use-header-actions';

// The accounting shell owns the scroller; whichever tab is mounted owns the
// data. The tab publishes its `reload` upward so a pull on the shell refreshes
// that tab. These cover the two ways that plumbing can go wrong silently.

function Tab({ setRefresh, refresh }: { setRefresh: React.Dispatch<React.SetStateAction<TabRefresh | null>>; refresh: TabRefresh }) {
  useTabRefresh(setRefresh, refresh);
  return null;
}

/** Stands in for the shell: holds the published refresh and exposes it. */
function Shell({ refresh, showTab = true, onPublish }: { refresh: TabRefresh; showTab?: boolean; onPublish: (r: TabRefresh | null) => void }) {
  const [published, setPublished] = useState<TabRefresh | null>(null);
  onPublish(published);
  return showTab ? <Tab setRefresh={setPublished} refresh={refresh} /> : null;
}

describe('useTabRefresh', () => {
  it('stores the tab\'s reload rather than calling it', () => {
    const reload = jest.fn();
    let published: TabRefresh | null = null;
    act(() => {
      create(<Shell refresh={reload} onPublish={(r) => { published = r; }} />);
    });
    // The bug this guards: `setRefresh(reload)` makes React treat the function
    // as a state UPDATER and invoke it, firing a fetch on every tab switch.
    expect(reload).not.toHaveBeenCalled();
    expect(typeof published).toBe('function');
  });

  it('publishes the same function the shell can then call', () => {
    const reload = jest.fn();
    let published: TabRefresh | null = null;
    act(() => {
      create(<Shell refresh={reload} onPublish={(r) => { published = r; }} />);
    });
    act(() => {
      (published as unknown as TabRefresh)();
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('clears on unmount, so the shell never pulls against a tab that has gone', () => {
    const reload = jest.fn();
    let published: TabRefresh | null = null;
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(<Shell refresh={reload} onPublish={(r) => { published = r; }} />);
    });
    expect(published).not.toBeNull();
    act(() => {
      tree!.update(<Shell refresh={reload} showTab={false} onPublish={(r) => { published = r; }} />);
    });
    expect(published).toBeNull();
  });
});
