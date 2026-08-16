import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { DualAmount } from '@/components/pos/dual-amount';
import type { Currency } from '@/types/models';

// Every string rendered anywhere in the tree, flattened. Enough to assert
// "this figure survived" without reaching for a query library the repo does
// not have installed.
function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const slsh: Currency = {
  id: 'cur-1',
  shopId: 'shop-1',
  code: 'SLSH',
  name: 'Somaliland Shilling',
  symbol: 'SLSH',
  rateToUsd: 8500,
  active: true,
  createdAt: '2026-08-01T00:00:00.000Z',
};

// `act` for the same reason every other component test here uses it: the
// renderer schedules its first commit, and reading `toJSON()` before that has
// flushed is what makes these suites flaky.
const render = (currency: Currency | null) => {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<DualAmount cents={8474} currency={currency} size="line" />);
  });
  return textsIn(tree.toJSON() as ReactTestRendererJSON);
};

describe('DualAmount', () => {
  it('prints the dollars and the shillings', () => {
    expect(render(slsh)).toEqual(['$84.74', '720,290 SLSH']);
  });

  it('prints one line for a shop with no second currency', () => {
    expect(render(null)).toEqual(['$84.74']);
  });
});
