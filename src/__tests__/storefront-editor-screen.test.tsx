import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';
import { Dimensions, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// Forces the wide (two-column) layout, where ContentDrawer renders inline
// rather than behind the phone sheet -- the narrow layout is a presentation
// detail (property 5), not one of this test file's properties.
Dimensions.set({
  window: { width: 1024, height: 800, scale: 1, fontScale: 1 },
  screen: { width: 1024, height: 800, scale: 1, fontScale: 1 },
});

// Lives here rather than beside the screen ON PURPOSE -- see
// inventory-caveats.test.tsx: expo-router builds its route table from
// `require.context(src/app)`, and nothing on that scan skips `.test.tsx`. A
// test file under src/app would become a real route shipped in the bundle.

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/storefront-admin');
jest.mock('@/lib/storefront', () => ({
  getPublicStorefrontProducts: jest.fn().mockResolvedValue([]),
  waLink: (e: string, m: string) => `https://wa.me/${e.replace(/^\+/, '')}?text=${encodeURIComponent(m)}`,
}));
// `useAuth()` throws outside an `<AuthProvider>` (src/hooks/use-auth.tsx),
// and this screen owns no fetch of its own for WHICH shop it is editing --
// that comes from context, same as every other (admin) route. Mocked as a
// jest.fn so individual tests can override `locations` (e.g. to prove the
// preview's city comes from the primary location) without disturbing the
// rest.
jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(() => ({ shop: { id: 's1', name: 'Xamdi Electronics' }, locations: [] })),
}));

import { useAuth } from '@/hooks/use-auth';
import {
  discardDraft,
  ensureStorefront,
  getMyStorefront,
  publishDraft,
  saveDraft,
} from '@/lib/storefront-admin';
import StorefrontEditor from '@/app/(admin)/storefront';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

// ScreenHeader (used by every non-tab (admin) route, including this one)
// calls useSafeAreaInsets(), which throws outside a provider -- unlike
// SafeAreaView the component, the hook has no built-in fallback.
const INITIAL_METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

async function renderScreen(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(
      <SafeAreaProvider initialMetrics={INITIAL_METRICS}>
        <StorefrontEditor />
      </SafeAreaProvider>,
    );
  });
  return tree!;
}

const BASE = {
  shopId: 's1', slug: 'xamdi', whatsappE164: '+252634456789',
  theme: 'market' as const, palette: 'ink' as const,
  headline: 'Everything for the house and the phone.', about: null,
  heroImageUrl: null, offersDelivery: false, publishedAt: null,
  draft: null,
};

