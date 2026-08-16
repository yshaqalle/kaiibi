import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';
import { Text } from 'react-native';

import { SalePanel } from '@/components/pos/sale-panel';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const props: React.ComponentProps<typeof SalePanel> = {
  compact: false,
  mode: 'inline',
  itemCount: 3,
  onClearAll: () => {},
  head: null,
  earnsPoints: 0,
  children: null,
  totalCents: 8474,
  currency: null,
  intent: {
    label: 'Charge $84.74 · Cash',
    hint: 'No customer — the receipt is printed, not saved',
    enabled: true,
  },
  onPrimary: () => {},
  onHold: () => {},
  servedBy: 'Amran Jama',
  onChangeServedBy: () => {},
};

const render = (over: Partial<typeof props> = {}) => {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <SalePanel {...props} {...over}>
        <Text>the sale</Text>
      </SalePanel>
    );
  });
  return textsIn(tree.toJSON() as ReactTestRendererJSON);
};

describe('SalePanel', () => {
  it('carries the sale, the total and the action', () => {
    const texts = render();
    expect(texts).toContain('Current sale');
    expect(texts).toContain('the sale');
    expect(texts).toContain('$84.74');
    expect(texts).toContain('Charge $84.74 · Cash');
  });

  // Joined without a separator: React splits `{n} {word}` into separate text
  // nodes, so anything interpolated has to be reassembled before it is read.
  it('counts one item without pluralising it', () => {
    expect(render({ itemCount: 1 }).join('')).toContain('1 item');
    expect(render({ itemCount: 3 }).join('')).toContain('3 items');
  });

  it('offers Clear only when there is something to clear', () => {
    expect(render().join('')).toContain('Clear');
    expect(render({ onClearAll: null }).join('')).not.toContain('Clear');
  });

  it('opens the sheet instead of charging where the payment is not on the panel', () => {
    const texts = render({ mode: 'sheet' });
    expect(texts).toContain('Checkout · $84.74');
    expect(texts).not.toContain('Charge $84.74 · Cash');
  });

  it('says there is nothing to charge on an empty sheet-mode panel', () => {
    expect(render({ mode: 'sheet', itemCount: 0 })).toContain('Nothing to charge yet');
  });

  it('shows the receipt hint only where the button actually charges', () => {
    expect(render()).toContain('No customer — the receipt is printed, not saved');
    expect(render({ mode: 'sheet' })).not.toContain('No customer — the receipt is printed, not saved');
  });

  it('shortens Hold on a phone, where the space is the basket', () => {
    expect(render()).toContain('Hold for later');
    expect(render({ compact: true })).toContain('Hold');
    expect(render({ compact: true })).not.toContain('Hold for later');
  });

  it('names who is serving, and the points the sale earns', () => {
    const texts = render({ earnsPoints: 80 }).join('');
    expect(texts).toContain('Amran Jama');
    expect(texts).toContain('Earns 80 points');
  });
});
