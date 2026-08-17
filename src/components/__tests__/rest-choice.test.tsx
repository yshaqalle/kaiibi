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
  choice: 'now',
  hasCustomer: true,
  currency: null,
  onChange: () => {},
};

describe('RestChoice', () => {
  it('offers both ways to deal with what is left', () => {
    const text = render(<RestChoice {...choiceProps} />);
    expect(text).toContain('Collect it now');
    expect(text).toContain('Pay later');
  });

  it('names the amount still to deal with, so the choice is not abstract', () => {
    const text = render(<RestChoice {...choiceProps} />);
    expect(text).toContain('$34.74');
  });

  it('says what is missing rather than going grey and silent', () => {
    // A disabled control with no reason on it is a dead end -- the same rule
    // Phase 1's button follows.
    const text = render(<RestChoice {...choiceProps} hasCustomer={false} />);
    expect(text).toContain('Needs a customer');
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

  it('reports which way is chosen back to the caller', () => {
    const picked: string[] = [];
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<RestChoice {...choiceProps} onChange={(next) => picked.push(next)} />);
    });
    const pressables = tree!.root.findAll(
      (node) => typeof node.type !== 'string' && typeof node.props.onPress === 'function'
    );
    act(() => {
      pressables[pressables.length - 1].props.onPress();
    });
    expect(picked).toEqual(['later']);
  });

  it('will not let a balance be chosen with nobody to carry it', () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<RestChoice {...choiceProps} hasCustomer={false} onChange={() => {}} />);
    });
    // Asserted as "there is no handler to fire", not as "pressing it did
    // nothing": a disabled Pressable that still carries an onPress is one
    // `disabled` prop away from firing again.
    const blocked = tree!.root.findAll(
      (node) => typeof node.type !== 'string' && node.props.accessibilityState?.disabled === true
    );
    // Pressable passes the state down a layer, so more than one node carries
    // it. Every one of them has to be inert.
    expect(blocked.length).toBeGreaterThan(0);
    for (const node of blocked) expect(node.props.onPress).toBeUndefined();
  });
});

const balanceProps: React.ComponentProps<typeof CustomerBalanceRow> = {
  owedCents: 3474,
  since: '2026-08-12T10:00:00.000Z',
  saleCount: 1,
  currency: null,
  collecting: false,
  onCollect: () => {},
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

  it('renders nothing for a customer who owes nothing, so most shops never see it', () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<CustomerBalanceRow {...balanceProps} owedCents={0} />);
    });
    expect(tree!.toJSON()).toBeNull();
  });
});
