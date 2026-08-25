import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { InvoiceEditorModal } from '@/components/accounting/invoice-editor-modal';
import { DateInput } from '@/components/date-input';
import type { Invoice, NewInvoiceInput, UnbilledDelivery } from '@/types/models';

// A BILL FOR GOODS HAS TO SAY WHICH DELIVERY IT PAYS FOR.
//
// `receive_stock` posts Dr 1200 Inventory / Cr 2000 Accounts Payable when a
// delivery lands, and `record_invoice_payment` posts Dr 2000 / Cr the wallet
// when the supplier is paid. Those net out only if the bill being paid is FOR
// the delivery that raised the payable -- and the app used to decide that by
// category, which is a guess about something it was never told. Wrong in both
// directions: a goods bill with no delivery behind it drives Accounts Payable
// into debit, and a bill FOR goods entered under Supplies posts its cost on top
// of the delivery's and doubles the payable.
//
// The database is the door (20260908001900). This file is about the form in
// front of it, and the two things a form owes a person here: never send
// something it already knows will be refused, and, when it does refuse, say what
// to do instead. Both remedies it names are real -- receive the delivery, or
// change what the bill is for -- because a refusal a person cannot act on is how
// a feature stops being used.

const DELIVERY: UnbilledDelivery = {
  id: 'recv-1',
  receivedAt: '2026-08-22T09:15:00.000Z',
  supplierName: 'Berbera Wholesale',
  reference: 'BW-7788',
  locationId: 'loc-1',
  itemCount: 7,
  // 41300 rather than a round number: a wrong prefill cannot coincide with it.
  valueCents: 41_300,
};

// Received with no costs on it, so it reached no book -- there is no payable for
// a bill to settle and the database refuses the link. Returned by the picker
// rather than hidden, because a shopkeeper who cannot find their delivery
// concludes the picker is broken.
const UNCOSTED: UnbilledDelivery = {
  id: 'recv-2',
  receivedAt: '2026-08-19T07:00:00.000Z',
  supplierName: 'Barwaaqo Traders',
  reference: 'BT-0912',
  locationId: 'loc-1',
  itemCount: 6,
  valueCents: 0,
};

// `mock`-prefixed because jest.mock() is hoisted above these declarations.
let mockDeliveries: UnbilledDelivery[] = [];

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/stock-receipts', () => ({
  listUnbilledDeliveries: jest.fn(() => Promise.resolve(mockDeliveries)),
}));
// The two pickers reach for the network and for a shop context that does not
// exist here; neither is what this file is about.
jest.mock('@/components/vendor-picker', () => ({ VendorPicker: () => null }));
jest.mock('@/components/store-picker', () => ({ StorePicker: () => null }));

const EXISTING: Invoice = {
  id: 'inv-1',
  shopId: 'shop-1',
  locationId: 'loc-1',
  vendorId: null,
  vendorName: 'Ghost Wholesale',
  vendorPhone: null,
  invoiceNumber: 'BW-9001',
  category: 'inventory_purchase',
  description: null,
  issuedOn: '2026-05-11',
  dueOn: '2026-05-25',
  amountCents: 26_400,
  paidCents: 0,
  stockReceiptId: null,
  createdBy: null,
  createdAt: '2026-05-11T10:00:00.000Z',
  updatedAt: '2026-05-11T10:00:00.000Z',
  payments: [],
};

// Typed on its argument so `onSave.mock.calls[0][0]` is a NewInvoiceInput and
// not an empty tuple -- which is what makes the stockReceiptId assertion below a
// type-checked one rather than a lucky index.
async function render(
  invoice: Invoice | null,
  onSave = jest.fn((_input: NewInvoiceInput) => Promise.resolve())
) {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(
      <InvoiceEditorModal shopId="shop-1" invoice={invoice} onClose={() => {}} onSave={onSave} />
    );
  });
  return { tree: tree!, onSave };
}

function press(tree: ReactTestRenderer, testID: string) {
  act(() => { tree.root.findByProps({ testID }).props.onPress(); });
}

