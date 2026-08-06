import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { StatTile } from '@/components/stat-tile';

// Every string rendered anywhere in the tree, flattened. Enough to assert
// "this text survived" without reaching for a query library the repo does not
// have installed.
function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function renderTile(density: 'default' | 'dense') {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(
      <StatTile variant="bento" density={density} value="3" label="In today" hint="clocked in at some point" />
    );
  });
  return textsIn(tree!.toJSON() as ReactTestRendererJSON);
}

// This is the regression that guards the whole design decision. The dense
// tile exists so the glance strip can shrink WITHOUT dropping the hints --
// "in today: 3" with no "clocked in at some point" reads as a count of who is
// on the floor right now, which it is not. If a later tightening pass deletes
// the hint to win height, this fails.
describe('StatTile density', () => {
  it('renders the hint at the default density', () => {
    expect(renderTile('default')).toContain('clocked in at some point');
  });

  it('still renders the hint when dense', () => {
    expect(renderTile('dense')).toContain('clocked in at some point');
  });

  it('keeps the label and value when dense', () => {
    const texts = renderTile('dense');
    expect(texts).toContain('IN TODAY');
    expect(texts).toContain('3');
  });
});