describe('storefront editor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    // Reinstated every test -- `mockReturnValue` (unlike `mockReturnValueOnce`)
    // survives `clearAllMocks()`, so the city test's override would otherwise
    // leak into whichever test runs after it.
    (useAuth as jest.Mock).mockReturnValue({ shop: { id: 's1', name: 'Xamdi Electronics' }, locations: [] });
  });

  afterEach(() => {
    // Uninstalls the fake timer implementation, which discards any autosave
    // timer a test left pending rather than letting it fire against an
    // unmounted tree in a later test.
    jest.useRealTimers();
  });

  it('previews the real page, not a mock of it', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    const tree = await renderScreen();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts.join(' ')).toContain('Everything for the house and the phone.');
  });

  it('turns a module error into the upgrade prompt rather than throwing', async () => {
    const err = Object.assign(new Error('module_not_included'), {
      message: 'module_not_included',
      details: JSON.stringify({ module: 'storefront' }),
    });
    (getMyStorefront as jest.Mock).mockResolvedValue(null);
    (ensureStorefront as jest.Mock).mockRejectedValue(err);
    const tree = await renderScreen();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts.join(' ')).toMatch(/plan|upgrade/i);
  });

  // Property 5: on load, the editor shows the draft overlaid on the live
  // values -- that IS what "your unsaved changes" means. A headline staged
  // in the server-side draft from a previous, interrupted session must win
  // over the live (last published) headline the moment the editor opens,
  // with no edit required to surface it.
  it('shows a leftover draft overlaid on the live values on load', async () => {
    const row = { ...BASE, headline: 'Live headline', draft: { headline: 'Half-written headline' } };
    (getMyStorefront as jest.Mock).mockResolvedValue(row);
    (ensureStorefront as jest.Mock).mockResolvedValue(row);
    const tree = await renderScreen();

    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toContain('Half-written headline');
    expect(texts).not.toContain('Live headline');
  });

  // Property 2/4: the preview reflects an edit immediately, and that must
  // not itself be a publish -- typing a headline is staging, not shipping.
  it('reaches the preview with an unsaved edit, without publishing it', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    const tree = await renderScreen();

    const headlineInput = tree.root
      .findAllByType(TextInput)
      .find((node) => node.props.placeholder === 'What should a customer see first?');
    expect(headlineInput).toBeDefined();

    await act(async () => {
      headlineInput!.props.onChangeText('Fresh produce, delivered daily.');
    });

    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts.join(' ')).toContain('Fresh produce, delivered daily.');
    expect(publishDraft).not.toHaveBeenCalled();
  });

  // Property 4: the editor autosaves into the draft on a debounce. Losing
  // the network or navigating away right after typing must cost nothing --
  // which only holds if the edit actually reaches saveDraft once the
  // shopkeeper pauses, not only once they press Publish.
  it('autosaves an edit into the draft after a pause, without publishing', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    (saveDraft as jest.Mock).mockResolvedValue(undefined);
    const tree = await renderScreen();

    const headlineInput = tree.root
      .findAllByType(TextInput)
      .find((node) => node.props.placeholder === 'What should a customer see first?');

    await act(async () => {
      headlineInput!.props.onChangeText('Fresh produce, delivered daily.');
    });
    expect(saveDraft).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveDraft).toHaveBeenCalledWith('s1', { headline: 'Fresh produce, delivered daily.' });
    expect(publishDraft).not.toHaveBeenCalled();
  });

  // Property 7: discarding a draft is possible and returns the editor to the
  // live page.
  it('discards a leftover draft back to the live page', async () => {
    const row = { ...BASE, headline: 'Live headline', draft: { headline: 'Half-written headline' } };
    (getMyStorefront as jest.Mock).mockResolvedValueOnce(row).mockResolvedValueOnce({ ...BASE, headline: 'Live headline', draft: null });
    (ensureStorefront as jest.Mock).mockResolvedValue(row);
    (discardDraft as jest.Mock).mockResolvedValue(undefined);
    const tree = await renderScreen();

    expect(textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ')).toContain('Half-written headline');

    // RN 0.86's `Pressable` is `React.memo(...)`, and React 19's
    // react-test-renderer collapses a memo's fiber `.type` to the inner
    // function, so `node.type === Pressable` silently matches zero nodes --
    // see search-row.test.tsx. Duck-type on the testID prop instead.
    const discardButton = tree.root.findAll(
      (node) => node.props.testID === 'storefront-discard-draft',
    )[0];
    expect(discardButton).toBeDefined();

    await act(async () => {
      discardButton.props.onPress();
    });

    expect(discardDraft).toHaveBeenCalledWith('s1');
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toContain('Live headline');
    expect(texts).not.toContain('Half-written headline');
  });

  // The preview IS the real page (this file's opening test), and
  // get_public_storefront left-joins shop_locations on is_primary to fill in
  // `city` (supabase/migrations/20260924000100_storefront_public_read.sql).
  // The preview must derive it the same way -- from the primary location --
  // rather than hardcoding it away.
  it('shows the primary location city in the preview, like the live page does', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      shop: { id: 's1', name: 'Xamdi Electronics' },
      locations: [
        {
          id: 'loc-1', shopId: 's1', name: 'Branch', code: null,
          city: 'Berbera', neighborhood: null, address: null, contactPhone: null,
          openingHours: {}, monthlyRevenueGoalCents: null,
          barcodeScanningEnabled: true, hardwareScannerEnabled: false,
          zaadMerchantId: null, edahabMerchantId: null, requireOpenRegister: false,
          isPrimary: false, active: true, createdAt: '2026-01-01', updatedAt: '2026-01-01',
        },
        {
          id: 'loc-2', shopId: 's1', name: 'Main', code: null,
          city: 'Hargeisa', neighborhood: null, address: null, contactPhone: null,
          openingHours: {}, monthlyRevenueGoalCents: null,
          barcodeScanningEnabled: true, hardwareScannerEnabled: false,
          zaadMerchantId: null, edahabMerchantId: null, requireOpenRegister: false,
          isPrimary: true, active: true, createdAt: '2026-01-01', updatedAt: '2026-01-01',
        },
      ],
    });
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    const tree = await renderScreen();

    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts.join(' ')).toContain('Hargeisa');
    expect(texts.join(' ')).not.toContain('Berbera');
  });
});
