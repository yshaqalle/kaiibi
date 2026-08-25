import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { DeliveryEditor } from '@/components/storefront/editor/delivery-editor';
import type { DeliveryArea } from '@/lib/storefront-admin';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

// Not a spec -- a harness, same shape as ContentDrawer's renderDrawer. Wires
// the flat shape each assertion wants onto the real
// <DeliveryEditor offersDelivery areas onToggle onSave onDelete /> props.
// onSave/onDelete are awaited by the component itself (B4) so both default
// to a resolved promise here, the same as any other write that is expected
// to succeed.
function renderEditor(overrides: {
  offersDelivery: boolean;
  areas: DeliveryArea[];
  onToggle?: (value: boolean) => void;
  onSave?: (area: { id?: string; name: string; feeCents: number; sortOrder: number }) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}): string[] {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(
      <DeliveryEditor
        offersDelivery={overrides.offersDelivery}
        areas={overrides.areas}
        onToggle={overrides.onToggle ?? jest.fn()}
        onSave={overrides.onSave ?? jest.fn().mockResolvedValue(undefined)}
        onDelete={overrides.onDelete ?? jest.fn().mockResolvedValue(undefined)}
      />
    );
  });
  return textsIn(tree!.toJSON() as ReactTestRendererJSON);
}

describe('DeliveryEditor', () => {
  it('hides the area list entirely when delivery is off', () => {
    const texts = renderEditor({
      offersDelivery: false,
      areas: [{ id: '1', name: 'Ahmed Dhagah', feeCents: 100, sortOrder: 0 }],
    });
    expect(texts).not.toContain('Ahmed Dhagah');
  });

  it('shows a zero fee as free rather than as blank', () => {
    const texts = renderEditor({
      offersDelivery: true,
      areas: [{ id: '1', name: 'Ahmed Dhagah', feeCents: 0, sortOrder: 0 }],
    });
    expect(texts.join(' ')).toMatch(/\$0\.00|Free/);
  });

  it('warns when delivery is on with nowhere to deliver to', () => {
    expect(renderEditor({ offersDelivery: true, areas: [] }).join(' ')).toMatch(/add.*area|nowhere|no areas/i);
  });

  // Property 3: a negative fee is impossible to enter, not merely rejected by
  // the DB CHECK. Typing a minus sign into the add-area fee field must never
  // produce a negative feeCents -- and the "-" character itself must not
  // survive being typed, which is why "-5.00" becomes 500 (the digits, sign
  // dropped) rather than 0 (the sign reaching toCents and getting clamped).
  it('never saves a negative fee no matter what is typed', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(
        <DeliveryEditor offersDelivery areas={[]} onToggle={jest.fn()} onSave={onSave} onDelete={jest.fn().mockResolvedValue(undefined)} />
      );
    });

    const nameInput = tree!.root.findAll((node) => node.props?.testID === 'delivery-editor-add-name');
    const feeInput = tree!.root.findAll((node) => node.props?.testID === 'delivery-editor-add-fee');
    act(() => {
      nameInput[0].props.onChangeText('Outside town');
    });
    act(() => {
      // Typed as if the "-" key was actually pressed -- onChangeText fires
      // with the "-" already in the string, exactly like a real keystroke.
      feeInput[0].props.onChangeText('-5.00');
    });
    const addButton = tree!.root.findAll((node) => node.props?.testID === 'delivery-editor-add-button');
    await act(async () => {
      addButton[0].props.onPress();
    });

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Outside town' }));
    const call = onSave.mock.calls[0][0];
    expect(call.feeCents).toBeGreaterThanOrEqual(0);
  });

  // The point of the component: an existing area can be removed.
  it('removes an area through onDelete', async () => {
    const onDelete = jest.fn().mockResolvedValue(undefined);
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(
        <DeliveryEditor
          offersDelivery
          areas={[{ id: 'area-1', name: 'Ahmed Dhagah', feeCents: 500, sortOrder: 0 }]}
          onToggle={jest.fn()}
          onSave={jest.fn().mockResolvedValue(undefined)}
          onDelete={onDelete}
        />
      );
    });

    const deleteButton = tree!.root.findAll((node) => node.props?.testID === 'delivery-editor-delete-area-1');
    await act(async () => {
      deleteButton[0].props.onPress();
    });

    expect(onDelete).toHaveBeenCalledWith('area-1');
  });

  // Toggling delivery off and on again goes through onToggle, not local
  // state the caller can't see.
  it('toggles delivery through onToggle', () => {
    const onToggle = jest.fn();
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(
        <DeliveryEditor
          offersDelivery={false}
          areas={[]}
          onToggle={onToggle}
          onSave={jest.fn().mockResolvedValue(undefined)}
          onDelete={jest.fn().mockResolvedValue(undefined)}
        />
      );
    });

    const toggle = tree!.root.findAll((node) => node.props?.testID === 'delivery-editor-toggle');
    act(() => {
      toggle[0].props.onValueChange(true);
    });

    expect(onToggle).toHaveBeenCalledWith(true);
  });

  // B4: onSave's returned promise used to be dropped entirely (the prop was
  // typed `(area) => void`), so the `unique (shop_id, name)` violation
  // storefront-admin.ts deliberately lets surface (its own comment on
  // saveDeliveryArea) surfaced nowhere -- an unhandled rejection, and the
  // row just never appeared. A rejected save must now show a visible error,
  // and must not clear what the shopkeeper typed.
  it('shows a visible error when adding an area is rejected, and keeps what was typed', async () => {
    const onSave = jest.fn().mockRejectedValue(new Error('duplicate key value violates unique constraint'));
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(
        <DeliveryEditor offersDelivery areas={[]} onToggle={jest.fn()} onSave={onSave} onDelete={jest.fn().mockResolvedValue(undefined)} />
      );
    });

    const nameInput = tree!.root.findAll((node) => node.props?.testID === 'delivery-editor-add-name');
    act(() => {
      nameInput[0].props.onChangeText('Outside town');
    });
    const addButton = tree!.root.findAll((node) => node.props?.testID === 'delivery-editor-add-button');
    await act(async () => {
      addButton[0].props.onPress();
    });

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Outside town' }));
    const texts = textsIn(tree!.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toMatch(/could not save|error|try again/i);
    // The field was not cleared -- a shopkeeper who did not see a toast can
    // still see their own typed name still sitting there, unsaved.
    const nameInputAfter = tree!.root.findAll((node) => node.props?.testID === 'delivery-editor-add-name');
    expect(nameInputAfter[0].props.value).toBe('Outside town');
  });

  // Same failure mode on the delete path -- a rejected delete must also be
  // visible, not a row that silently stays (or silently vanishes from the
  // screen while still existing on the server).
  it('shows a visible error when deleting an area is rejected', async () => {
    const onDelete = jest.fn().mockRejectedValue(new Error('boom'));
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(
        <DeliveryEditor
          offersDelivery
          areas={[{ id: 'area-1', name: 'Ahmed Dhagah', feeCents: 500, sortOrder: 0 }]}
          onToggle={jest.fn()}
          onSave={jest.fn().mockResolvedValue(undefined)}
          onDelete={onDelete}
        />
      );
    });

    const deleteButton = tree!.root.findAll((node) => node.props?.testID === 'delivery-editor-delete-area-1');
    await act(async () => {
      deleteButton[0].props.onPress();
    });

    const texts = textsIn(tree!.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toMatch(/could not remove|error|try again/i);
  });
});
