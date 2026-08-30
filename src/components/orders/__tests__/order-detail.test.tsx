import { act, create, type ReactTestInstance, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

import { OrderDetail } from '@/components/orders/order-detail';
import { StatementRow } from '@/components/ui/statement-row';
import { orderAddress } from '@/lib/storefront-host';
import type { OrderShortfall } from '@/lib/order-fulfilment';
import type { OrderLine, PaymentMethod, ShopOrder } from '@/lib/storefront-admin';

// Pure and props-driven, unlike the screen: OrderDetail owns no query and no
// mutation of its own (storefront-admin.ts is where those live -- see that
// file's acceptOrder/markOrderReady/cancelOrder/completeOrder), only the
// ephemeral form state a shop's phone needs mid-tap (a typed cancellation
// reason, a picked payment method). Every test here drives it purely off
// props, the same way expense-editor-modal's own tests would if it had any --
// no supabase mock required.

const ORDER: ShopOrder = {
  id: 'order-1',
  number: 7,
  customerName: 'Amina Yusuf',
  customerPhone: '+252634456789',
  fulfilment: 'deliver',
  deliveryArea: 'Hargeisa - 26 June',
  deliveryLandmark: 'Behind Maansoor Hotel, blue gate',
  note: 'Ring the bell twice',
  status: 'pending',
  cancellationReason: null,
  itemCount: 2,
  subtotalCents: 2400,
  deliveryFeeCents: 100,
  totalCents: 2500,
  saleId: null,
  createdAt: '2026-08-20T10:00:00.000Z',
  shareToken: null,
  confirmedAt: null,
  lastAmendedAt: null,
};

const ITEMS: OrderLine[] = [
  { id: 'i1', productId: 'p1', productName: 'Rice 5kg', unitPriceCents: 1200, quantity: 2, lineTotalCents: 2400 },
];

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function renderDetail(props: Partial<Parameters<typeof OrderDetail>[0]> = {}): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <OrderDetail
        order={ORDER}
        items={ITEMS}
        itemsLoading={false}
        itemsError={null}
        shortfalls={[]}
        hasPosAccess
        onClose={jest.fn()}
        onAccept={jest.fn()}
        onMarkReady={jest.fn()}
        onCancel={jest.fn()}
        onComplete={jest.fn()}
        onAmend={jest.fn()}
        canAmend={false}
        currentPrices={{}}
        submitting={false}
        actionError={null}
        {...props}
      />
    );
  });
  return tree!;
}

function texts(tree: ReactTestRenderer): string {
  return textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
}

function pressByLabel(tree: ReactTestRenderer, label: string) {
  const node = tree.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function'
  )[0];
  if (!node) throw new Error(`no pressable labelled ${label}`);
  act(() => node.props.onPress());
}

function find(tree: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return tree.root.findAll((n) => n.props.accessibilityLabel === label)[0];
}

