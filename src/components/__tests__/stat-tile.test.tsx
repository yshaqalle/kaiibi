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

// The tests above only prove the TEXT survives density. They would still
// pass if `dense` were computed and never spliced into a single style array
// -- the label, value and hint render identically either way. These pin the
// actual style wiring: a merged style object per node, compared field by
// field between the two densities.

// Flattens a (possibly nested, possibly `false`-laced) RN style prop into one
// merged object, last-writer-wins -- the same rule RN itself applies when it
// resolves a style array. Mirrors `textsIn` above: walk whatever shape comes
// back from `toJSON()` rather than assume one.
function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
  }
  if (typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

// Every host node in the tree, flattened, so a node can be found by what it
// looks like (its resolved style, or a distinguishing prop) rather than by a
// brittle path through the JSX.
function nodesIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): ReactTestRendererJSON[] {
  if (node == null || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap(nodesIn);
  return [node, ...nodesIn(node.children as ReactTestRendererJSON[] | string | null)];
}

function renderTree(density: 'default' | 'dense') {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(
      <StatTile variant="bento" density={density} value="3" label="In today" hint="clocked in at some point" />
    );
  });
  return tree!.toJSON() as ReactTestRendererJSON;
}

// The tile container is the one node whose style sets `minWidth` -- only
// `styles.tile` does, and neither density variant overrides it (see the
// comment on `tileDense` in stat-tile.tsx). That is deliberate: it is what
// keeps the surrounding flexWrap row wrapping on a phone regardless of
// density, so it doubles as the invariant this suite pins.
function tileStyle(json: ReactTestRendererJSON): Record<string, unknown> {
  const node = nodesIn(json).find((n) => flattenStyle(n.props?.style).minWidth !== undefined);
  if (!node) throw new Error('could not find the tile container node (no node has minWidth in its style)');
  return flattenStyle(node.props?.style);
}

// The value row is the only node whose style sets a flex `gap`.
function valueRowStyle(json: ReactTestRendererJSON): Record<string, unknown> {
  const node = nodesIn(json).find((n) => flattenStyle(n.props?.style).gap !== undefined);
  if (!node) throw new Error('could not find the value row node (no node has gap in its style)');
  return flattenStyle(node.props?.style);
}

// The value text is the only node that asks RN to shrink-to-fit.
function valueTextStyle(json: ReactTestRendererJSON): Record<string, unknown> {
  const node = nodesIn(json).find((n) => n.props?.adjustsFontSizeToFit === true);
  if (!node) throw new Error('could not find the value text node (no node has adjustsFontSizeToFit)');
  return flattenStyle(node.props?.style);
}

// The hint text is identified by the hint copy it renders, not by position.
function hintTextStyle(json: ReactTestRendererJSON, hint: string): Record<string, unknown> {
  const node = nodesIn(json).find((n) => Array.isArray(n.children) && (n.children as unknown[]).includes(hint));
  if (!node) throw new Error(`could not find a text node rendering "${hint}"`);
  return flattenStyle(node.props?.style);
}

describe('StatTile dense styles', () => {
  const HINT = 'clocked in at some point';

  it('keeps the tile minWidth at 148 in both densities, and shrinks padding/minHeight when dense', () => {
    const defaultStyle = tileStyle(renderTree('default'));
    const denseStyle = tileStyle(renderTree('dense'));

    // The invariant: shrinking this is the most tempting future mistake,
    // because nothing about the dense LOOK requires it -- but it is what
    // makes the wrapping row wrap on a phone.
    expect(defaultStyle.minWidth).toBe(148);
    expect(denseStyle.minWidth).toBe(148);

    expect(defaultStyle.padding).toBe(14);
    expect(denseStyle.padding).toBe(9);

    expect(defaultStyle.minHeight).toBe(92);
    expect(denseStyle.minHeight).toBe(74);
  });

  it('tightens the value row marginTop when dense', () => {
    expect(valueRowStyle(renderTree('default')).marginTop).toBe(7);
    expect(valueRowStyle(renderTree('dense')).marginTop).toBe(5);
  });

  it('shrinks the value text fontSize when dense', () => {
    expect(valueTextStyle(renderTree('default')).fontSize).toBe(24);
    expect(valueTextStyle(renderTree('dense')).fontSize).toBe(20);
  });

  it('tightens the hint text fontSize, marginTop and lineHeight when dense', () => {
    const defaultStyle = hintTextStyle(renderTree('default'), HINT);
    const denseStyle = hintTextStyle(renderTree('dense'), HINT);

    expect(defaultStyle.fontSize).toBe(11);
    expect(denseStyle.fontSize).toBe(10.5);

    expect(defaultStyle.marginTop).toBe(3);
    expect(denseStyle.marginTop).toBe(2);

    expect(defaultStyle.lineHeight).toBe(15);
    expect(denseStyle.lineHeight).toBe(14);
  });
});
