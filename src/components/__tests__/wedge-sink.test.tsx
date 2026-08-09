import { TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

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
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(<WedgeSink onScan={jest.fn()} />);
  });
  const input = tree!.root.findByType(TextInput);
  return { tree: tree!, focus, input };
}

type FocusedInput = ReturnType<typeof TextInput.State.currentlyFocusedInput>;
// Stands in for whatever the user actually tapped.
const someOtherField = {} as FocusedInput;
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

  it('stops reaching for focus once it is unmounted', () => {
    const { tree, focus } = renderSink();
    act(() => { jest.advanceTimersByTime(50); });
    act(() => { tree.unmount(); });
    focus.mockClear();

    act(() => { jest.advanceTimersByTime(5000); });
    expect(focus).not.toHaveBeenCalled();
  });
});