function has(tree: ReactTestRenderer, testID: string) {
  return tree.root.findAllByProps({ testID }).length > 0;
}

/** Every TextInput in the form, in render order: number, amount. */
function amountInput(tree: ReactTestRenderer) {
  return tree.root.findAll((n) => n.props?.placeholder === '0.00')[0];
}

/**
 * The category chip carrying a given label. Found by walking UP from the words a
 * shopkeeper actually reads to the first thing that can be pressed -- matching
 * on a style object would break the moment the chip is restyled.
 */
function chip(tree: ReactTestRenderer, label: string) {
  let node = tree.root.findAll((n) => n.props?.children === label)[0];
  while (node && typeof node.props?.onPress !== 'function') node = node.parent!;
  return node;
}

/** Whether any rendered string contains this phrase. */
function says(tree: ReactTestRenderer, phrase: string) {
  return tree.root.findAll((n) => typeof n.props?.children === 'string'
    && n.props.children.includes(phrase)).length > 0;
}

async function fillRequiredFields(tree: ReactTestRenderer) {
  const [numberField] = tree.root.findAll((n) => n.props?.placeholder === 'Their reference');
  await act(async () => { numberField.props.onChangeText('BW-7788'); });
  // Two DateInputs, in render order: ISSUED (already filled with today) then
  // DUE, which starts empty and is what canSave is waiting on.
  const [, due] = tree.root.findAllByType(DateInput);
  await act(async () => { due.props.onChangeText('2026-09-05'); });
}

