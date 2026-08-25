import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';
import { DesignStrip } from '@/components/storefront/editor/design-strip';
import { THEMES, PALETTES } from '@/lib/storefront-catalog';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function render(theme = 'market', palette = 'ink') {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(
      <DesignStrip theme={theme as never} palette={palette as never} onThemeChange={() => {}} onPaletteChange={() => {}} />,
    );
  });
  return textsIn(tree!.toJSON() as ReactTestRendererJSON);
}

describe('DesignStrip', () => {
  it('offers every theme in the catalogue', () => {
    const texts = render();
    for (const t of THEMES) expect(texts).toContain(t.label);
  });

  it('offers every palette in the catalogue', () => {
    const texts = render();
    for (const p of PALETTES) expect(texts).toContain(p.label);
  });

  it('says which design is chosen for a shop that has not chosen one', () => {
    expect(render()).toContain('Chosen for you');
  });
});
