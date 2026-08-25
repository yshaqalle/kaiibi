import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';
import { DesignStrip } from '@/components/storefront/editor/design-strip';
import { THEMES, PALETTES } from '@/lib/storefront-catalog';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function render(theme = 'market', palette = 'ink', neverPublished = true) {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(
      <DesignStrip
        theme={theme as never}
        palette={palette as never}
        neverPublished={neverPublished}
        onThemeChange={() => {}}
        onPaletteChange={() => {}}
      />,
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

  it('says which design is chosen for a shop that has never published', () => {
    expect(render('market', 'ink', true)).toContain('Chosen for you');
  });

  // Property 3a: the badge depends on nothing but neverPublished -- not on
  // which theme/palette happens to be selected right now. A shop that
  // customised and published, then deliberately returned to Market/Ink, has
  // chosen that on purpose and must not be told it was "chosen for you".
  it('hides the badge once the shop has published, even sitting back on the defaults', () => {
    expect(render('market', 'ink', false)).not.toContain('Chosen for you');
  });

  // "depends on nothing else" (property 3a) means nothing else -- not even
  // which theme is currently selected. The badge marks the Market tile as
  // the one picked for a shop that has never published, whatever it is
  // previewing right now.
  it('still marks the default tile even while a different theme is selected', () => {
    expect(render('window', 'ink', true)).toContain('Chosen for you');
  });
});
