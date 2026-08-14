import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CustomerTableHeader } from '@/components/customer-table-row';
import { ProductTableHeader } from '@/components/product-table-row';

// product-table-row pulls in @/lib/products, which pulls in the live client;
// that throws at require time without env vars. Same stub the platform tests
// use.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// These two headers had no test at all, which is what made hoisting their
// inner `HeaderCell` to module scope (react-hooks/static-components) a
// refactor with nothing holding it. Written against the ORIGINAL behaviour so
// it pins the labels, the sort arrow and the press target either way.

function render(element: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
}

function texts(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap((n) => (typeof n.props.children === 'string' ? [n.props.children] : []));
}

// By handler rather than by component type: Pressable renders through a
// forwardRef whose identity findAllByType does not match under this preset.
function pressables(tree: ReactTestRenderer) {
  return tree.root.findAll((n) => typeof n.props.onPress === 'function');
}

// The labels you can actually press. Asserted by membership rather than by
// counting pressables: `HeaderCell` takes an `onPress` PROP, so a naive count
// matches both the component and the Pressable it renders, and would double
// without anything on screen changing.
function pressableLabels(tree: ReactTestRenderer): string[] {
  return pressables(tree)
    .flatMap((p) => p.findAllByType(Text).map((t) => t.props.children))
    .filter((c): c is string => typeof c === 'string');
}

function pressLabelled(tree: ReactTestRenderer, label: string) {
  const target = pressables(tree).find((p) =>
    p.findAllByType(Text).some((t) => t.props.children === label)
  );
  if (!target) throw new Error(`no pressable containing "${label}"`);
  act(() => target.props.onPress());
}

describe('CustomerTableHeader', () => {
  it('draws every column', () => {
    const t = texts(render(<CustomerTableHeader sortField={null} sortDirection="asc" onSort={() => {}} />));
    expect(t).toEqual(expect.arrayContaining(['NAME', 'PHONE', 'EMAIL', 'TAGS']));
  });

  it('marks only the sorted column, and points the arrow the right way', () => {
    const up = texts(render(<CustomerTableHeader sortField="name" sortDirection="asc" onSort={() => {}} />));
    expect(up).toContain('▲');
    expect(up).not.toContain('▼');

    const down = texts(render(<CustomerTableHeader sortField="name" sortDirection="desc" onSort={() => {}} />));
    expect(down).toContain('▼');
  });

  it('draws no arrow at all when nothing is sorted', () => {
    const t = texts(render(<CustomerTableHeader sortField={null} sortDirection="asc" onSort={() => {}} />));
    expect(t).not.toContain('▲');
    expect(t).not.toContain('▼');
  });

  it('sorts by the column that was pressed', () => {
    const onSort = jest.fn();
    const tree = render(<CustomerTableHeader sortField={null} sortDirection="asc" onSort={onSort} />);
    pressLabelled(tree, 'EMAIL');
    expect(onSort).toHaveBeenCalledWith('email');
  });

  // TAGS is a plain label, not a sortable column.
  it('does not make TAGS pressable', () => {
    const tree = render(<CustomerTableHeader sortField={null} sortDirection="asc" onSort={() => {}} />);
    const labels = pressableLabels(tree);
    expect(labels).toEqual(expect.arrayContaining(['NAME', 'PHONE', 'EMAIL']));
    expect(labels).not.toContain('TAGS');
  });
});

describe('ProductTableHeader', () => {
  it('draws every column', () => {
    const t = texts(render(<ProductTableHeader sortField={null} sortDirection="asc" onSort={() => {}} />));
    expect(t).toEqual(expect.arrayContaining(['PRODUCT', 'BRAND', 'CATEGORY', 'TAGS', 'PRICE', 'STOCK']));
  });

  // Only a business with more than one store gets the column.
  it('hides LOCATION unless asked for it', () => {
    expect(texts(render(<ProductTableHeader sortField={null} sortDirection="asc" onSort={() => {}} />))).not.toContain(
      'LOCATION'
    );
    expect(
      texts(render(<ProductTableHeader sortField={null} sortDirection="asc" onSort={() => {}} showLocation />))
    ).toContain('LOCATION');
  });

  it('marks only the sorted column', () => {
    const t = texts(render(<ProductTableHeader sortField="price" sortDirection="desc" onSort={() => {}} />));
    expect(t.filter((s) => s === '▼')).toHaveLength(1);
    expect(t).not.toContain('▲');
  });

  it('sorts by the column that was pressed', () => {
    const onSort = jest.fn();
    const tree = render(<ProductTableHeader sortField={null} sortDirection="asc" onSort={onSort} />);
    pressLabelled(tree, 'STOCK');
    expect(onSort).toHaveBeenCalledWith('stock');
  });

  it('leaves TAGS and LOCATION unpressable', () => {
    const tree = render(<ProductTableHeader sortField={null} sortDirection="asc" onSort={() => {}} showLocation />);
    const labels = pressableLabels(tree);
    expect(labels).toEqual(expect.arrayContaining(['PRODUCT', 'BRAND', 'CATEGORY', 'PRICE', 'STOCK']));
    expect(labels).not.toContain('TAGS');
    expect(labels).not.toContain('LOCATION');
  });
});
