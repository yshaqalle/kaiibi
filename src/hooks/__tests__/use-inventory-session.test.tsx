import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { resetInventorySession, useInventorySessionField } from '@/hooks/use-inventory-session';

// One mount of the screen, reduced to the field under test. Unmounting and
// creating a new one is exactly what `<Slot />` does on a tab switch, and what
// crossing the web width breakpoint does when the shell swaps trees.
function mountField<K extends 'search' | 'unknownCode'>(key: K) {
  let latest: ReturnType<typeof useInventorySessionField<K>> | undefined;
  function Probe() {
    latest = useInventorySessionField(key);
    return <Text>probe</Text>;
  }
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(<Probe />); });
  return {
    value: () => latest![0],
    set: (next: string) => act(() => { (latest![1] as (v: string) => void)(next); }),
    unmount: () => act(() => { tree!.unmount(); }),
  };
}

beforeEach(() => resetInventorySession());

describe('useInventorySessionField', () => {
  it('starts empty', () => {
    expect(mountField('search').value()).toBe('');
  });

  // The reported bug: scan a code on a narrow window, widen it past the
  // breakpoint, and the box came back empty with the scanned product's result
  // bar gone with it.
  it('keeps a scanned code across a remount of the screen', () => {
    const first = mountField('search');
    first.set('8809447255972');
    first.unmount();

    expect(mountField('search').value()).toBe('8809447255972');
  });

  it('keeps the add-from-scan offer across the same remount', () => {
    const first = mountField('unknownCode');
    first.set('00808859');
    first.unmount();

    expect(mountField('unknownCode').value()).toBe('00808859');
  });

  // Clearing has to persist as hard as setting does, or the box would refill
  // itself with the last code every time the screen came back.
  it('keeps the box empty once it has been cleared', () => {
    const first = mountField('search');
    first.set('8809447255972');
    first.set('');
    first.unmount();

    expect(mountField('search').value()).toBe('');
  });

  it('updates the live component as well as the store', () => {
    const field = mountField('search');
    field.set('shea');
    expect(field.value()).toBe('shea');
  });

  it('keeps the two fields apart', () => {
    const search = mountField('search');
    const unknown = mountField('unknownCode');
    search.set('8809447255972');
    expect(unknown.value()).toBeNull();
  });
});
