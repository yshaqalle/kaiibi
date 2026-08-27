import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { TransferFundsModal } from '@/components/accounting/transfer-funds-modal';
import { Caveat } from '@/components/ui/caveat';
import type { TransferAccount } from '@/lib/transfers';

// Moving the shop's own money.
//
// The three things that could break silently:
//
//   1. THE ACCOUNTS COME FROM list_transfer_accounts(), gated on
//      budgets.manage. `accounts` itself is readable only on ledger.view, which
//      the Manager who banks the float does not hold -- so a picker built off
//      the chart would be empty for exactly the person this door was gated for,
//      with the RPC behind it working perfectly.
//   2. THE SHOP'S OWN NAMES AND THE LEDGER'S OWN BALANCES. A shop that renamed
//      1010 must see what it called it, and the figure beside it must be the
//      one the cash flow's proof row shows.
//   3. THE DATABASE'S SENTENCE. transfer_funds refuses with a sentence naming
//      the codes, the amount or the closed month. A PostgrestError is a plain
//      object and is NEVER `instanceof Error`, so every refusal below is thrown
//      as one -- the shape that made a shipped screen print a generic line
//      instead of the reason.

let mockAccounts: TransferAccount[] = [];
let mockListError: unknown = null;
// Typed loosely on purpose: the assertion below reads the argument the modal
// actually sent, and a `jest.fn(() => …)` infers a zero-length tuple for its
// calls.
const mockTransfer = jest.fn((..._args: unknown[]) => Promise.resolve('entry-1'));

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/transfers', () => ({
  listTransferAccounts: () => (mockListError ? Promise.reject(mockListError) : Promise.resolve(mockAccounts)),
  transferFunds: (...args: unknown[]) => mockTransfer(...(args as [])),
}));
/** The shape `rpc()` rejects with: a plain object, NEVER an Error. */
function postgrestError(message: string) {
  return { code: 'P0001', details: null, hint: null, message };
}

// Three different, non-round balances. Roughly thirty-five mutations on this
// project have been no-ops and the commonest cause is a fixture where two
// figures coincide.
function fixture(): TransferAccount[] {
  return [
    { code: '1000', name: 'Cash on Hand', balanceCents: 418260 },
    { code: '1010', name: 'Salaam, Hodan branch', balanceCents: 3890400 },
    { code: '1020', name: 'Zaad', balanceCents: 633145 },
  ];
}

async function render(onTransferred: () => void = () => {}): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<TransferFundsModal shopId="shop-1" onClose={() => {}} onTransferred={onTransferred} />);
  });
  return tree!;
}

function texts(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => (Array.isArray(node.props.children) ? node.props.children : [node.props.children]))
    .filter((child): child is string => typeof child === 'string');
}

function caveats(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAllByType(Caveat);
}

function buttons(tree: ReactTestRenderer, label: string): ReactTestInstance[] {
  return tree.root
    // `onPress` as well as the role: findAll walks composites AND the host
    // views they render, so a single Pressable matches twice on the role alone
    // -- and the second match of one pill is not the first match of the next.
    .findAll((node) => node.props?.role === 'button' && typeof node.props?.onPress === 'function')
    .filter((node) =>
      node
        .findAllByType(Text)
        .some((text) =>
          (Array.isArray(text.props.children) ? text.props.children : [text.props.children]).some(
            (child) => typeof child === 'string' && child === label
          )
        )
    );
}

// Every account is drawn TWICE -- once in the FROM row, once in TO -- so the
// index is load-bearing rather than incidental. A helper that always took the
// first match set the source twice and left the destination empty, which reads
// as "the button does nothing".
function press(tree: ReactTestRenderer, label: string, index = 0) {
  const node = buttons(tree, label)[index];
  if (!node) throw new Error(`no button labelled ${label} at index ${index}`);
  return node;
}

async function fill(tree: ReactTestRenderer, from: string, to: string, amount: string) {
  await act(async () => {
    press(tree, from, 0).props.onPress();
  });
  await act(async () => {
    press(tree, to, 1).props.onPress();
  });
  await act(async () => {
    // The first TextInput on the card is AMOUNT; DateInput contributes none on
    // any platform (a Pressable on native, a raw <input> on web).
    tree.root.findAllByType(TextInput)[0].props.onChangeText(amount);
  });
}

beforeEach(() => {
  mockAccounts = fixture();
  mockListError = null;
  mockTransfer.mockClear();
  mockTransfer.mockImplementation(() => Promise.resolve('entry-1'));
});

