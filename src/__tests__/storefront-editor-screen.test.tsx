import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';
import { AccessibilityInfo, type EmitterSubscription, Dimensions, Text, TextInput } from 'react-native';
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
// The screen (and ScreenHeader inside it) navigates for real. Only the router
// is replaced -- everything else expo-router exports is left actual, so this
// stays a test of the screen rather than of a stubbed module.
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => false }),
}));
// The flyer panel's offer picker reads the shop's promotions. Mocked rather
// than left to the real module, which would reach the (empty) supabase mock
// above inside a Promise.allSettled and fail silently -- a test asserting
// "the picker is not offered" would then pass for the wrong reason.
jest.mock('@/lib/promotions', () => ({
  listPromotions: jest.fn(async () => []),
  discountLabel: jest.requireActual('@/lib/promotions').discountLabel,
  scopeLabel: jest.requireActual('@/lib/promotions').scopeLabel,
}));
// `useAuth()` throws outside an `<AuthProvider>` (src/hooks/use-auth.tsx),
// and this screen owns no fetch of its own for WHICH shop it is editing --
// that comes from context, same as every other (admin) route. Mocked as a
// jest.fn so individual tests can override `locations` (e.g. to prove the
// preview's city comes from the primary location) without disturbing the
// rest.
jest.mock('@/hooks/use-auth', () => ({
  // hasModule is part of the contract this screen reads (Task 5 gates the
  // flyer panel's OFFER picker on `promotions`) -- returning true keeps every
  // test in this file about the editor rather than about entitlements.
  useAuth: jest.fn(() => ({ shop: { id: 's1', name: 'Xamdi Electronics' }, locations: [], hasModule: () => true })),
}));

// The wide layout's preview renders StorefrontView -> ThemeMarket, which
// mounts FlyerCarousel even with no flyers (its hooks run unconditionally);
// Task 4's mount effect calls AccessibilityInfo.isReduceMotionEnabled().
// Nothing here is about motion.
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

