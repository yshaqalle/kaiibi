import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { EmailButton, WhatsAppButton } from '@/components/platform/whatsapp-button';
import { openExternalUrl } from '@/lib/external-url';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));

const openMock = openExternalUrl as jest.MockedFunction<typeof openExternalUrl>;
beforeEach(() => openMock.mockReset());

function render(element: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
}

// By handler rather than by component type: Pressable renders through a
// forwardRef whose identity findAllByType does not match under this preset --
// the same reason support-tab.test.tsx presses by onPress.
function buttons(tree: ReactTestRenderer) {
  return tree.root.findAll((node) => typeof node.props.onPress === 'function');
}

describe('WhatsAppButton', () => {
  it('opens a chat with the number normalised and the message written', () => {
    const tree = render(<WhatsAppButton phone="063 441 8820" message="Hi Faadumo" label="WhatsApp Faadumo" />);
    act(() => buttons(tree)[0].props.onPress());
    expect(openMock).toHaveBeenCalledWith('https://wa.me/252634418820?text=Hi%20Faadumo');
  });

  // Offering to message someone whose number cannot be dialled is a worse
  // answer than not offering -- so the button is absent, not disabled.
  it('renders nothing at all when there is no number', () => {
    const tree = render(<WhatsAppButton phone={null} message="Hi" label="WhatsApp" />);
    expect(buttons(tree)).toHaveLength(0);
  });

  it('renders nothing when the number is too short to dial', () => {
    const tree = render(<WhatsAppButton phone="0634" message="Hi" label="WhatsApp" />);
    expect(buttons(tree)).toHaveLength(0);
  });

  // The word removed from the screen has to still be there for a screen reader.
  it('carries the person it reaches in its accessibility label', () => {
    const tree = render(<WhatsAppButton phone="0634418820" message="Hi" label="WhatsApp Faadumo Cabdi" />);
    expect(buttons(tree)[0].props['aria-label']).toBe('WhatsApp Faadumo Cabdi');
  });
});

describe('EmailButton', () => {
  it('opens a mail composer', () => {
    const tree = render(<EmailButton email="faadumo@hooyo.so" label="Email Faadumo" />);
    act(() => buttons(tree)[0].props.onPress());
    expect(openMock).toHaveBeenCalledWith('mailto:faadumo@hooyo.so');
  });

  it('renders nothing without an address', () => {
    const tree = render(<EmailButton email={null} label="Email" />);
    expect(buttons(tree)).toHaveLength(0);
  });
});