describe('the picker', () => {
  it('offers the shop s own names for its own accounts, with the ledger s balances', async () => {
    const drawn = texts(await render());
    // Both sides render every account, so each name appears twice.
    expect(drawn).toContain('Salaam, Hodan branch');
    expect(drawn).toContain('$4,182.60');
    expect(drawn).toContain('$38,904.00');
    expect(drawn).toContain('$6,331.45');
  });

  it('prints the database s refusal rather than sitting on Loading for ever', async () => {
    mockListError = postgrestError('You do not have permission to move money between accounts.');
    const tree = await render();
    const drawn = texts(tree);
    expect(drawn).toContain('You do not have permission to move money between accounts.');
    expect(drawn).not.toContain('Loading…');
    const refusal = caveats(tree).find(
      (node) => node.props.children === 'You do not have permission to move money between accounts.'
    );
    // 'partial': the reader cannot fix their own permissions.
    expect(refusal!.props.tone).toBe('partial');
  });

  it('says so plainly when a shop has fewer than two cash accounts left', async () => {
    mockAccounts = [{ code: '1000', name: 'Cash on Hand', balanceCents: 418260 }];
    expect(texts(await render()).some((t) => t.includes('needs two cash accounts'))).toBe(true);
  });
});

describe('what it will post', () => {
  it('names both legs in the shop s own words, Dr the destination and Cr the source', async () => {
    const tree = await render();
    await fill(tree, 'Cash on Hand', 'Salaam, Hodan branch', '32.00');
    expect(texts(tree)).toContain('Dr 1010 Salaam, Hodan branch · Cr 1000 Cash on Hand');
  });

  it('says the effect on profit is none, because that is the whole point', async () => {
    expect(texts(await render())).toContain('None');
  });

  it('asks for two accounts before it claims anything', async () => {
    expect(texts(await render())).toContain('Pick two accounts');
  });
});

describe('recording it', () => {
  it('sends the two codes, the amount in cents and the note the way round the ledger needs', async () => {
    const tree = await render();
    await fill(tree, 'Cash on Hand', 'Salaam, Hodan branch', '32.00');
    await act(async () => {
      press(tree, 'Record transfer').props.onPress();
    });
    expect(mockTransfer).toHaveBeenCalledTimes(1);
    expect(mockTransfer.mock.calls[0][0]).toMatchObject({
      shopId: 'shop-1',
      fromCode: '1000',
      toCode: '1010',
      amountCents: 3200,
    });
  });

  it('tells the reader what moved, and that it was neither a profit nor a cost', async () => {
    const tree = await render();
    await fill(tree, 'Cash on Hand', 'Salaam, Hodan branch', '32.00');
    await act(async () => {
      press(tree, 'Record transfer').props.onPress();
    });
    const outcome = caveats(tree).find(
      (node) => typeof node.props.children === 'string' && node.props.children.includes('moved from')
    );
    expect(outcome!.props.tone).toBe('context');
    expect(outcome!.props.children).toContain('$32.00');
    expect(outcome!.props.children).toContain('no profit, no cost');
  });

  it('refreshes whatever was showing behind it, because the balances have moved', async () => {
    const refreshed = jest.fn();
    const tree = await render(refreshed);
    await fill(tree, 'Cash on Hand', 'Salaam, Hodan branch', '32.00');
    await act(async () => {
      press(tree, 'Record transfer').props.onPress();
    });
    expect(refreshed).toHaveBeenCalled();
  });

  it('prints the database s sentence when it refuses, not a line of its own', async () => {
    mockTransfer.mockImplementationOnce(() =>
      Promise.reject(
        postgrestError(
          'A transfer moves money between cash accounts (1000, 1010, 1020, 1021); 1000 to 4000 is not one.'
        )
      )
    );
    const tree = await render();
    await fill(tree, 'Cash on Hand', 'Salaam, Hodan branch', '32.00');
    await act(async () => {
      press(tree, 'Record transfer').props.onPress();
    });
    const drawn = texts(tree);
    expect(drawn).toContain(
      'A transfer moves money between cash accounts (1000, 1010, 1020, 1021); 1000 to 4000 is not one.'
    );
    expect(drawn).not.toContain('The database refused the transfer.');
  });

  it('will not let the destination be the account the money came from', async () => {
    const tree = await render();
    // transfer_funds refuses a transfer to the same account with a sentence
    // naming the code. Withholding the tap is not the rule -- it stops a round
    // trip whose only outcome is being told what you already knew.
    await act(async () => {
      press(tree, 'Cash on Hand', 0).props.onPress();
    });
    expect(press(tree, 'Cash on Hand', 1).props.disabled).toBe(true);
    // ...and the other two are still open.
    expect(press(tree, 'Zaad', 1).props.disabled).toBe(false);
  });

  it('does not send a zero', async () => {
    const tree = await render();
    await fill(tree, 'Cash on Hand', 'Salaam, Hodan branch', '0');
    await act(async () => {
      press(tree, 'Record transfer').props.onPress();
    });
    expect(mockTransfer).not.toHaveBeenCalled();
  });
});
