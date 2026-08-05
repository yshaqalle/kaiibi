// Recognising a hardware barcode scanner from a stream of keystrokes.
//
// USB and Bluetooth scanners in the usual "HID" or "keyboard wedge" mode are
// not devices the app can open and read -- to the operating system they ARE a
// keyboard. They type the code and then press Enter. So there is nothing to
// connect to and no event to subscribe to: the only way to tell a scan from a
// person typing is HOW FAST the characters arrive.
//
// Kept as a pure state machine, separate from the hook that feeds it DOM
// events, so the timing rules can be tested with plain numbers instead of a
// synthetic-event harness this repo doesn't have.

export type WedgeConfig = {
  // Shorter bursts are almost always a person hitting Enter in a form; every
  // real retail symbology is at least 8 characters.
  minLength: number;
  // The whole discriminator. Wedge scanners emit at roughly 3-20 ms per
  // character; a very fast typist manages about 90-150 ms. 50 ms sits in the
  // empty space between the two, well clear of both.
  maxInterKeyMs: number;
  // Scanners are configured to send one of these after the code. CR is the
  // factory default on essentially every model.
  terminators: readonly string[];
};

export const DEFAULT_WEDGE_CONFIG: WedgeConfig = {
  minLength: 4,
  maxInterKeyMs: 50,
  terminators: ['Enter', 'Tab'],
};

export type WedgeState = { buffer: string; lastKeyAt: number };

export type WedgeStep = {
  state: WedgeState;
  // The completed code, on the keystroke that finishes a scan.
  emit: string | null;
  // Whether the caller should swallow this key event. Only ever true for a
  // terminator that actually produced a scan -- so the Enter that ends a scan
  // doesn't ALSO submit a form or press whatever button has focus, while every
  // other keystroke is left completely alone.
  consumed: boolean;
};

export function initialWedgeState(): WedgeState {
  return { buffer: '', lastKeyAt: 0 };
}

// `key` is a DOM KeyboardEvent.key value: a single character for printable
// keys, or a name like 'Enter', 'Shift', 'ArrowLeft' for everything else.
export function stepWedge(
  state: WedgeState,
  key: string,
  at: number,
  config: WedgeConfig = DEFAULT_WEDGE_CONFIG
): WedgeStep {
  if (config.terminators.includes(key)) {
    const code = state.buffer;
    // The terminator has to be part of the same burst. A scanner sends its
    // suffix immediately after the last digit; without this check, typing four
    // quick characters and pressing Enter a second later would read as a scan.
    const inBurst = at - state.lastKeyAt <= config.maxInterKeyMs;
    const isScan = inBurst && code.length >= config.minLength;
    // Reset either way: a terminator ends the burst whether or not it was a
    // scan, so a rejected buffer can't leak into the next one.
    return { state: initialWedgeState(), emit: isScan ? code : null, consumed: isScan };
  }

  // Modifiers, arrows, function keys: a scanner never sends them, and a person
  // pressing Shift mid-code (for an uppercase SKU) must not break the burst.
  if (key.length !== 1) return { state, emit: null, consumed: false };

  // A slow gap means a human is typing, so the buffer restarts from this
  // character rather than accumulating. That single rule is what keeps ordinary
  // typing from ever reaching `minLength` -- each keystroke discards the last.
  const starting = state.buffer.length === 0 || at - state.lastKeyAt > config.maxInterKeyMs;

  return {
    state: { buffer: starting ? key : state.buffer + key, lastKeyAt: at },
    emit: null,
    consumed: false,
  };
}