describe('OrderDetail', () => {
  // Property 3: everything a shop needs to act.
  it('shows the lines with their snapshotted prices', () => {
    const tree = renderDetail();
    const t = texts(tree);
    expect(t).toContain('Rice 5kg');
    expect(t).toContain('$12.00');
    expect(t).toContain('$24.00');
  });

  // The money bug: a shop working the door off this panel must see the SAME
  // three figures the customer saw at checkout (checkout-form.tsx's own
  // Goods/Delivery/Total breakdown) -- not just the goods subtotal a
  // line-item list happens to sum to. Before this fix, the panel showed
  // ORDER.subtotalCents ($24.00) and nothing else, so a shop collected $1
  // short on every delivered order.
  describe('the money breakdown', () => {
    it('shows the goods subtotal, the delivery fee, and the total on a delivery order', () => {
      const t = texts(renderDetail({ order: { ...ORDER, fulfilment: 'deliver', subtotalCents: 2400, deliveryFeeCents: 100, totalCents: 2500 } }));
      expect(t).toContain('Goods');
      expect(t).toContain('$24.00');
      expect(t).toContain('Delivery');
      expect(t).toContain('$1.00');
      expect(t).toContain('Amount to collect');
      expect(t).toContain('$25.00');
    });

    it('shows no delivery row at all on a collection order', () => {
      const t = texts(
        renderDetail({
          order: { ...ORDER, fulfilment: 'collect', deliveryArea: null, deliveryLandmark: null, subtotalCents: 2400, deliveryFeeCents: 0, totalCents: 2400 },
        })
      );
      expect(t).toContain('Goods');
      expect(t).not.toContain('Delivery');
      expect(t).toContain('Amount to collect');
      expect(t).toContain('$24.00');
    });
  });

  // Task 6, property 1: a badge says where an order IS; the rail says where
  // it has BEEN and what is left, off order.status alone -- orders stores no
  // per-transition history, so there is nothing else honest to derive it
  // from.
  describe('the stage rail', () => {
    it('shows where the order has been and where it is', () => {
      const t = texts(renderDetail({ order: { ...ORDER, status: 'accepted' } }));
      ['Placed', 'Accepted', 'Ready', 'Done'].forEach((label) => expect(t).toContain(label));
    });

    it('marks the current step for a reader who cannot rely on colour alone', () => {
      const tree = renderDetail({ order: { ...ORDER, status: 'accepted' } });
      expect(find(tree, 'Current stage: Accepted')).toBeTruthy();
    });

    // Cancelled is an off-ramp, not a stop on the road -- showing it as a
    // fifth step after Done would claim a cancelled order was nearly
    // finished. Ready must not appear as a completed step either: `status`
    // alone cannot say the order ever reached it before being cancelled.
    it('renders cancelled as a terminal step, not a fifth stop', () => {
      const t = texts(renderDetail({ order: { ...ORDER, status: 'cancelled', cancellationReason: 'Out of stock' } }));
      expect(t).toContain('Cancelled');
      expect(t).not.toContain('Ready');
    });
  });

  // Task 6, property 3: complete_storefront_order pays complete_sale the
  // goods subtotal ONLY and posts the delivery fee separately to 4300
  // Delivery Income (20260928000200's own header) -- without this block a
  // shop sees a sale in Transactions for less than the order's total and has
  // no way to tell that is correct rather than a bug.
  describe('the reconciliation block', () => {
    const completed = { ...ORDER, status: 'completed' as const, saleId: 'f3a2c1de-0000-0000-0000-000000000000' };

    it('names the sale a completed order became', () => {
      const t = texts(
        renderDetail({ order: { ...completed, subtotalCents: 8600, deliveryFeeCents: 0, totalCents: 8600 } })
      );
      expect(t).toMatch(/in Transactions/i);
    });

    // The short id, not the raw uuid -- a shopkeeper's phone screen has no
    // room for 36 characters, and the mutation that swaps in the full id
    // (or drops the truncation entirely) must fail this.
    it('shows the short form of the sale id, not the raw uuid', () => {
      const t = texts(renderDetail({ order: completed }));
      expect(t).toContain('f3a2c1');
      expect(t).not.toContain('f3a2c1de-0000-0000-0000-000000000000');
    });

    // The delivery fee never reaches the sale: complete_storefront_order
    // pays subtotal_cents only and posts the fee separately to 4300. Without
    // this line the two figures look like a discrepancy.
    it('says where the delivery fee went, so the gap is not read as a bug', () => {
      const t = texts(
        renderDetail({ order: { ...completed, subtotalCents: 18600, deliveryFeeCents: 400, totalCents: 19000 } })
      );
      expect(t).toMatch(/4300 Delivery Income/);
    });

    // The existing Goods/Delivery/Total breakdown hides a $0.00 delivery row
    // on a collect order for exactly this reason: it would promise a fee
    // that order never had. The reconciliation block follows the same rule.
    it('shows no delivery-fee line when there was no delivery fee', () => {
      const t = texts(renderDetail({ order: { ...completed, fulfilment: 'collect', deliveryFeeCents: 0 } }));
      expect(t).not.toMatch(/4300 Delivery Income/);
    });

    it('shows nothing to reconcile before the order is completed', () => {
      const t = texts(renderDetail({ order: { ...ORDER, status: 'ready', saleId: null } }));
      expect(t).not.toMatch(/in Transactions/i);
    });

    // `status === 'completed' && saleId === null` is not a legacy state from
    // before this column existed -- enforce_order_transition
    // (20260928000200_complete_storefront_order.sql) permits `ready ->
    // completed` only in the same statement that sets a non-null sale_id, so
    // this order DID have a sale once. It is reachable today by exactly one
    // route: the sale was deleted (delete_sale, 20260908000900, reachable
    // from Accounting -> Transactions with no storefront exemption), which
    // reverses the sale's journal entries and never touches orders.status.
    // The old fallback ('Goods, in Transactions') and an unconditional
    // delivery-fee line both claimed money was sitting in Transactions that
    // is, in fact, gone -- false on the one screen a shop reconciles from.
    it('says the sale was deleted, not that the goods are in Transactions, when a completed order has no sale', () => {
      const t = texts(renderDetail({ order: { ...completed, saleId: null, deliveryFeeCents: 400 } }));
      expect(t).not.toMatch(/in Transactions/i);
      expect(t).not.toMatch(/4300 Delivery Income/);
      expect(t).toMatch(/deleted/i);
    });
  });

  it("shows the customer's name and phone", () => {
    const t = texts(renderDetail());
    expect(t).toContain('Amina Yusuf');
    expect(t).toContain('+252634456789');
  });

  it('shows a deliver order with its area and landmark', () => {
    const t = texts(renderDetail());
    expect(t).toMatch(/deliver/i);
    expect(t).toContain('Hargeisa - 26 June');
    expect(t).toContain('Behind Maansoor Hotel, blue gate');
  });

  it('shows a collect order as collect, without inventing an area or landmark', () => {
    const t = texts(renderDetail({ order: { ...ORDER, fulfilment: 'collect', deliveryArea: null, deliveryLandmark: null } }));
    expect(t).toMatch(/collect/i);
    expect(t).not.toContain('Behind Maansoor Hotel, blue gate');
  });

  it("shows the customer's note", () => {
    expect(texts(renderDetail())).toContain('Ring the bell twice');
  });

  // Task 3's check, wired in for the first time: a shop must see what it
  // cannot fill before it accepts, not discover it at hand-over.
  it('surfaces a stock shortfall from Task 3', () => {
    const shortfalls: OrderShortfall[] = [{ productId: 'p1', productName: 'Rice 5kg', quantity: 2, available: 0, shortBy: 2 }];
    const t = texts(renderDetail({ shortfalls }));
    expect(t).toMatch(/short/i);
    expect(t).toContain('Rice 5kg');
  });

  it('offers no stock-shortfall warning when the order is fully fillable', () => {
    expect(texts(renderDetail({ shortfalls: [] }))).not.toMatch(/short by/i);
  });

  // N1: a shortfall is what the shop still cannot fill -- it stops meaning
  // that once the order is resolved. A just-completed order shows this for
  // the exact stock its OWN completion decremented; a cancelled order was
  // never going to be filled at all. Both the per-line text and the summary
  // caveat must be gated the same way, not just the summary.
  describe('shortfalls stop showing once the order is resolved', () => {
    const shortfalls: OrderShortfall[] = [{ productId: 'p1', productName: 'Rice 5kg', quantity: 2, available: 0, shortBy: 2 }];

    it('hides the per-line shortfall text on a completed order, even if the shortfall data is still there', () => {
      const t = texts(renderDetail({ order: { ...ORDER, status: 'completed' }, shortfalls }));
      expect(t).not.toMatch(/short by/i);
    });

    it('hides the per-line shortfall text on a cancelled order', () => {
      const t = texts(
        renderDetail({ order: { ...ORDER, status: 'cancelled', cancellationReason: 'Out of stock' }, shortfalls })
      );
      expect(t).not.toMatch(/short by/i);
    });

    it('still shows the shortfall text on a pending order -- resolved orders only', () => {
      const t = texts(renderDetail({ order: { ...ORDER, status: 'pending' }, shortfalls }));
      expect(t).toMatch(/short by/i);
    });

    it('hides a deleted-product shortfall row on a completed order too', () => {
      const nullProductShortfalls: OrderShortfall[] = [
        { productId: null, productName: 'Discontinued kettle', quantity: 1, available: 0, shortBy: 1 },
      ];
      const t = texts(renderDetail({ order: { ...ORDER, status: 'completed' }, shortfalls: nullProductShortfalls }));
      expect(t).not.toContain('Discontinued kettle');
    });
  });

  // Property 4: actions match the state machine exactly -- pending -> accepted
  // is the only legal move (20260928000100_order_transitions.sql), plus
  // cancellation, which is legal from pending/accepted/ready alike.
  describe('actions match the order status exactly', () => {
    it('offers Accept and Cancel on a pending order, nothing else', () => {
      const tree = renderDetail({ order: { ...ORDER, status: 'pending' } });
      expect(find(tree, 'Accept')).toBeTruthy();
      expect(find(tree, 'Cancel order')).toBeTruthy();
      expect(find(tree, 'Mark ready')).toBeFalsy();
      expect(find(tree, 'Complete')).toBeFalsy();
    });

    it('offers Mark ready and Cancel on an accepted order, not Accept or Complete', () => {
      const tree = renderDetail({ order: { ...ORDER, status: 'accepted' } });
      expect(find(tree, 'Mark ready')).toBeTruthy();
      expect(find(tree, 'Cancel order')).toBeTruthy();
      expect(find(tree, 'Accept')).toBeFalsy();
      expect(find(tree, 'Complete')).toBeFalsy();
    });

    it('offers Complete and Cancel on a ready order, not Accept or Mark ready', () => {
      const tree = renderDetail({ order: { ...ORDER, status: 'ready' } });
      expect(find(tree, 'Complete')).toBeTruthy();
      expect(find(tree, 'Cancel order')).toBeTruthy();
      expect(find(tree, 'Accept')).toBeFalsy();
      expect(find(tree, 'Mark ready')).toBeFalsy();
    });

    it('offers no action at all on a completed order', () => {
      const tree = renderDetail({ order: { ...ORDER, status: 'completed' } });
      expect(find(tree, 'Accept')).toBeFalsy();
      expect(find(tree, 'Mark ready')).toBeFalsy();
      expect(find(tree, 'Complete')).toBeFalsy();
      expect(find(tree, 'Cancel order')).toBeFalsy();
    });

    it('offers no action at all on a cancelled order, and shows why it was cancelled', () => {
      const tree = renderDetail({ order: { ...ORDER, status: 'cancelled', cancellationReason: 'Out of stock' } });
      expect(find(tree, 'Accept')).toBeFalsy();
      expect(find(tree, 'Mark ready')).toBeFalsy();
      expect(find(tree, 'Complete')).toBeFalsy();
      expect(find(tree, 'Cancel order')).toBeFalsy();
      expect(texts(tree)).toContain('Out of stock');
    });
  });

  // B2: /orders is gated on settings.access, but completing an order needs
  // pos.access (complete_sale's own rule). A member who lacks it must not
  // see a Complete button that always fails -- "a button that fails is worse
  // than no button" applies here exactly as it does to canAccept/canMarkReady
  // for a status the order itself refuses.
  describe('pos.access gates Complete', () => {
    it('offers Complete on a ready order when the member has pos.access', () => {
      const tree = renderDetail({ order: { ...ORDER, status: 'ready' }, hasPosAccess: true });
      expect(find(tree, 'Complete')).toBeTruthy();
    });

    it('hides Complete on a ready order when the member lacks pos.access', () => {
      const tree = renderDetail({ order: { ...ORDER, status: 'ready' }, hasPosAccess: false });
      expect(find(tree, 'Complete')).toBeFalsy();
    });

    // Says briefly why, so the member knows to ask someone rather than
    // assume the app is broken -- the review's own requirement.
    it('says why there is no Complete button, rather than nothing at all', () => {
      const t = texts(renderDetail({ order: { ...ORDER, status: 'ready' }, hasPosAccess: false }));
      expect(t).toMatch(/pos access/i);
    });

    // Cancel must still be offered -- lacking pos.access is not the same as
    // lacking every permission over this order.
    it('still offers Cancel on a ready order with no pos.access', () => {
      const tree = renderDetail({ order: { ...ORDER, status: 'ready' }, hasPosAccess: false });
      expect(find(tree, 'Cancel order')).toBeTruthy();
    });

    // No explanatory note on a status where Complete was never going to be
    // offered anyway -- that would be noise, not an answer to anything the
    // member asked.
    it('says nothing about pos.access on a pending order', () => {
      const t = texts(renderDetail({ order: { ...ORDER, status: 'pending' }, hasPosAccess: false }));
      expect(t).not.toMatch(/pos access/i);
    });
  });

  it('calls onAccept when Accept is pressed', () => {
    const onAccept = jest.fn();
    const tree = renderDetail({ order: { ...ORDER, status: 'pending' }, onAccept });
    pressByLabel(tree, 'Accept');
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('calls onMarkReady when Mark ready is pressed', () => {
    const onMarkReady = jest.fn();
    const tree = renderDetail({ order: { ...ORDER, status: 'accepted' }, onMarkReady });
    pressByLabel(tree, 'Mark ready');
    expect(onMarkReady).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Close is pressed', () => {
    const onClose = jest.fn();
    const tree = renderDetail({ onClose });
    pressByLabel(tree, 'Close');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Cancellation always says why (orders_cancellation_reason_required,
  // 20260928000100) -- Cancel opens a reason field rather than firing
  // immediately, and the confirm step is inert until something is typed.
  describe('cancelling', () => {
    it('reveals a reason field rather than cancelling immediately', () => {
      const onCancel = jest.fn();
      const tree = renderDetail({ order: { ...ORDER, status: 'pending' }, onCancel });
      pressByLabel(tree, 'Cancel order');
      expect(onCancel).not.toHaveBeenCalled();
      expect(find(tree, 'Confirm cancellation')).toBeTruthy();
    });

    it('does not confirm an empty reason', () => {
      const onCancel = jest.fn();
      const tree = renderDetail({ order: { ...ORDER, status: 'pending' }, onCancel });
      pressByLabel(tree, 'Cancel order');
      pressByLabel(tree, 'Confirm cancellation');
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('calls onCancel with the typed reason once confirmed', () => {
      const onCancel = jest.fn();
      const tree = renderDetail({ order: { ...ORDER, status: 'pending' }, onCancel });
      pressByLabel(tree, 'Cancel order');
      const input = tree.root.findAll((n) => n.props.accessibilityLabel === 'Cancellation reason')[0];
      act(() => input.props.onChangeText('Out of stock, customer notified'));
      pressByLabel(tree, 'Confirm cancellation');
      expect(onCancel).toHaveBeenCalledWith('Out of stock, customer notified');
    });
  });

  // Property 6: completion asks how the customer paid before it posts.
  describe('completing', () => {
    it('reveals a payment method choice rather than completing immediately', () => {
      const onComplete = jest.fn();
      const tree = renderDetail({ order: { ...ORDER, status: 'ready' }, onComplete });
      pressByLabel(tree, 'Complete');
      expect(onComplete).not.toHaveBeenCalled();
      expect(find(tree, 'Cash')).toBeTruthy();
      expect(find(tree, 'Zaad')).toBeTruthy();
      expect(find(tree, 'eDahab')).toBeTruthy();
      expect(find(tree, 'Other')).toBeTruthy();
    });

    it('does not confirm with no payment method chosen', () => {
      const onComplete = jest.fn();
      const tree = renderDetail({ order: { ...ORDER, status: 'ready' }, onComplete });
      pressByLabel(tree, 'Complete');
      pressByLabel(tree, 'Confirm payment');
      expect(onComplete).not.toHaveBeenCalled();
    });

    it.each<[string, PaymentMethod]>([
      ['Cash', 'cash'],
      ['Zaad', 'zaad'],
      ['eDahab', 'edahab'],
      ['Other', 'other'],
    ])('calls onComplete with %s picked as %s', (label, method) => {
      const onComplete = jest.fn();
      const tree = renderDetail({ order: { ...ORDER, status: 'ready' }, onComplete });
      pressByLabel(tree, 'Complete');
      pressByLabel(tree, label);
      pressByLabel(tree, 'Confirm payment');
      expect(onComplete).toHaveBeenCalledWith(method);
    });
  });

  // A button that fails is worse than no button -- while a mutation is in
  // flight, every action must be inert rather than fire a second time.
  it('disables actions while submitting', () => {
    const onAccept = jest.fn();
    const tree = renderDetail({ order: { ...ORDER, status: 'pending' }, onAccept, submitting: true });
    const accept = find(tree, 'Accept');
    expect(accept?.props.disabled).toBe(true);
  });

  it('surfaces an action error', () => {
    const t = texts(renderDetail({ actionError: 'Could not accept this order.' }));
    expect(t).toContain('Could not accept this order.');
  });
});

// ── Amending ────────────────────────────────────────────────────────────
//
// Part 2. Before this, a shortfall dead-ended in one sentence -- "source more
// stock, or cancel it below" -- and the only button under it binned the whole
// order. The sheet now offers the three moves that actually exist.
//
// Every assertion here drives the component's own props, not a rendered
// string, wherever the two disagree: `onAmend`'s ARGUMENTS are the contract
// with storefront-admin.ts, and text can say the right thing while the payload
// is wrong.

const AMEND_ITEMS: OrderLine[] = [
  { id: 'i1', productId: 'p1', productName: 'Rice 5kg', unitPriceCents: 1200, quantity: 5, lineTotalCents: 6000 },
  { id: 'i2', productId: 'p2', productName: 'Oil 1L', unitPriceCents: 1000, quantity: 2, lineTotalCents: 2000 },
];

const AMEND_ORDER: ShopOrder = {
  ...ORDER,
  fulfilment: 'collect',
  deliveryArea: null,
  deliveryLandmark: null,
  deliveryFeeCents: 0,
  subtotalCents: 8000,
  totalCents: 8000,
  itemCount: 7,
};

// Rice is short by 2 (has 3, needs 5); oil is fine.
const RICE_SHORT: OrderShortfall[] = [
  { productId: 'p1', productName: 'Rice 5kg', quantity: 5, available: 3, shortBy: 2 },
];

// Today's shelf: rice has gone UP since the customer agreed to $12.00.
const PRICES: Record<string, number> = { p1: 1500, p2: 1000 };

function renderAmend(props: Partial<Parameters<typeof OrderDetail>[0]> = {}) {
  return renderDetail({
    order: AMEND_ORDER,
    items: AMEND_ITEMS,
    shortfalls: RICE_SHORT,
    currentPrices: PRICES,
    canAmend: true,
    ...props,
  });
}

describe('OrderDetail — the shortfall is no longer a dead end', () => {
  it('offers all three moves, not just cancelling', () => {
    const tree = renderAmend();
    expect(find(tree, 'Reduce to what I have')).toBeDefined();
    expect(find(tree, 'Split the order')).toBeDefined();
    expect(find(tree, 'Cancel order')).toBeDefined();
  });

  // Part 4 builds the RPC. Drawn now so the shop can see the move exists,
  // disabled so it cannot fail -- "a button that fails is worse than no
  // button", and a button that silently does nothing is worse again.
  it('draws Split the order disabled, and says why', () => {
    const tree = renderAmend();
    const split = find(tree, 'Split the order');
    expect(split?.props.disabled).toBe(true);
    expect(texts(tree)).toMatch(/coming|not yet|soon/i);
  });

  it('does not offer to amend at all without the permission to do it', () => {
    const tree = renderAmend({ canAmend: false });
    expect(find(tree, 'Reduce to what I have')).toBeUndefined();
    expect(find(tree, 'Amend order')).toBeUndefined();
    // ...and says why, rather than leaving a blank space where the moves were.
    expect(texts(tree)).toMatch(/permission/i);
  });

  it('offers amending on an order with no shortfall at all -- a wrong quantity is not a stock problem', () => {
    const tree = renderAmend({ shortfalls: [] });
    expect(find(tree, 'Amend order')).toBeDefined();
  });

  it.each(['completed', 'cancelled'] as const)('offers no amend on a %s order', (status) => {
    const tree = renderAmend({ order: { ...AMEND_ORDER, status }, shortfalls: [] });
    expect(find(tree, 'Amend order')).toBeUndefined();
    expect(find(tree, 'Reduce to what I have')).toBeUndefined();
  });
});

describe('OrderDetail — the amend form', () => {
  const openAmend = (props: Partial<Parameters<typeof OrderDetail>[0]> = {}) => {
    const tree = renderAmend(props);
    pressByLabel(tree, 'Amend order');
    return tree;
  };

  it('will not save while the internal reason is blank', () => {
    const tree = openAmend();
    expect(find(tree, 'Save changes')?.props.disabled).toBe(true);
    act(() => find(tree, 'Why this is changing')!.props.onChangeText('only three bags'));
    expect(find(tree, 'Save changes')?.props.disabled).toBe(false);
  });

  it('will not save an amend that empties the order', () => {
    const tree = openAmend();
    act(() => find(tree, 'Why this is changing')!.props.onChangeText('reason'));
    pressByLabel(tree, 'Remove Rice 5kg');
    pressByLabel(tree, 'Remove Oil 1L');
    expect(find(tree, 'Save changes')?.props.disabled).toBe(true);
    expect(texts(tree)).toMatch(/nothing left|cancel/i);
  });

  // THE DELTA PANEL. Re-pricing can change what the customer owes without
  // anyone asking them, so both figures have to be on screen before saving --
  // the old one is what makes the new one mean anything.
  //
  // ASSERTED ON StatementRow's PROPS, not on page text, and that is not
  // style. `$80.00` is ALSO the order's own "Amount to collect" further up
  // the same sheet, so a text assertion passed with the "Was" row deleted
  // outright -- found by mutation. The label/amount pair is the only thing
  // that distinguishes this panel from the breakdown above it.
  it('shows the old total and the new one side by side', () => {
    const tree = openAmend();
    pressByLabel(tree, 'Decrease Rice 5kg');
    pressByLabel(tree, 'Decrease Rice 5kg');
    const rows = tree.root.findAllByType(StatementRow).map((n) => [n.props.label, n.props.amountCents]);
    expect(rows).toContainEqual(['Was', 8000]);
    expect(rows).toContainEqual(['Now', 5600]); // 3 x 12.00 + 2 x 10.00
    expect(rows).toContainEqual(['Customer pays less', 2400]);
  });

  it('says which way the money moved when an amend costs the customer more', () => {
    const tree = openAmend();
    pressByLabel(tree, "Use today's prices");
    const rows = tree.root.findAllByType(StatementRow).map((n) => [n.props.label, n.props.amountCents]);
    // 5 x 15.00 + 2 x 10.00 = 95.00, against the agreed 80.00.
    expect(rows).toContainEqual(['Now', 9500]);
    expect(rows).toContainEqual(['Customer pays more', 1500]);
  });

  it('names the line whose quantity moved, with both quantities', () => {
    const tree = openAmend();
    pressByLabel(tree, 'Decrease Rice 5kg');
    const t = texts(tree);
    expect(t).toContain('Rice 5kg');
    expect(t).toMatch(/5\s*→\s*4|5 to 4/);
  });

  it('re-prices only when the shop asks, and shows the difference that makes', () => {
    const tree = openAmend();
    // Untouched quantities: at the agreed price the total cannot move.
    expect(texts(tree)).not.toContain('$95.00');
    pressByLabel(tree, "Use today's prices");
    // 5 x 15.00 + 2 x 10.00 = 95.00, against the agreed 80.00.
    expect(texts(tree)).toContain('$95.00');
    expect(texts(tree)).toMatch(/Rice 5kg/);
  });

  it('sends the quantities, the reason and the pricing mode it was showing', () => {
    const onAmend = jest.fn();
    const tree = renderAmend({ onAmend });
    pressByLabel(tree, 'Amend order');
    act(() => find(tree, 'Why this is changing')!.props.onChangeText('  only three bags  '));
    pressByLabel(tree, 'Decrease Rice 5kg');
    pressByLabel(tree, 'Decrease Rice 5kg');
    pressByLabel(tree, 'Save changes');

    expect(onAmend).toHaveBeenCalledTimes(1);
    const [lines, reason, options] = onAmend.mock.calls[0];
    expect(lines).toEqual([
      { productId: 'p1', quantity: 3 },
      { productId: 'p2', quantity: 2 },
    ]);
    expect(reason).toBe('only three bags');
    expect(options.pricing).toBe('agreed');
  });

  // TWO REASONS, AND ONLY ONE TRAVELS. The internal one is blunt and written
  // for the shop; the customer's note is separate and optional. A sheet that
  // sent the internal reason as the customer's message would forward
  // "customer always argues about the price" to the customer.
  it('never sends the internal reason as the customer note', () => {
    const onAmend = jest.fn();
    const tree = renderAmend({ onAmend });
    pressByLabel(tree, 'Amend order');
    act(() => find(tree, 'Why this is changing')!.props.onChangeText('she always argues about the price'));
    pressByLabel(tree, 'Save changes');

    const [, reason, options] = onAmend.mock.calls[0];
    expect(reason).toBe('she always argues about the price');
    expect(options.customerNote ?? null).toBeNull();
  });

  it('sends the customer note only when one was actually typed', () => {
    const onAmend = jest.fn();
    const tree = renderAmend({ onAmend });
    pressByLabel(tree, 'Amend order');
    act(() => find(tree, 'Why this is changing')!.props.onChangeText('internal'));
    act(() => find(tree, 'Message for the customer')!.props.onChangeText("we'll have the rest Thursday"));
    pressByLabel(tree, 'Save changes');

    const [, reason, options] = onAmend.mock.calls[0];
    expect(options.customerNote).toBe("we'll have the rest Thursday");
    expect(options.customerNote).not.toBe(reason);
  });

  it('labels the two fields so it is obvious which one the customer reads', () => {
    const tree = openAmend();
    const t = texts(tree);
    expect(t).toMatch(/never see|not shown|your records|internal/i);
  });

  // The shortcut the whole part exists for: one tap sets every short line to
  // what is actually on the shelf.
  it('Reduce to what I have fills the quantities in from the shortfall', () => {
    const onAmend = jest.fn();
    const tree = renderAmend({ onAmend });
    pressByLabel(tree, 'Reduce to what I have');
    act(() => find(tree, 'Why this is changing')!.props.onChangeText('three on the shelf'));
    pressByLabel(tree, 'Save changes');

    const [lines] = onAmend.mock.calls[0];
    // Rice down to the 3 available; oil, which was never short, untouched.
    expect(lines).toEqual([
      { productId: 'p1', quantity: 3 },
      { productId: 'p2', quantity: 2 },
    ]);
  });

  it('refuses to re-price when a line has no current price to read', () => {
    const tree = renderAmend({ currentPrices: { p2: 1000 } });
    pressByLabel(tree, 'Amend order');
    act(() => find(tree, 'Why this is changing')!.props.onChangeText('reason'));
    pressByLabel(tree, "Use today's prices");
    expect(find(tree, 'Save changes')?.props.disabled).toBe(true);
    expect(texts(tree)).toMatch(/price/i);
  });
});

// ── Two products, one name ──────────────────────────────────────────────
//
// `products.name` carries NO unique constraint (0001_init.sql), so one shop
// can hold two products called the same thing -- a re-added item, two
// suppliers' versions, or a sloppy duplicate. order_items snapshots that name,
// so an order can carry two lines reading identically.
//
// The original fixture here used 'Rice 5kg' and 'Oil 1L' and could never have
// caught this: it is the same non-discriminating-fixture failure this series
// has now found five times.
describe('OrderDetail — lines are identified by product, not by name', () => {
  const TWINS: OrderLine[] = [
    { id: 'i1', productId: 'p1', productName: 'Rice 5kg', unitPriceCents: 1200, quantity: 4, lineTotalCents: 4800 },
    // Same NAME, different product. This is the whole fixture.
    { id: 'i2', productId: 'p2', productName: 'Rice 5kg', unitPriceCents: 1000, quantity: 2, lineTotalCents: 2000 },
  ];
  const TWIN_ORDER: ShopOrder = {
    ...AMEND_ORDER,
    subtotalCents: 6800,
    totalCents: 6800,
    itemCount: 6,
  };

  it('moves only the line whose stepper was pressed', () => {
    const onAmend = jest.fn();
    const tree = renderDetail({
      order: TWIN_ORDER,
      items: TWINS,
      shortfalls: [],
      currentPrices: { p1: 1200, p2: 1000 },
      canAmend: true,
      onAmend,
    });
    pressByLabel(tree, 'Amend order');

    // There are two steppers with the same product name. Press the FIRST.
    const decreasers = tree.root.findAll(
      (n) => typeof n.props.accessibilityLabel === 'string'
        && n.props.accessibilityLabel.startsWith('Decrease')
        && typeof n.props.onPress === 'function'
    );
    expect(decreasers).toHaveLength(2);
    act(() => decreasers[0].props.onPress());

    act(() => find(tree, 'Why this is changing')!.props.onChangeText('one bag short'));
    pressByLabel(tree, 'Save changes');

    const [lines] = onAmend.mock.calls[0];
    // p1 down to 3; p2 UNTOUCHED at 2. Keying the draft by product NAME moved
    // both, sending 3 and 1 -- a quantity the shopkeeper never chose, on an
    // order whose total the customer has already agreed to.
    expect(lines).toEqual([
      { productId: 'p1', quantity: 3 },
      { productId: 'p2', quantity: 2 },
    ]);
  });

  it('gives the two lines distinct accessibility labels', () => {
    const tree = renderDetail({
      order: TWIN_ORDER,
      items: TWINS,
      shortfalls: [],
      currentPrices: { p1: 1200, p2: 1000 },
      canAmend: true,
    });
    pressByLabel(tree, 'Amend order');
    // Filtered to nodes that actually HANDLE a press. findAll walks the
    // component and its host node both, so a bare label filter returns each
    // control three times and `size === length` fails on the duplicates
    // rather than on anything real.
    const labels = tree.root
      .findAll(
        (n) =>
          typeof n.props.accessibilityLabel === 'string' &&
          n.props.accessibilityLabel.startsWith('Decrease') &&
          typeof n.props.onPress === 'function'
      )
      .map((n) => n.props.accessibilityLabel as string);
    // Two identical labels are two controls a screen reader cannot tell
    // apart, and two controls this component's own tests cannot address.
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    // ...and the ordinary case keeps the plain label, so the disambiguation
    // is not paid for by every other order.
    const plain = renderDetail({ order: AMEND_ORDER, items: AMEND_ITEMS, shortfalls: [], currentPrices: PRICES, canAmend: true });
    pressByLabel(plain, 'Amend order');
    expect(find(plain, 'Decrease Rice 5kg')).toBeDefined();
  });
});

// ── The shop's side of the customer's link (Part 3 Task 7) ─────────────
describe('OrderDetail — awaiting the customer', () => {
  const AMENDED_UNCONFIRMED: ShopOrder = {
    ...AMEND_ORDER,
    status: 'accepted',
    lastAmendedAt: '2026-08-30T10:00:00Z',
    confirmedAt: null,
  };

  it('shows an Awaiting customer chip once amended and not yet agreed', () => {
    const t = texts(renderDetail({ order: AMENDED_UNCONFIRMED, items: AMEND_ITEMS, canAmend: true }));
    expect(t).toMatch(/awaiting customer/i);
  });

  it('shows no chip on an order that was never amended', () => {
    const t = texts(renderDetail({ order: AMEND_ORDER, items: AMEND_ITEMS, canAmend: true }));
    expect(t).not.toMatch(/awaiting customer/i);
  });

  it('shows no chip once the customer has agreed', () => {
    const t = texts(
      renderDetail({ order: { ...AMENDED_UNCONFIRMED, confirmedAt: '2026-08-30T10:05:00Z' }, items: AMEND_ITEMS, canAmend: true })
    );
    expect(t).not.toMatch(/awaiting customer/i);
  });

  // IT WARNS, IT DOES NOT BLOCK. A shop that phoned and got a verbal yes must
  // not be locked out because the customer never tapped anything -- blocking
  // only teaches people to route around the feature. Same posture the sheet
  // already takes with blockedOnPosAccess: say why, don't silently fail.
  it('leaves every action live while the chip is showing', () => {
    const tree = renderDetail({ order: AMENDED_UNCONFIRMED, items: AMEND_ITEMS, canAmend: true });
    expect(find(tree, 'Mark ready')?.props.disabled).toBe(false);
    expect(find(tree, 'Amend order')?.props.disabled).toBe(false);
  });
});

describe('OrderDetail — the copy link', () => {
  it('shows the address built by orderAddress, never a hand-built string', () => {
    const t = texts(renderDetail({ order: { ...AMEND_ORDER, shareToken: 'a1b2c3d4e5f6g7h8j9k0mnpqrs' }, items: AMEND_ITEMS }));
    expect(t).toContain(orderAddress('a1b2c3d4e5f6g7h8j9k0mnpqrs'));
  });

  // An order placed before the token existed has none. Rendering
  // `kaiibi.com/o/undefined` is #108 exactly: a link that looks real and goes
  // nowhere.
  it('renders no link at all for an order that has no token', () => {
    const t = texts(renderDetail({ order: { ...AMEND_ORDER, shareToken: null }, items: AMEND_ITEMS }));
    expect(t).not.toContain('/o/');
    expect(t).not.toContain('undefined');
  });
});
