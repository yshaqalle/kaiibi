import { Pressable, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SearchKeypad } from '@/components/search-keypad';

function render(props: Partial<React.ComponentProps<typeof SearchKeypad>> = {}) {
  const onChange = jest.fn();
  const onSubmit = jest.fn();
  const onClose = jest.fn();
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <SearchKeypad value="she" onChange={onChange} onSubmit={onSubmit} onClose={onClose} {...props} />,
    );
  });
  const press = (label: string) => {
    // React 19's react-test-renderer unwraps a React.memo()-wrapped component's
    // fiber `.type` to its inner render function when there is no custom
    // `compare` (the "SimpleMemoComponent" optimization) -- and RN's Pressable
    // is exported as exactly that kind of memo. So a plain `findAllByType(Pressable)`
    // never matches here; it has to also check the memo's unwrapped inner type.
    const target = tree!.root
      .findAll((node) => node.type === Pressable || node.type === (Pressable as unknown as { type: unknown }).type)
      .find((node) => node.findAllByType(Text).some((t) => t.props.children === label));
    if (!target) throw new Error(`no key labelled ${label}`);
    act(() => { target.props.onPress(); });
  };
  return { onChange, onSubmit, onClose, press, tree: tree! };
}

describe('SearchKeypad', () => {
  it('is QWERTY, with the digits on top', () => {
    const { tree } = render();
    const labels = tree.root.findAllByType(Text).map((t) => t.props.children);
    expect(labels.slice(0, 10)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
    expect(labels.slice(10, 20)).toEqual(['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P']);
  });

  // Lowercase out, whatever the cap on the key: search is case-insensitive and
  // the value goes straight into the same filter a typed query uses.
  it('appends the letter in lower case', () => {
    const { onChange, press } = render();
    press('A');
    expect(onChange).toHaveBeenCalledWith('shea');
  });

  it('deletes and clears', () => {
    const { onChange, press } = render();
    press('⌫');
    expect(onChange).toHaveBeenCalledWith('sh');
    press('Clear');
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('submits and closes on Done', () => {
    const { onSubmit, onClose, press } = render();
    press('Done');
    expect(onSubmit).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
