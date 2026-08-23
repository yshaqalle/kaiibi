import { act, create } from 'react-test-renderer';

import { Btn } from '@/components/settings/settings-primitives';

// Deleting `accessibilityLabel={accessibilityLabel}` from Btn's rendered
// Pressable left every panel test green, because `tree.root.findAll` also
// matches Btn's OWN composite props -- the caller's JSX prop lands there
// too, before Btn ever forwards (or fails to forward) it, so a bare `[0]`
// lookup found Btn itself and never noticed the forwarding was gone.
// Matching on the HOST element (`typeof n.type === 'string'`, RN's own
// convention for a real native node here, as opposed to a composite
// component like Btn or an intermediate forwardRef layer) only succeeds if
// the label actually made it all the way down the render tree, so a future
// refactor that swallows the prop midway is caught.
describe('Btn', () => {
  it('forwards accessibilityLabel to its rendered host element', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <Btn accessibilityLabel="Do the thing" onPress={() => {}}>
          Go
        </Btn>
      );
    });
    const hosts = tree.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLabel === 'Do the thing');
    expect(hosts).toHaveLength(1);
  });
});
