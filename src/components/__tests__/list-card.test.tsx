import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';
import { Text } from 'react-native';

import { ListCard } from '@/components/ui/list-card';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function renderCard(count: number) {
  const rows = Array.from({ length: count }, (_, i) => ({ id: String(i), label: `row-${i}` }));
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(
      <ListCard
        title="Purchase history"
        rows={rows}
        keyExtractor={(r) => r.id}
        renderRow={(r) => <Text>{r.label}</Text>}
        emptyLabel="No purchases yet."
      />
    );
  });
  return textsIn(tree!.toJSON() as ReactTestRendererJSON);
}

describe('ListCard preview', () => {
  it('shows the empty label and no View all when there are no rows', () => {
    const texts = renderCard(0);
    expect(texts).toContain('No purchases yet.');
    expect(texts.some((t) => t.startsWith('View all'))).toBe(false);
  });

  // The load-bearing case: a list that exactly fills the preview is COMPLETE.
  // Offering "View all 2" there shows the reader the same two rows again.
  it('shows no View all when the rows exactly fill the preview', () => {
    const texts = renderCard(2);
    expect(texts).toContain('row-0');
    expect(texts).toContain('row-1');
    expect(texts.some((t) => t.startsWith('View all'))).toBe(false);
  });

  it('shows View all with the FULL count once there is more than the preview', () => {
    const texts = renderCard(5);
    expect(texts).toContain('View all 5 →');
  });

  // The count names the whole list, not the hidden remainder -- "View all 5"
  // on a 5-row list, never "View all 3".
  it('does not name the hidden remainder', () => {
    const texts = renderCard(5);
    expect(texts.some((t) => t.startsWith('View all 3'))).toBe(false);
  });

  // The card shows the preview and nothing else. A closed Modal renders no
  // children, so anything past the preview is simply absent from the tree --
  // which is a cleaner statement of the same intent than counting occurrences.
  it('renders only the preview rows on the card', () => {
    const texts = renderCard(5);
    expect(texts).toContain('row-0');
    expect(texts).toContain('row-1');
    expect(texts).not.toContain('row-2');
    expect(texts).not.toContain('row-4');
  });

  // The point of the component: the rows the card withholds are all reachable.
  it('shows every row once the modal is open', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: String(i), label: `row-${i}` }));
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(
        <ListCard
          title="Purchase history"
          subtitle="Jaalala Jaalala"
          rows={rows}
          keyExtractor={(r) => r.id}
          renderRow={(r) => <Text>{r.label}</Text>}
          emptyLabel="No purchases yet."
        />
      );
    });

    // Press "View all". Located by its testID -- an anchor that exists
    // purely for tests, so accessibility or styling changes can't break it.
    const trigger = tree!.root.findAll((node) => node.props?.testID === 'list-card-view-all');
    act(() => {
      trigger[0].props.onPress();
    });

    const texts = textsIn(tree!.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('row-2');
    expect(texts).toContain('row-4');
    expect(texts).toContain('Jaalala Jaalala');
    expect(texts).toContain('Close');
  });

  // `note` qualifies the figure the card is showing (a balance, a total), so
  // it has to reach the common case: a short list that never triggers the
  // modal at all. Below previewCount AND the modal never opened is exactly
  // that case.
  it('renders note on the card when rows are below previewCount and the modal has never opened', () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ id: String(i), label: `row-${i}` }));
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(
        <ListCard
          title="Points history"
          rows={rows}
          keyExtractor={(r) => r.id}
          renderRow={(r) => <Text>{r.label}</Text>}
          emptyLabel="No points activity yet."
          note={<Text>Ledger caveat</Text>}
        />
      );
    });

    const texts = textsIn(tree!.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('row-0');
    expect(texts).toContain('row-1');
    // No "View all" -- two rows exactly fill the default previewCount of 2,
    // so the modal is never reachable, and note still has to show up.
    expect(texts.some((t) => t.startsWith('View all'))).toBe(false);
    expect(texts).toContain('Ledger caveat');
  });
});
