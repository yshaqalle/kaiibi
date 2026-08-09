import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { DateInput } from '@/components/date-input';
import { AppModal } from '@/components/ui/app-modal';

// The native picker never mounts under Jest; a stub stands in so the tests can
// find it and drive its onChange.
jest.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: () => null,
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MockPicker = require('@react-native-community/datetimepicker').default;

// RN 0.86's `Pressable` is `React.memo(...)` and `findAllByType(Pressable)`
// silently matches zero nodes (see search-row.test.tsx). Duck-type on the
// handler instead.
function findPressables(tree: ReactTestRenderer) {
  return tree.root.findAll((node) => typeof node.props?.onPress === 'function', { deep: true });
}

function openPicker(value = '') {
  const onChangeText = jest.fn();
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(<DateInput value={value} onChangeText={onChangeText} />); });
  // Before the calendar opens the input is the only pressable.
  act(() => { findPressables(tree!)[0].props.onPress(); });
  return { tree: tree!, onChangeText };
}

describe('DateInput (iOS)', () => {
  // Apple's inline calendar is ~320pt wide and will not shrink, while every
  // form in the app puts DateInput in a half-width column. In-flow it bleeds
  // out of the card (the iPad custom-range bug); inside its own modal the
  // window, not the column, sizes it.
  it('presents the calendar in its own modal so narrow fields cannot clip it', () => {
    const { tree } = openPicker();
    const overlay = tree.root.findByType(AppModal);
    expect(overlay.props.visible).toBe(true);
    expect(overlay.findAllByType(MockPicker)).toHaveLength(1);
  });

  it('fills the field and closes the calendar when a date is picked', () => {
    const { tree, onChangeText } = openPicker();
    const picker = tree.root.findByType(MockPicker);
    act(() => { picker.props.onChange({}, new Date(2026, 6, 28)); });
    expect(onChangeText).toHaveBeenCalledWith('2026-07-28');
    expect(tree.root.findAllByType(MockPicker)).toHaveLength(0);
  });

  it('closes without changing the value when the backdrop is tapped', () => {
    const { tree, onChangeText } = openPicker();
    // With the overlay up, the first pressable inside the modal is the backdrop.
    act(() => { findPressables(tree)[1].props.onPress(); });
    expect(onChangeText).not.toHaveBeenCalled();
    expect(tree.root.findAllByType(MockPicker)).toHaveLength(0);
  });
});
