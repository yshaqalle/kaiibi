import { StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { CsvImportModal, type ImportEntityConfig } from '@/components/csv-import-modal';
import { productImportHatches } from '@/lib/products-import';
import type { ShopLocation } from '@/types/models';

// Import's second door.
//
// The rejection this sheet shows fires on ONE condition -- you already carry
// this product -- and the app cannot tell which of two things the shop wants:
// more units arriving (Restock) or the same units at another branch (Move).
// Identical row, identical collision. So `elsewhere` is a list and both are
// offered, and the two things most likely to regress silently are (a) one of
// them quietly disappearing again the next time someone treats the prop as a
// single slot, and (b) the single-store gate handing a shop with one store a
// Move button to nowhere. Both are asserted below.
//
// `pickCsvFile` is the only thing faked: reaching the rejection list means
// walking the sheet's real flow -- choose file, import, read the report -- and
// that flow is the second placement the whole design turns on.
jest.mock('@/lib/pick-csv-file', () => ({ pickCsvFile: jest.fn() }));
// `productImportHatches` lives beside the products import that pulls in the
// Supabase client at module load, and that client throws without env. Nothing
// below reaches the network -- the hatch list is pure -- so the client is
// stubbed rather than the function being moved somewhere it doesn't belong.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
const { pickCsvFile } = jest.requireMock('@/lib/pick-csv-file') as { pickCsvFile: jest.Mock };

const RESTOCK = 'More of something you already sell? Restock';
const MOVE = 'Already sell it, want it at another store? Move';

const PARSED = { headers: ['Name'], rows: [{ Name: 'Torriden Balanceful Serum' }] };

// Numbers count: the sheet's own copy interpolates them ("Import 1 row"), so a
// string-only reader would see a control labelled "Import  row" and never find
// it.
const stringsIn = (children: unknown): string[] => {
  if (typeof children === 'string') return [children];
  if (typeof children === 'number') return [String(children)];
  if (Array.isArray(children)) return children.flatMap(stringsIn);
  return [];
};

// Every rendered line of text, in tree order.
const linesOf = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((node) => stringsIn(node.props.children).join(''));

// The pressable controls carrying a given label. Plural on purpose: the whole
// point of the second placement is that the same hatch appears twice, and a
// helper that returned the first would let the rejection-list copy rot unseen.
// Found by walking UP from the label to the nearest ancestor that has an
// `onPress`, rather than by matching `Pressable` itself: React Native wraps it,
// so the element type in the tree is not the exported component and an
// identity check silently finds nothing at all.
const controlsFor = (tree: ReactTestRenderer, label: string): ReactTestInstance[] =>
  tree.root
    .findAllByType(Text)
    .filter((node) => stringsIn(node.props.children).join('').startsWith(label))
    .map((node) => {
      let owner: ReactTestInstance | null = node;
      while (owner && typeof owner.props.onPress !== 'function') owner = owner.parent ?? null;
      return owner;
    })
    .filter((owner): owner is ReactTestInstance => owner !== null);

// `create` inside `act` because React's concurrent root does the first render
// in a scheduled task, not in the call -- same reason as every other renderer
// test in this directory.
const renderSheet = (config: ImportEntityConfig<{ name: string }>) => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <CsvImportModal visible onClose={() => {}} config={config} onImported={() => {}} />
    );
  });
  return tree;
};

const configWith = (
  elsewhere: ImportEntityConfig<{ name: string }>['elsewhere']
): ImportEntityConfig<{ name: string }> => ({
  title: 'products',
  filenamePrefix: 'products',
  templateColumns: [{ header: 'Name', required: true }],
  exampleRows: [{ Name: 'Wool Scarf' }],
  purpose: "For adding products you don't sell yet.",
  elsewhere,
  run: async () => ({
    accepted: [],
    rejected: [
      {
        row: 7,
        reason: 'You already carry Torriden Balanceful Serum.',
        data: { Name: 'Torriden Balanceful Serum' },
      },
    ],
  }),
});

// Walks the sheet to the report: choose a file, then import it.
const importUntilRejected = async (tree: ReactTestRenderer) => {
  pickCsvFile.mockResolvedValue({ status: 'ok', fileName: 'products.csv', parsed: PARSED });
  await act(async () => {
    controlsFor(tree, 'Choose CSV or Excel file')[0].props.onPress();
  });
  await act(async () => {
    controlsFor(tree, 'Import 1 row')[0].props.onPress();
  });
};

