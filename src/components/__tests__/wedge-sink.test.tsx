import { TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The sink watches its screen's focus so that, with every tab screen kept
// mounted, only the sink in front claims the caret. The real `useFocusEffect`
// needs a navigation container; here the callback runs on mount (the screen is
// in front) and its cleanup is captured so a test can send the screen behind.
let screenBlur: (() => void) | null = null;
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => undefined | (() => void)) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(() => {
      const cleanup = cb();
      screenBlur = cleanup ?? null;
      return cleanup;
    }, [cb]);
  },
}));

import { WedgeSink } from '@/components/wedge-sink';

// The sink is a permanently-focused invisible TextInput, and "permanently" is
// the part that has to be qualified: a scanner-enabled store still has a
// cashier who taps the Inventory search box, and a field the user tapped must
// keep the caret. These pin the one rule that makes the two coexist -- the sink
// only ever takes focus from NOBODY.

// React Native's own Jest mock puts `focus` on the TextInput prototype, so
// spying there is what catches the sink reaching for the caret. The sink is the
// only TextInput these tests render, so every call on it is the sink's.
function renderSink() {
  const focus = jest.spyOn(TextInput.prototype, 'focus');
  const clear = jest.spyOn(TextInput.prototype, 'clear');
  const onScan = jest.fn();
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(<WedgeSink onScan={onScan} />);
  });
  const input = tree!.root.findByType(TextInput);
  return { tree: tree!, focus, clear, input, onScan };
}

type FocusedInput = ReturnType<typeof TextInput.State.currentlyFocusedInput>;
// Stands in for whatever the user actually tapped: mounted, so its native ref
// is present.
const someOtherField = { getNativeRef: () => ({}) } as unknown as FocusedInput;
// A field that unmounted while focused -- a modal's input dismissed by its
// Save button. Its blur never made it back, so the focus cache still names it,
// but its native view is gone.
const staleUnmountedField = { getNativeRef: () => null } as unknown as FocusedInput;
// The typing says a host instance always comes back; the implementation returns
// null whenever nothing is focused, which is the case these tests turn on.
const nobody = null as unknown as FocusedInput;

describe('WedgeSink', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(nobody);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('focuses itself on mount so a scan with nothing focused still lands', () => {
    const { focus } = renderSink();
    act(() => { jest.advanceTimersByTime(50); });
    expect(focus).toHaveBeenCalled();
  });

  // The bug: tapping the Inventory search box focused it, blurred the sink, and
  // the sink's onBlur grabbed the focus straight back -- so the caret left the
  // search box before a key could land and the keyboard was unusable for as
  // long as the store had a hardware scanner switched on.
  it('leaves the caret alone when the user has tapped a real field', () => {
    const { focus, input } = renderSink();
    act(() => { jest.advanceTimersByTime(50); });
    focus.mockClear();

    jest.mocked(TextInput.State.currentlyFocusedInput).mockReturnValue(someOtherField);
    act(() => { input.props.onBlur(); });
    act(() => { jest.advanceTimersByTime(5000); });

    expect(focus).not.toHaveBeenCalled();
  });

  it('takes focus back once the field it yielded to has let go', () => {
    const { focus, input } = renderSink();
    act(() => { jest.advanceTimersByTime(50); });
    focus.mockClear();

    jest.mocked(TextInput.State.currentlyFocusedInput).mockReturnValue(someOtherField);
    act(() => { input.props.onBlur(); });
    act(() => { jest.advanceTimersByTime(5000); });

    // The other field is dismissed. Nothing fires on the sink when that
    // happens -- it blurred long ago -- so recovery cannot hang off its own
    // events, or scanning stays dead until the screen remounts.
    jest.mocked(TextInput.State.currentlyFocusedInput).mockReturnValue(nobody);
    act(() => { jest.advanceTimersByTime(2000); });

    expect(focus).toHaveBeenCalled();
  });

  // The focus cache lies in one case: a TextInput unmounted while focused (a
  // modal's field, closed via its Save button) stays in the cache forever,
  // because its blur event died with its native view. The sink must see
  // through that, or every scan after the first product edit goes nowhere
  // until the app restarts.
  it('reclaims focus from a field that unmounted while focused', () => {
    const { focus } = renderSink();
    act(() => { jest.advanceTimersByTime(50); });
    focus.mockClear();

    jest.mocked(TextInput.State.currentlyFocusedInput).mockReturnValue(staleUnmountedField);
    act(() => { jest.advanceTimersByTime(2000); });

    expect(focus).toHaveBeenCalled();
  });

  // The event contract these three pin down: `onChangeText` delivers the
  // field's FULL text every time, not the keystroke's delta. The sink renders
  // no `value`, so during a burst the native field accumulates -- each event
  // is one prefix longer than the last. Treating those payloads as deltas is
  // the bug that shipped: every prefix of the barcode got glued into one
  // unrecognizable code, and a store with the scanner switched on could not
  // scan at all.
  it('emits the scanned code once from cumulative change events', () => {
    const { input, onScan } = renderSink();
    const code = '4006381333931';
    for (let i = 1; i <= code.length; i += 1) {
      act(() => { input.props.onChangeText(code.slice(0, i)); });
    }
    act(() => { input.props.onSubmitEditing(); });

    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith(code);
  });

  it('clears the native field on flush so the next scan starts clean', () => {
    const { input, clear, onScan } = renderSink();
    act(() => { input.props.onChangeText('4006381333931'); });
    act(() => { input.props.onSubmitEditing(); });
    expect(clear).toHaveBeenCalled();

    // The next scan's events start from an empty field again.
    act(() => { input.props.onChangeText('9780201379624'); });
    act(() => { input.props.onSubmitEditing(); });
    expect(onScan).toHaveBeenLastCalledWith('9780201379624');
  });

  it('flushes on a terminator delivered inside the text itself', () => {
    const { input, onScan } = renderSink();
    // Some scanners paste the whole code and its CR in one event and never
    // fire onSubmitEditing.
    act(() => { input.props.onChangeText('4006381333931\r'); });
    expect(onScan).toHaveBeenCalledWith('4006381333931');
  });

  // Both POS and Inventory keep a sink mounted behind the tabs. If a hidden
  // screen's sink held on, every scan would land on the screen the cashier
  // isn't looking at.
  it('lets go of the caret and stops claiming when its screen goes behind', () => {
    const { focus } = renderSink();
    const blur = jest.spyOn(TextInput.prototype, 'blur');
    jest.spyOn(TextInput.prototype, 'isFocused').mockReturnValue(true);
    act(() => { jest.advanceTimersByTime(50); });
    focus.mockClear();

    act(() => { screenBlur?.(); });

    expect(blur).toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(5000); });
    expect(focus).not.toHaveBeenCalled();
  });

  it('stops reaching for focus once it is unmounted', () => {
    const { tree, focus } = renderSink();
    act(() => { jest.advanceTimersByTime(50); });
    act(() => { tree.unmount(); });
    focus.mockClear();

    act(() => { jest.advanceTimersByTime(5000); });
    expect(focus).not.toHaveBeenCalled();
  });
});
