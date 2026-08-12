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
  // How late the terminator may arrive and still belong to the burst it ends.
  // Deliberately NOT `maxInterKeyMs`: the characters are the discriminator, and
  // the Enter that follows them is not delivered on the same clock. Scanners
  // can be configured with a suffix delay, and a `TextInput`'s submit crosses a
  // render pass its `onChangeText`s did not, so a genuine scan's terminator can
  // trail its last digit by a long way: measured at 627ms on a real device,
  // between characters that all shared a single millisecond. A second is the
  // same span `ABANDONED_BURST_MS` uses for "this burst is over", and it costs
  // little either way -- a burst can only reach `minLength` at speeds no one
  // can type, so what waits here is always a machine's code.
  maxTerminatorGapMs: number;
  // Scanners are configured to send one of these after the code. CR is the
  // factory default on essentially every model.
  terminators: readonly string[];
};

export const DEFAULT_WEDGE_CONFIG: WedgeConfig = {
  minLength: 4,
  maxInterKeyMs: 50,
  maxTerminatorGapMs: 1_000,
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

// ---------------------------------------------------------------------------
// The native half: a scanner typing into `WedgeSink`'s invisible TextInput.
//
// Native gets no keystrokes -- `onChangeText` reports the WHOLE contents of the
// field each time, and `onSubmitEditing` reports the terminator. So there is no
// timing to measure and none of the machine above applies; the only question is
// which part of the field has not been read out yet.
//
// That question exists because emptying the field is not something the
// component can rely on. `TextInput.clear()` goes through `setNativeProps`,
// which the New Architecture does not reliably apply (`newArchEnabled=true` in
// android/gradle.properties), so the scanned code frequently STAYS in the
// field. Treating each `onChangeText` payload as one code then glues every scan
// onto the last: 8809447255972, then 88094472559723846447255972, and on it
// grows -- a "code" that matches nothing and cannot be typed away, which is
// exactly what a till sees after a few scans.
//
// So the field is treated as append-only and its emptying as a bonus: remember
// how much has been consumed, and emit only what is past that mark.

export type SinkState = {
  /** The prefix of the field already emitted as a scan. */
  consumed: string;
  /** The field's contents as of the last change, for the abandoned-burst rule. */
  seen: string;
  /** When the field last changed, for the same rule. */
  lastChangeAt: number;
};

export type SinkStep = { state: SinkState; emit: string | null };

// A code delivered without a terminator never completes, and would otherwise
// sit at the head of the field prefixing whatever is scanned next. Long enough
// that it cannot cut into a scan still being delivered in chunks -- those
// arrive in consecutive frames -- and short enough that the next scan is clean.
const ABANDONED_BURST_MS = 1_000;

// Every terminator a scanner can be configured to send, matched at the END of
// the fresh text: CR, LF and Tab. `normalizeBarcode` strips them (and every
// other control character) out of the emitted code.
const TERMINATED = /[\r\n\t]$/;

export function initialSinkState(): SinkState {
  return { consumed: '', seen: '', lastChangeAt: 0 };
}

// The part of `text` that has not been emitted yet.
//
// `clear()` working is just the case where the field no longer starts with what
// was consumed -- then the whole of it is new. This is why the fix does not
// care whether the clear landed, which is the one thing the component cannot
// find out.
function freshText(state: SinkState, text: string): string {
  return text.startsWith(state.consumed) ? text.slice(state.consumed.length) : text;
}

/** `onChangeText`: the whole field, whenever any of it changes. */
export function stepSink(state: SinkState, text: string, at: number): SinkStep {
  let fresh = freshText(state, text);

  // A burst that stopped without a terminator is a misread, or a scanner
  // unplugged mid-code. Everything the field already held when it went quiet is
  // written off, leaving only what has arrived since. Decided here, at the
  // start of the next burst, rather than on a timer: the next scan is the first
  // evidence that the last one is over, and a timer would have to fire while
  // the screen is idle to say the same thing.
  if (fresh && state.seen.length > 0 && at - state.lastChangeAt > ABANDONED_BURST_MS) {
    state = { ...state, consumed: state.seen };
    fresh = freshText(state, text);
  }

  if (!TERMINATED.test(fresh)) {
    return { state: { consumed: state.consumed, seen: text, lastChangeAt: at }, emit: null };
  }

  return {
    state: { consumed: text, seen: text, lastChangeAt: at },
    emit: normalizedOrNull(fresh),
  };
}

/** `onSubmitEditing`: the scanner's terminator, reported as a submit. */
export function flushSink(state: SinkState, text: string): SinkStep {
  return {
    state: { consumed: text, seen: text, lastChangeAt: state.lastChangeAt },
    emit: normalizedOrNull(freshText(state, text)),
  };
}

function normalizedOrNull(raw: string): string | null {
  let out = '';
  for (const char of raw) {
    const code = char.codePointAt(0)!;
    // Same rule as `normalizeBarcode` in lib/barcode.ts -- control characters
    // and spaces are never part of a code -- kept here so this module stays
    // free of imports and testable on its own.
    if (code > 32 && code !== 127) out += char;
  }
  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// The third case: a scanner typing into the SEARCH FIELD itself.
//
// Both machines above yield to a field the user has focused -- the global
// listener ignores keydown once an INPUT has it, and `WedgeSink` gives the
// caret back to any field that is tapped. That yield is right: the field owns
// the keyboard. But it leaves the field to receive the scan as ordinary typing,
// and typing APPENDS. So a second scan into a box still showing the first reads
// as 88094472559728809447255972 -- one code that matches nothing, growing by
// thirteen digits per scan, and the box cannot be scanned clean again because
// every attempt makes it longer.
//
// Emptying the box after each scan is not the answer: on Inventory the code IS
// the filter showing the result, which is why it is deliberately kept there.
// The question is not when to clear but which part of the field the SCANNER
// typed -- and that is the same discriminator as everywhere else above: speed.
//
// Unlike `stepWedge` this reads whole-field values rather than keystrokes,
// because that is all a `TextInput` reports and all it reports on both
// platforms. The previous value is passed in rather than remembered, so a value
// the SCREEN sets (a camera scan, a wedge scan that landed while nothing was
// focused) cannot leave this machine describing a field that has since changed
// underneath it.

export type FieldBurstState = {
  /** The characters appended so far without a human-sized pause. */
  burst: string;
  lastChangeAt: number;
};

export function initialFieldBurstState(): FieldBurstState {
  return { burst: '', lastChangeAt: 0 };
}

/** `onChangeText`, with the value the field held immediately before it. */
export function stepFieldBurst(
  state: FieldBurstState,
  before: string,
  next: string,
  at: number,
  config: WedgeConfig = DEFAULT_WEDGE_CONFIG
): FieldBurstState {
  // Anything that is not a pure extension -- a backspace, a selection typed
  // over, a value the screen set itself -- is not a scan in progress, and
  // leaving a burst standing through it would let a later Enter replace the
  // field with a fragment of something the user was editing by hand.
  const appended = next.startsWith(before) ? next.slice(before.length) : '';
  if (!appended) return { burst: '', lastChangeAt: at };

  const continuing = state.burst.length > 0 && at - state.lastChangeAt <= config.maxInterKeyMs;
  return { burst: continuing ? state.burst + appended : appended, lastChangeAt: at };
}

/**
 * `onSubmitEditing`: the code the scanner just typed, or null if what is in the
 * field was put there by a person. Null means leave the field exactly as it is.
 */
export function fieldBurstScan(
  state: FieldBurstState,
  at: number,
  config: WedgeConfig = DEFAULT_WEDGE_CONFIG
): string | null {
  // The terminator has to belong to the burst it ends, or four quick characters
  // and an Enter a second later would read as a scan. Measured against
  // `maxTerminatorGapMs` rather than the inter-character gap -- see the note on
  // that field for why the two cannot be the same number here.
  const inBurst = at - state.lastChangeAt <= config.maxTerminatorGapMs;
  if (!inBurst || state.burst.length < config.minLength) return null;
  return state.burst;
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
    // The terminator has to be part of the same burst -- but judged by
    // `maxTerminatorGapMs`, not by the inter-character gap. The characters are
    // the discriminator; the Enter that ends them travels a different path and
    // arrives late. Measured on a real device: thirteen digits sharing one
    // millisecond, then their terminator 627ms behind them, rejected as typing.
    // Same reasoning, same number, as `fieldBurstScan` above.
    const inBurst = at - state.lastKeyAt <= config.maxTerminatorGapMs;
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
