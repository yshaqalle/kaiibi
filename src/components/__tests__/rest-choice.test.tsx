import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { CustomerBalanceRow } from '@/components/pos/customer-balance-row';
import { RestChoice } from '@/components/pos/rest-choice';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function render(element: React.ReactElement) {
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(element);
  });
  // React splits interpolated text into separate nodes, so anything asserted
  // as a phrase has to be joined before it is searched.
  return textsIn(tree!.toJSON() as ReactTestRendererJSON | null).join('');
}

const choiceProps: React.ComponentProps<typeof RestChoice> = {
  remainingCents: 3474,
  collectedCents: 0,
  chosen: false,
  customerName: 'Farah Hassan',
  currency: null,
  onChange: () => {},
  onNeedCustomer: () => {},
};

describe('RestChoice', () => {
  it('offers one decision, not a choice between doing something and doing nothing', () => {
    // "Collect it now" was a tile that meant do nothing different -- taking the
    // money is the payment methods above this control.
    const text = render(<RestChoice {...choiceProps} />);
    expect(text).toContain('Pay later');
    expect(text).not.toContain('Collect it now');
  });

  it('names the amount and whose account carries it', () => {
    const text = render(<RestChoice {...choiceProps} />);
    expect(text).toContain('$34.74');
    expect(text).toContain("Farah Hassan's account");
  });

  it('does not call an untouched bill "remaining"', () => {
    const text = render(<RestChoice {...choiceProps} />);
    expect(text).toContain('Carry $34.74');
    expect(text).not.toContain('remaining');
  });

  it('says "the remaining" once part of it has been taken', () => {
    // Some now, the rest later -- the same control, with the amount moving as
    // payments are entered above it.
    const text = render(<RestChoice {...choiceProps} collectedCents={5000} />);
    expect(text).toContain('the remaining $34.74');
  });

  it('reads back what it is doing once chosen', () => {
    const text = render(<RestChoice {...choiceProps} chosen />);
    expect(text).toContain('Paying later');
    expect(text).toContain("$34.74 carried on Farah Hassan's account");
  });

  it('offers a way back out, so it is not a one-way door', () => {
    expect(render(<RestChoice {...choiceProps} chosen />)).toContain('Undo');
  });

  it('offers to attach a customer rather than going grey and silent', () => {
    const text = render(<RestChoice {...choiceProps} customerName={null} />);
    expect(text).toContain('Attach a customer');
  });

  it('with no customer, pressing it opens the picker instead of choosing', () => {
    // "You cannot do this yet" with no way forward is a dead end, and it reads
    // as broken. The control becomes the way to fix what it is missing.
    const picked: boolean[] = [];
    const asked: number[] = [];
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <RestChoice
          {...choiceProps}
          customerName={null}
          onChange={(next) => picked.push(next)}
          onNeedCustomer={() => asked.push(1)}
        />
      );
    });
    const press = tree!.root.findAll(
      (node) => typeof node.type !== 'string' && typeof node.props.onPress === 'function'
    )[0];
    act(() => { press.props.onPress(); });
    expect(asked).toHaveLength(1);
    expect(picked).toEqual([]);
  });

  it('renders nothing at all once the payments cover the bill', () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<RestChoice {...choiceProps} remainingCents={0} />);
    });
    expect(tree!.toJSON()).toBeNull();
  });

  it('renders nothing when the shop is somehow owed a negative amount', () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<RestChoice {...choiceProps} remainingCents={-500} />);
    });
    expect(tree!.toJSON()).toBeNull();
  });

  it('toggles both ways', () => {
    const picked: boolean[] = [];
    let off: ReturnType<typeof create>;
    let on: ReturnType<typeof create>;
    act(() => { off = create(<RestChoice {...choiceProps} onChange={(next) => picked.push(next)} />); });
    act(() => { on = create(<RestChoice {...choiceProps} chosen onChange={(next) => picked.push(next)} />); });
    const press = (tree: ReturnType<typeof create>) =>
      tree.root.findAll((node) => typeof node.type !== 'string' && typeof node.props.onPress === 'function')[0];
    act(() => { press(off!).props.onPress(); });
    act(() => { press(on!).props.onPress(); });
    expect(picked).toEqual([true, false]);
  });
});

const balanceProps: React.ComponentProps<typeof CustomerBalanceRow> = {
  owedCents: 3474,
  since: '2026-08-12T10:00:00.000Z',
  saleCount: 1,
  currency: null,
  collecting: false,
  canCollect: true,
  onCollect: () => {},
  onCancel: () => {},
};

describe('CustomerBalanceRow', () => {
  it('says what is owed and offers to take it', () => {
    const text = render(<CustomerBalanceRow {...balanceProps} />);
    expect(text).toContain('Owes $34.74');
    expect(text).toContain('Collect it');
  });

  it('says since when, because an old debt reads differently from a new one', () => {
    // Ambient-locale ordering, the same assumption range-label.test.ts makes
    // ('Jul 23 – Aug 5').
    const text = render(<CustomerBalanceRow {...balanceProps} />);
    expect(text).toContain('Aug 12');
  });

  it('counts the sales when a customer owes on more than one', () => {
    const text = render(<CustomerBalanceRow {...balanceProps} saleCount={3} />);
    expect(text).toContain('3 sales');
  });

  it('does not count to one', () => {
    // "across 1 sale" is noise on the common case.
    const text = render(<CustomerBalanceRow {...balanceProps} />);
    expect(text).not.toContain('1 sale');
  });

  it('offers a way out of collecting, so a mis-tap is not a wedge', () => {
    // settlingFor used to clear only on a successful settlement, and the button
    // disabled itself while set -- so tapping Collect it by accident left the
    // checkout button stuck with nothing to undo it.
    const cancelled: number[] = [];
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <CustomerBalanceRow {...balanceProps} collecting onCancel={() => cancelled.push(1)} />
      );
    });
    const press = tree!.root.findAll(
      (node) => typeof node.type !== 'string' && typeof node.props.onPress === 'function'
    )[0];
    act(() => { press.props.onPress(); });
    expect(cancelled).toHaveLength(1);
    expect(render(<CustomerBalanceRow {...balanceProps} collecting />)).toContain('Cancel');
  });

  it('does not offer to collect while a sale is open', () => {
    // Settling is its own transaction. Offering it mid-basket promised something
    // checkout() would not do.
    const text = render(<CustomerBalanceRow {...balanceProps} canCollect={false} />);
    expect(text).toContain('Owes $34.74');
    expect(text).not.toContain('Collect it');
    expect(text).toContain('Finish or clear this sale');
  });

  it('renders nothing for a customer who owes nothing, so most shops never see it', () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<CustomerBalanceRow {...balanceProps} owedCents={0} />);
    });
    expect(tree!.toJSON()).toBeNull();
  });
});