import { useAuth } from '@/hooks/use-auth';
import { listPromotions } from '@/lib/promotions';
import { ContentDrawer } from '@/components/storefront/editor/content-drawer';
import {
  countOnlineProducts,
  discardDraft,
  publishBlockers,
  ensureStorefront,
  getMyStorefront,
  getStorefrontPreviewProducts,
  listFlyers,
  publishDraft,
  saveDraft,
  setAutoAdvance,
  checkSlug,
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

// The pressable a Caveat draws for its action, found by the words on it.
// Throws when no caveat offers that label, which is the point: an action that
// was never rendered cannot be pressed.
function caveatAction(tree: ReactTestRenderer, label: string) {
  const match = tree.root
    .findAll((node) => node.props?.accessibilityRole === 'link' && typeof node.props?.onPress === 'function')
    .find((node) =>
      node
        .findAllByType(Text)
        .some((t) => (Array.isArray(t.props.children) ? t.props.children : [t.props.children]).includes(label))
    );
  if (!match) throw new Error(`no caveat offers the action "${label}"`);
  return match;
}

const BASE = {
  shopId: 's1', slug: 'xamdi', whatsappE164: '+252634456789',
  theme: 'market' as const, palette: 'ink' as const,
  headline: 'Everything for the house and the phone.', about: null,
  heroImageUrl: null, offersDelivery: false, publishedAt: null,
  firstPublishedAt: null,
  autoAdvance: false,
  draft: null,
};

const SOLAR_PROMOTION = {
  id: 'promo-solar', shopId: 's1', locationId: null, name: '20% off solar',
  discountType: 'percentage' as const, discountValue: 20,
  scope: 'category' as const, scopeValue: 'Solar',
  active: true, startsAt: null, endsAt: null, autoApply: true,
  archivedAt: null, createdAt: '2026-08-01T00:00:00.000Z',
};

const LIVE_FLYER = {
  id: 'fly-1', imagePath: 'https://cdn.example/solar.jpg',
  headline: 'Solar week', subline: null,
  linkKind: 'none' as const, linkValue: null,
  position: 0, draft: false, promotionId: null,
};

describe('storefront editor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    // Reinstated every test -- `mockReturnValue` (unlike `mockReturnValueOnce`)
    // survives `clearAllMocks()`, so the city test's override would otherwise
    // leak into whichever test runs after it.
    (useAuth as jest.Mock).mockReturnValue({ shop: { id: 's1', name: 'Xamdi Electronics' }, locations: [], hasModule: () => true });
    // Every test renders the preview, which now fetches admin-side (B3) --
    // default to empty so a test that doesn't care about products isn't
    // left with an unresolved automock jest.fn() (undefined has no .then).
    (getStorefrontPreviewProducts as jest.Mock).mockResolvedValue([]);
    (listFlyers as jest.Mock).mockResolvedValue([]);
    (listPromotions as jest.Mock).mockResolvedValue([]);
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

  // A verdict that lands after the shopkeeper has typed on is a verdict about
  // a string that is no longer in the field, and clearTimeout cannot stop it:
  // by then the timer has already fired and checkSlug is in flight.
  //
  // This is not cosmetic staleness. ContentDrawer freezes a collision base off
  // the CURRENT value.slug the moment it sees 'taken', so a late 'taken' for
  // "xamdi-a" arriving while the field reads "xamdi-electronics" would freeze
  // the longer value as the base and open a suffix field beneath it -- walking
  // the shop into appending to an address nothing ever said was taken.
  it('ignores an availability verdict for a slug the shopkeeper has already typed past', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);

    let resolveFirst: ((value: string) => void) | undefined;
    (checkSlug as jest.Mock).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
    );

    const tree = await renderScreen();
    const slugInput = tree.root.findAll((n) => n.props?.testID === 'content-drawer-slug-input')[0];
    expect(slugInput).toBeDefined();

    // Types one address and waits for the check to actually be in flight.
    await act(async () => { slugInput.props.onChangeText('xamdi-a'); });
    await act(async () => { jest.advanceTimersByTime(500); await Promise.resolve(); });
    expect(checkSlug).toHaveBeenCalledWith('xamdi-a');
    expect(resolveFirst).toBeDefined();

    // ...then types on, before that first answer comes back.
    await act(async () => { slugInput.props.onChangeText('xamdi-electronics'); });

    // The stale answer lands. It was about 'xamdi-a', not what is on screen.
    await act(async () => { resolveFirst!('taken'); await Promise.resolve(); });

    // No suffix field, and no frozen base: the shop was never told the address
    // it is actually holding is taken.
    expect(tree.root.findAll((n) => n.props?.testID === 'content-drawer-suffix-input')).toHaveLength(0);
    expect(tree.root.findAll((n) => n.props?.testID === 'content-drawer-slug-base')).toHaveLength(0);
  });

  // B1: a shop must never be told it published something it did not.
  // handlePublish flushes the last keystroke first; if that flush fails, the
  // edit is stuck client-side only (flushAutosave re-queued it), so
  // publishing anyway would ship an older draft and refetch it as truth --
  // the shop would see "published" while its last edit sat nowhere durable.
  it('refuses to publish when the last edit fails to save, and says why', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    (countOnlineProducts as jest.Mock).mockResolvedValue(3);
    (saveDraft as jest.Mock).mockRejectedValue(new Error('network down'));
    const tree = await renderScreen();

    const headlineInput = tree.root
      .findAllByType(TextInput)
      .find((node) => node.props.placeholder === 'What should a customer see first?');
    await act(async () => {
      headlineInput!.props.onChangeText('Last-second edit');
    });

    const publishButton = tree.root.findAll((node) => node.props.testID === 'publish-bar-publish')[0];
    await act(async () => {
      publishButton.props.onPress();
    });

    expect(saveDraft).toHaveBeenCalledWith('s1', { headline: 'Last-second edit' });
    expect(publishDraft).not.toHaveBeenCalled();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toMatch(/try again|could not/i);
  });

  // B2: Task 7b's whole justification for the debounce is "losing the
  // network or navigating away costs nothing" -- unmounting mid-debounce (a
  // shopkeeper backing out of the screen right after typing) must flush the
  // pending patch, not cancel it. cancelPendingAutosave stays reserved for
  // the deliberate discard path, covered separately below.
  it('flushes a pending edit on unmount instead of dropping it', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    (saveDraft as jest.Mock).mockResolvedValue(undefined);
    const tree = await renderScreen();

    const headlineInput = tree.root
      .findAllByType(TextInput)
      .find((node) => node.props.placeholder === 'What should a customer see first?');
    await act(async () => {
      headlineInput!.props.onChangeText('Typed right before navigating away');
    });
    expect(saveDraft).not.toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });

    expect(saveDraft).toHaveBeenCalledWith('s1', { headline: 'Typed right before navigating away' });
  });

  // B3: get_public_storefront_products (the RPC a customer's browser calls)
  // deliberately returns nothing until published_at is set -- exactly right
  // for a customer, wrong for this screen's own preview, which exists to
  // show a shop what its page will look like on its FIRST publish. A shop
  // that has never published (BASE.publishedAt is null) with real products
  // marked to sell online must still see them in the preview.
  it('shows real products in the preview for a shop that has never published', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    (getStorefrontPreviewProducts as jest.Mock).mockResolvedValue([
      { id: 'p1', name: 'Roasted coffee beans', description: null, category: null, priceCents: 1200, stock: 5, imageUrl: null },
    ]);
    const tree = await renderScreen();

    expect(getStorefrontPreviewProducts).toHaveBeenCalledWith('s1');
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toContain('Roasted coffee beans');
  });

  // T3: "Chosen for you" must not resurface for a shop that has already
  // published once and later unpublished -- the plan's own wording is "once
  // a shop has published, it has chosen". publishedAt alone can't carry
  // this: unpublish sets it back to null. firstPublishedAt (set once, by
  // publish_storefront, never cleared) is the sticky signal.
  it('shows "Chosen for you" for a shop that has never published', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    const tree = await renderScreen();

    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toContain('Chosen for you');
  });

  it('does not resurface "Chosen for you" once a shop has ever published, even after unpublishing', async () => {
    const row = { ...BASE, publishedAt: null, firstPublishedAt: '2026-01-01T00:00:00.000Z' };
    (getMyStorefront as jest.Mock).mockResolvedValue(row);
    (ensureStorefront as jest.Mock).mockResolvedValue(row);
    const tree = await renderScreen();

    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).not.toContain('Chosen for you');
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
      hasModule: () => true,
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

  // Context 2: `promotions` is a MODULE entitlement (entitlements.ts:28,44).
  // A shop without it must still be able to add ANNOUNCEMENT flyers; only the
  // offer picker goes, and it has to SAY so rather than appearing broken or
  // absent.
  it('keeps the flyer panel for a shop without the promotions module, minus the offer picker', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      shop: { id: 's1', name: 'Xamdi Electronics' },
      locations: [],
      hasModule: (module: string) => module !== 'promotions',
    });
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    const tree = await renderScreen();

    // The panel itself is still there -- announcement flyers keep working.
    expect(tree.root.findAll((node) => node.props?.testID === 'flyer-editor-add').length).toBeGreaterThan(0);
    // And the picker is never even asked for.
    expect(listPromotions).not.toHaveBeenCalled();

    await act(async () => {
      tree.root.findAll((node) => node.props?.testID === 'flyer-editor-add')[0].props.onPress();
    });
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toMatch(/needs Promotions/i);
    expect(texts).toMatch(/isn't included in your plan/i);
  });

  it('asks for the promotions the picker will offer when the module IS on', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    (listPromotions as jest.Mock).mockResolvedValue([SOLAR_PROMOTION]);
    await renderScreen();
    expect(listPromotions).toHaveBeenCalledWith('s1');
  });

  // The preview is the customer's page, not the editor's list: a draft flyer
  // is deliberately not on it, and neither is a flyer whose offer has ended
  // (20260930000100 -- "the panel goes", because the offer is also in the
  // JPEG, which nothing here can edit).
  it('previews only the flyers a customer would actually see', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    (listPromotions as jest.Mock).mockResolvedValue([
      { ...SOLAR_PROMOTION, id: 'promo-over', name: 'Finished', active: false },
    ]);
    (listFlyers as jest.Mock).mockResolvedValue([
      LIVE_FLYER,
      { ...LIVE_FLYER, id: 'fly-2', headline: 'Next week', draft: true, position: 1 },
      { ...LIVE_FLYER, id: 'fly-3', headline: 'Offer that ended', promotionId: 'promo-over', position: 2 },
    ]);
    const tree = await renderScreen();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');

    // All three are in the shop's own list...
    expect(tree.root.findAll((node) => node.props?.testID === 'flyer-editor-row-fly-2').length).toBeGreaterThan(0);
    expect(tree.root.findAll((node) => node.props?.testID === 'flyer-editor-row-fly-3').length).toBeGreaterThan(0);
    // ...and the live, still-running one is the only one the preview carries.
    // ('Next week' and 'Offer that ended' appear once each, in the editor row;
    // 'Solar week' appears twice -- once in the row, once in the preview.)
    expect(texts.split('Solar week').length - 1).toBe(2);
    expect(texts.split('Next week').length - 1).toBe(1);
    expect(texts.split('Offer that ended').length - 1).toBe(1);
  });

  // Requirement 8: auto_advance had a column and a public read but no
  // control. The switch writes it LIVE, because publish_storefront copies a
  // fixed list of draft keys and auto_advance is not one of them.
  it('writes auto-advance straight to the live column rather than staging it in the draft', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    (setAutoAdvance as jest.Mock).mockResolvedValue(undefined);
    const tree = await renderScreen();

    await act(async () => {
      tree.root.findAll((node) => node.props?.testID === 'flyer-editor-auto-advance')[0].props.onValueChange(true);
    });

    expect(setAutoAdvance).toHaveBeenCalledWith('s1', true);
    expect(saveDraft).not.toHaveBeenCalledWith('s1', expect.objectContaining({ autoAdvance: true }));
  });

  // A `wrong` caveat whose action does nothing is the failure caveat.tsx's own
  // header names. `no_products` cannot be fixed on this screen -- the fix is a
  // product marked to sell online, added in Inventory -- so the action has to
  // take the shopkeeper there, and the assertion is the navigation itself.
  it('takes the no-products blocker to Inventory when its action is pressed', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    (publishBlockers as jest.Mock).mockReturnValue(['no_products']);
    const tree = await renderScreen();

    const action = caveatAction(tree, 'Go to Inventory');
    await act(async () => {
      action.props.onPress();
    });

    expect(mockPush).toHaveBeenCalledWith('/inventory');
    // And it did not quietly publish an unpublishable page on the way.
    expect(publishDraft).not.toHaveBeenCalled();
  });

  // The other two blockers are fixed by a field in this drawer, and must keep
  // jumping to it rather than being swept into the new navigation.
  it.each([
    ['no_slug', 'slug'],
    ['no_whatsapp', 'whatsapp'],
  ])('focuses the %s field rather than navigating', async (blocker, field) => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    (publishBlockers as jest.Mock).mockReturnValue([blocker]);
    const tree = await renderScreen();

    expect(tree.root.findByType(ContentDrawer).props.focusRequest).toBeNull();

    const action = caveatAction(tree, 'Fix this');
    await act(async () => {
      action.props.onPress();
    });

    expect(tree.root.findByType(ContentDrawer).props.focusRequest).toEqual(
      expect.objectContaining({ field })
    );
    expect(mockPush).not.toHaveBeenCalled();
  });
});