describe('the bill form and the delivery it pays for', () => {
  beforeEach(() => { mockDeliveries = [DELIVERY]; });

  it('refuses to save a stock purchase that names no delivery, and says what to do', async () => {
    // The default category IS inventory_purchase, so this is the state the form
    // opens in -- which is exactly why the message has to be good.
    const { tree } = await render(null);
    expect(has(tree, 'invoice-delivery-required')).toBe(true);
    expect(tree.root.findByProps({ testID: 'invoice-save' }).props.disabled).toBe(true);

    // BOTH remedies, named. Only offering "receive the delivery" would corner
    // somebody whose bill simply is not for goods.
    const message = String(tree.root.findByProps({ testID: 'invoice-delivery-required' }).props.children);
    expect(message).toContain('Pick the delivery above');
    expect(message).toContain('change what it’s for');
  });

  it('says the other sentence when there is no delivery to pick at all', async () => {
    // "Pick the delivery above" is a lie when the picker is empty, and it is the
    // sentence a shop hits on its very first goods bill.
    mockDeliveries = [];
    const { tree } = await render(null);
    const message = String(tree.root.findByProps({ testID: 'invoice-delivery-required' }).props.children);
    expect(message).toContain('Receive it in Inventory first');
    expect(message).not.toContain('Pick the delivery above');
    expect(tree.root.findByProps({ testID: 'invoice-save' }).props.disabled).toBe(true);
  });

  it('accepts one once a delivery is picked, and prefills the amount from it', async () => {
    const { tree } = await render(null);
    press(tree, `invoice-delivery-${DELIVERY.id}`);

    expect(has(tree, 'invoice-delivery-required')).toBe(false);
    // The payable already standing against that delivery is exactly its costed
    // value, so any other figure leaves a difference in Accounts Payable.
    expect(amountInput(tree).props.value).toBe('413.00');

    await fillRequiredFields(tree);
    expect(tree.root.findByProps({ testID: 'invoice-save' }).props.disabled).toBe(false);
  });

  it('carries the delivery through to what is saved', async () => {
    // The whole point: the column is what the trigger reads, so a form that
    // showed a tick and sent nothing would leave the bill posting Dr 1200 /
    // Cr 2000 -- or, for a goods bill, nothing at all -- with no way to tell.
    const { tree, onSave } = await render(null);
    press(tree, `invoice-delivery-${DELIVERY.id}`);
    await fillRequiredFields(tree);
    await act(async () => { tree.root.findByProps({ testID: 'invoice-save' }).props.onPress(); });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ stockReceiptId: 'recv-1', amountCents: 41_300 });
  });

  it('offers the picker on every category, not only on stock purchases', async () => {
    // THE OVER-STATED DIRECTION. A bill for goods entered under Supplies used to
    // post Dr 6400 / Cr 2000 on top of the delivery's own credit and double the
    // payable -- and a field that only appeared for the goods category would
    // never be shown to the person making exactly that mistake.
    const { tree, onSave } = await render(null);
    await act(async () => { chip(tree, 'Supplies').props.onPress(); });

    // Not required here -- a supplies bill usually is a supplies bill -- but
    // available, and it travels.
    expect(has(tree, 'invoice-delivery-required')).toBe(false);
    press(tree, `invoice-delivery-${DELIVERY.id}`);
    await fillRequiredFields(tree);
    await act(async () => { tree.root.findByProps({ testID: 'invoice-save' }).props.onPress(); });
    expect(onSave.mock.calls[0][0]).toMatchObject({ category: 'supplies', stockReceiptId: 'recv-1' });
  });

  it('explains an uncosted delivery rather than hiding it', async () => {
    mockDeliveries = [UNCOSTED];
    const { tree } = await render(null);
    // Listed, so the shopkeeper can find the delivery they are holding paper for.
    expect(has(tree, `invoice-delivery-${UNCOSTED.id}`)).toBe(true);

    press(tree, `invoice-delivery-${UNCOSTED.id}`);
    const message = String(tree.root.findByProps({ testID: 'invoice-delivery-uncosted' }).props.children);
    expect(message).toContain('never reached your books');
    // And no prefill: 0 is not this delivery's value, it is the absence of one.
    expect(amountInput(tree).props.value).toBe('');
  });

  it('names a difference between the bill and the delivery rather than blocking it', async () => {
    // Carriage and rounding are real money; refusing to record them would be
    // worse than the residue they leave. But the residue is stated, with both
    // figures, because it sits in Accounts Payable for ever.
    const { tree } = await render(null);
    press(tree, `invoice-delivery-${DELIVERY.id}`);
    await act(async () => { amountInput(tree).props.onChangeText('420.00'); });

    const message = String(tree.root.findByProps({ testID: 'invoice-delivery-amount-differs' }).props.children);
    expect(message).toContain('413.00');
    expect(message).toContain('7.00');
    await fillRequiredFields(tree);
    expect(tree.root.findByProps({ testID: 'invoice-save' }).props.disabled).toBe(false);
  });

  it('shows an existing bill no picker at all, and names the remedies in words', async () => {
    // The link is final in the database, so a picker here would look like a
    // remedy and be none -- the posting cannot follow a link that moves, because
    // the reverse-and-re-post triggers on `expenses` fire on a fixed column list
    // and nothing on `expenses` changes when the invoice's link does.
    const { tree } = await render(EXISTING);
    expect(has(tree, 'invoice-delivery-none')).toBe(false);
    expect(has(tree, `invoice-delivery-${DELIVERY.id}`)).toBe(false);

    const message = String(tree.root.findByProps({ testID: 'invoice-delivery-fixed' }).props.children);
    expect(message).toContain('pushes Accounts Payable the wrong way');
    expect(message).toContain('Record the delivery in Inventory');
    expect(message).toContain('cannot be added afterwards');
    // ...and editing it is still possible. A form that refused to save an old
    // bill because of a link it cannot set would be a worse bug than the one the
    // immutability closes.
    expect(tree.root.findByProps({ testID: 'invoice-save' }).props.disabled).toBe(false);
  });

  it('tells a linked bill it does not touch profit twice', async () => {
    // A bill against a delivery does NOT reach the P&L again: the goods are
    // already on the balance sheet at what they cost, and that cost becomes
    // profit-affecting when they sell. The default copy says the opposite.
    const { tree } = await render(null);
    expect(says(tree, 'counts against profit')).toBe(true);
    expect(says(tree, 'does not add to your stock value again')).toBe(false);

    press(tree, `invoice-delivery-${DELIVERY.id}`);
    expect(says(tree, 'does not add to your stock value again')).toBe(true);
    expect(says(tree, 'counts against profit')).toBe(false);
  });
});