describe("Import's escape hatches", () => {
  beforeEach(() => pickCsvFile.mockReset());

  it('offers every hatch it is given, not just the first', () => {
    const tree = renderSheet(
      configWith([
        { label: RESTOCK, onPress: () => {} },
        { label: MOVE, onPress: () => {} },
      ])
    );
    const lines = linesOf(tree);
    // The arrow is the component's, not the label's -- a label that grew its
    // own would read "Move → →".
    expect(lines).toContain(`${RESTOCK} →`);
    expect(lines).toContain(`${MOVE} →`);
  });

  it('offers them again on the rejection list, where someone meets the problem', async () => {
    const tree = renderSheet(
      configWith([
        { label: RESTOCK, onPress: () => {} },
        { label: MOVE, onPress: () => {} },
      ])
    );
    await importUntilRejected(tree);

    expect(linesOf(tree)).toContain('You already carry Torriden Balanceful Serum.');
    // Two of each: once up front, once beneath the rejected rows. One of each
    // would mean the second placement had been dropped.
    expect(controlsFor(tree, RESTOCK)).toHaveLength(2);
    expect(controlsFor(tree, MOVE)).toHaveLength(2);
  });

  // The order assertions above pass just as well if both ternaries in
  // csv-import-modal.tsx get flipped -- position alone was never checked
  // against which entry actually reads as louder. This is the assertion that
  // was missing: entry zero must carry the loud styling, and everything after
  // it the quiet one, in both places the hatches render.
  it('gives the first hatch louder styling than a later one, in both placements', async () => {
    const tree = renderSheet(
      configWith([
        { label: RESTOCK, onPress: () => {} },
        { label: MOVE, onPress: () => {} },
      ])
    );

    // Up front: ink and weight carry the hierarchy, not just position -- see
    // `elsewhereText` vs `elsewhereQuietText` in csv-import-modal.tsx.
    const textStyleFor = (label: string) =>
      StyleSheet.flatten(
        tree.root
          .findAllByType(Text)
          .find((node) => stringsIn(node.props.children).join('').startsWith(label))?.props.style
      );

    expect(textStyleFor(RESTOCK)).toMatchObject({ color: '#111111', fontWeight: '800' });
    expect(textStyleFor(MOVE)).toMatchObject({ color: '#5E5D65', fontWeight: '700' });

    // On the rejection list, the same weighting is carried by fill instead of
    // ink: the first hatch is a solid button, every later one outlined.
    // `[1]` is the rejection-list control -- `controlsFor` returns the top
    // placement first, matching the "2 of each" assertion above.
    await importUntilRejected(tree);
    const buttonStyleFor = (label: string) =>
      StyleSheet.flatten(controlsFor(tree, label)[1]?.props.style);

    expect(buttonStyleFor(RESTOCK)).toMatchObject({ backgroundColor: '#111111' });
    expect(buttonStyleFor(MOVE)?.backgroundColor).toBeUndefined();
    expect(buttonStyleFor(MOVE)).toMatchObject({ borderWidth: 1 });
  });

  it('hands over to the right sheet, closing itself first', () => {
    const onRestock = jest.fn();
    const onMove = jest.fn();
    const onClose = jest.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <CsvImportModal
          visible
          onClose={onClose}
          config={configWith([
            { label: RESTOCK, onPress: onRestock },
            { label: MOVE, onPress: onMove },
          ])}
          onImported={() => {}}
        />
      );
    });

    act(() => controlsFor(tree, MOVE)[0].props.onPress());
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onRestock).not.toHaveBeenCalled();
    // Closing first is not cosmetic: iOS drops a modal presented while another
    // is still up, so the handover starts by getting this one off the screen.
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => controlsFor(tree, RESTOCK)[0].props.onPress());
    expect(onRestock).toHaveBeenCalledTimes(1);
  });

  it('renders no hatch at all for an import that has none', () => {
    const lines = linesOf(renderSheet(configWith(undefined))).join(' ');
    expect(lines).toContain('COLUMNS');
    expect(lines).not.toContain('Restock');
    expect(lines).not.toContain('Move');
  });
});

const store = (id: string, active = true) =>
  ({ id, name: id, code: id.toUpperCase(), active }) as ShopLocation;

describe('which hatches product import offers', () => {
  // The gate, and the thing most likely to regress silently: an extra control
  // does not look broken, it just leads a one-store shop somewhere it cannot
  // go. Assert the Restock control is there in the same breath -- without it,
  // "no Move" would pass just as well against a function returning nothing.
  it('gives a single-store shop the Restock control and nothing else', () => {
    const onRestock = jest.fn();
    const onMove = jest.fn();
    const hatches = productImportHatches({ locations: [store('main')], onRestock, onMove });

    expect(hatches.map((h) => h.label)).toEqual([RESTOCK]);
    hatches[0].onPress();
    expect(onRestock).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();
  });

  // A second branch that is CLOSED is not somewhere to move stock to, which is
  // why this reads `hasMultipleLocations` rather than counting the array -- the
  // same answer the header's Move pill and the Stock door already give.
  it('treats a shop whose only other store is closed as a single-store shop', () => {
    const hatches = productImportHatches({
      locations: [store('main'), store('kiosk', false)],
      onRestock: () => {},
      onMove: () => {},
    });

    expect(hatches.map((h) => h.label)).toEqual([RESTOCK]);
  });

  // Restock first, and it stays first: `CsvImportModal` gives entry zero the
  // loud treatment, so the order IS the weighting. Swapping them would make
  // the occasional case the prominent one.
  it('gives a multi-store shop both, Restock first', () => {
    const onRestock = jest.fn();
    const onMove = jest.fn();
    const hatches = productImportHatches({
      locations: [store('main'), store('second')],
      onRestock,
      onMove,
    });

    expect(hatches.map((h) => h.label)).toEqual([RESTOCK, MOVE]);
    hatches[1].onPress();
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onRestock).not.toHaveBeenCalled();
  });
});
