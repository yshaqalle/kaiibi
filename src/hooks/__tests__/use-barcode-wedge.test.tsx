import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';

import { useBarcodeWedge, useWedgeSinkFallback } from '@/hooks/use-barcode-wedge';

// The native listener, captured on subscribe so a test can play a scanner into
// it. Same `mock` prefix rule as use-hardware-keyboard.test.tsx: a hoisted
// jest.mock factory may only close over names beginning with `mock`.
let mockKeyListeners: ((event: { key: string; at: number }) => void)[] = [];
let mockSupportsKeys = true;
let mockRemoved = 0;

jest.mock('../../../modules/hardware-keyboard', () => ({
  supportsHardwareKeyEvents: () => mockSupportsKeys,
  getHardwareKeyboardModule: () => ({
    isAttached: () => true,
    addListener: (_name: string, fn: (event: { key: string; at: number }) => void) => {
      mockKeyListeners.push(fn);
      return { remove: () => { mockRemoved += 1; } };
    },
  }),
}));

function Probe({ enabled, onScan }: { enabled: boolean; onScan: (code: string) => void }) {
  useBarcodeWedge({ enabled, onScan });
  return <Text>probe</Text>;
}

function mount(enabled = true) {
  const scans: string[] = [];
  act(() => { create(<Probe enabled={enabled} onScan={(c) => scans.push(c)} />); });
  return scans;
}

// A wedge scanner: characters milliseconds apart, then its terminator.
function scan(code: string, gapMs = 5) {
  let at = 1000;
  act(() => {
    for (const char of code) {
      mockKeyListeners.forEach((fn) => fn({ key: char, at }));
      at += gapMs;
    }
    mockKeyListeners.forEach((fn) => fn({ key: 'Enter', at }));
  });
}

describe('useBarcodeWedge on native', () => {
  beforeEach(() => {
    mockKeyListeners = [];
    mockSupportsKeys = true;
    mockRemoved = 0;
  });

  // The whole point of the module: a code arrives with NOTHING focused, which
  // is how a till is actually used and what the invisible sink existed to fake.
  it('reads a scan delivered with nothing focused', () => {
    const scans = mount();
    scan('8809447255972');
    expect(scans).toEqual(['8809447255972']);
  });

  // A field the user tapped owns its keys and resolves its own scans through
  // `stepFieldBurst`. That yield is the NATIVE half's job -- it reads the
  // focused view at the instant the key arrives and simply does not report
  // those keys -- so nothing reaches this hook to be yielded. Asking a second
  // time from JS is what made every scan vanish: RN's focus cache keeps a
  // field that unmounted while focused, so the answer was permanently yes.
  it('leaves text typed at human speed alone', () => {
    const scans = mount();
    scan('shea butter', 150);
    expect(scans).toEqual([]);
  });

  it('does not listen at all when the store has no scanner', () => {
    mount(false);
    expect(mockKeyListeners).toHaveLength(0);
  });

  it('does not listen on a binary that cannot report keys', () => {
    mockSupportsKeys = false;
    mount();
    expect(mockKeyListeners).toHaveLength(0);
  });
});

describe('useWedgeSinkFallback', () => {
  function probe() {
    let seen: boolean | undefined;
    function P() { seen = useWedgeSinkFallback(); return <Text>p</Text>; }
    act(() => { create(<P />); });
    return seen;
  }

  // The invisible field is the OLD way, and every problem it caused comes back
  // with it. It may only appear where the new way cannot work.
  it('is off when the binary reports keys', () => {
    mockSupportsKeys = true;
    expect(probe()).toBe(false);
  });

  it('is on for a binary built before key capture existed', () => {
    mockSupportsKeys = false;
    expect(probe()).toBe(true);
  });
});
