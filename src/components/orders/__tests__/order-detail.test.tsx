import { act, create, type ReactTestInstance, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

import { OrderDetail } from '@/components/orders/order-detail';
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
  totalCents: 2400,
  createdAt: '2026-08-20T10:00:00.000Z',
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
        onClose={jest.fn()}
        onAccept={jest.fn()}
        onMarkReady={jest.fn()}
        onCancel={jest.fn()}
        onComplete={jest.fn()}
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
