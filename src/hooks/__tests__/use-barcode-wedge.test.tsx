import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';

import { useBarcodeWedge, useWedgeSinkFallback } from '@/hooks/use-barcode-wedge';

// The hook listens only while its screen is IN FRONT, and the real
// `useFocusEffect` needs a navigation container. Same stand-in as
// wedge-sink.test.tsx: the callback runs on mount, which is the screen being
// in front, and its cleanup is returned so unmounting still tears down.
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => undefined | (() => void)) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(() => cb(), [cb]);
  },
}));

// The native listener, captured on subscribe so a test can play a scanner into
// it. Same `mock` prefix rule as use-hardware-keyboard.test.tsx: a hoisted
// jest.mock factory may only close over names beginning with `mock`.
let mockKeyListeners: ((event: { key: string; at: number }) => void)[] = [];
// Attachment is its own event, because on iOS it is what makes key capture
// possible in the first place -- GameController connects lazily, so a scanner
// that has not fired yet reads as no keyboard at all.
let mockChangeListeners: ((event: { attached: boolean }) => void)[] = [];
let mockSupportsKeys = true;
let mockAttached = true;
let mockRemoved = 0;

jest.mock('../../../modules/hardware-keyboard', () => ({
  supportsHardwareKeyEvents: () => mockSupportsKeys,
  getHardwareKeyboardModule: () => ({
    isAttached: () => mockAttached,
    addListener: (name: string, fn: never) => {
      if (name === 'onChange') mockChangeListeners.push(fn);
      else mockKeyListeners.push(fn);
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

// A scanner with no suffix configured: the code, then silence.
function scanWithoutTerminator(code: string, gapMs = 5) {
  let at = 1000;
  act(() => {
    for (const char of code) {
      mockKeyListeners.forEach((fn) => fn({ key: char, at }));
      at += gapMs;
    }
  });
  act(() => { jest.advanceTimersByTime(400); });
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

  // Bluetooth scanners are often configured with no suffix, and a code that
  // waits for an Enter that never comes is a code the till never sees.
  it('reads a code from a scanner that sends no terminator', () => {
    jest.useFakeTimers();
    const scans = mount();
    scanWithoutTerminator('8809447255972');
    jest.useRealTimers();
    expect(scans).toEqual(['8809447255972']);
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
  beforeEach(() => {
    mockKeyListeners = [];
    mockChangeListeners = [];
    mockSupportsKeys = true;
    mockAttached = true;
  });

  function probe() {
    let seen: boolean | undefined;
    function P() { seen = useWedgeSinkFallback(); return <Text>p</Text>; }
    act(() => { create(<P />); });
    return () => seen;
  }

  // The invisible field is the OLD way, and every problem it caused comes back
  // with it. It may only appear where the new way cannot work.
  it('is off when the binary reports keys', () => {
    mockSupportsKeys = true;
    expect(probe()()).toBe(false);
  });

  it('is on for a binary built before key capture existed', () => {
    mockSupportsKeys = false;
    expect(probe()()).toBe(true);
  });

  // The iPhone-with-a-scanner-and-no-keyboard case, which is most tills.
  //
  // iOS answers "can this binary report keys?" with `GCKeyboard.coalesced !=
  // nil` -- capability and connection in one word -- and GameController connects
  // lazily. A Bluetooth scanner idle since launch is not there yet, so POS opened
  // believing it needed the sink, and the first scan (the very thing that
  // connects the keyboard) came too late to change an answer read once. The sink
  // then held the caret for the life of the screen, which is what pinned the
  // till's keyboard over the tab bar with no way to dismiss it.
  it('retires the sink when the scanner connects after the screen opened', () => {
    mockSupportsKeys = false;
    mockAttached = false;
    const seen = probe();
    expect(seen()).toBe(true);

    // The scanner's first trigger pull: GameController connects, and with it
    // key capture becomes possible.
    mockSupportsKeys = true;
    act(() => { mockChangeListeners.forEach((fn) => fn({ attached: true })); });
    expect(seen()).toBe(false);
  });

  // And back again if the scanner sleeps, which Bluetooth ones do. That is not
  // a regression to the old trap: the screens gate the sink on the scanner being
  // attached as well, so a disconnected till renders no sink either way -- and
  // whichever way it goes, the answer is the platform's current one rather than
  // a remembered one.
  it('follows the platform rather than remembering an answer', () => {
    mockSupportsKeys = false;
    mockAttached = false;
    const seen = probe();
    mockSupportsKeys = true;
    act(() => { mockChangeListeners.forEach((fn) => fn({ attached: true })); });
    expect(seen()).toBe(false);

    mockSupportsKeys = false;
    act(() => { mockChangeListeners.forEach((fn) => fn({ attached: false })); });
    expect(seen()).toBe(true);
  });
});
