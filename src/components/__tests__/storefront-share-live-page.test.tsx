import fs from 'node:fs';
import path from 'node:path';

import type { ComponentProps } from 'react';
import { act, create } from 'react-test-renderer';

import { ContentDrawer, type ContentDrawerValue } from '@/components/storefront/editor/content-drawer';
import { PublishBar } from '@/components/storefront/editor/publish-bar';
import { copyText } from '@/lib/copy-text';
import { openExternalUrl } from '@/lib/external-url';
import { APP_DOMAIN, slugFromHostname, storefrontPath } from '@/lib/storefront-host';
import { shareOnWhatsApp } from '@/lib/whatsapp';

// The two seams this file is about, mocked at the module boundary on purpose:
// a second copy-to-clipboard implementation pasted into publish-bar.tsx, or a
// hand-rolled `wa.me` string, would BOTH still behave correctly on screen and
// would both fail here. That is the whole point -- the requirement is that
// these two callers share one implementation, not merely that each works.
jest.mock('@/lib/copy-text', () => ({ copyText: jest.fn() }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));
// A SPY over the real module, not a stub: shareOnWhatsApp still builds the
// link for real (through whatsappLink and openWhatsApp), so the URL asserted
// below is the one production would open -- while the spy still proves the
// button went through the shared helper rather than around it.
jest.mock('@/lib/whatsapp', () => {
  const actual = jest.requireActual('@/lib/whatsapp');
  return { ...actual, shareOnWhatsApp: jest.fn(actual.shareOnWhatsApp) };
});

const SLUG = 'xamdi-electronics';
const ADDRESS = `${SLUG}.${APP_DOMAIN}`;
const SHOP_NAME = 'Xamdi Electronics';

type PublishBarProps = ComponentProps<typeof PublishBar>;

const DEFAULT_PROPS: PublishBarProps = {
  status: 'live',
  blockers: [],
  dirty: false,
  slug: SLUG,
  shopName: SHOP_NAME,
  onEdit: jest.fn(),
  onFocusBlocker: jest.fn(),
  onGoToInventory: jest.fn(),
  onTogglePreview: jest.fn(),
  onPublish: jest.fn(),
  onUnpublish: jest.fn(),
};

function renderBar(overrides: Partial<PublishBarProps> = {}) {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(<PublishBar {...DEFAULT_PROPS} {...overrides} />);
  });
  return tree!;
}

function nodes(tree: ReturnType<typeof create>, testID: string) {
  return tree.root.findAll((node) => node.props?.testID === testID);
}

function has(tree: ReturnType<typeof create>, testID: string): boolean {
  return nodes(tree, testID).length > 0;
}

// The rendered text of one testID'd node, joined -- an address split across
// two children (`{slug}{'.' + APP_DOMAIN}`) still reads as one string, which
// is how a shopkeeper reads it off the screen.
function textOf(tree: ReturnType<typeof create>, testID: string): string {
  const found = nodes(tree, testID);
  if (found.length === 0) throw new Error(`no node with testID "${testID}"`);
  const out: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === 'string') out.push(child);
    else if (typeof child === 'number') out.push(String(child));
    else if (Array.isArray(child)) child.forEach(walk);
    // A Pressable's label is a <Text> element inside it, not a string on it.
    else if (child && typeof child === 'object' && 'props' in child) {
      walk((child as { props?: { children?: unknown } }).props?.children);
    }
  };
  walk(found[found.length - 1].props.children);
  return out.join('');
}

function press(tree: ReturnType<typeof create>, testID: string) {
  const found = nodes(tree, testID);
  if (found.length === 0) throw new Error(`no node with testID "${testID}"`);
  act(() => {
    found[0].props.onPress();
  });
}

async function pressAsync(tree: ReturnType<typeof create>, testID: string) {
  const found = nodes(tree, testID);
  if (found.length === 0) throw new Error(`no node with testID "${testID}"`);
  await act(async () => {
    await found[0].props.onPress();
  });
}

// Every whitespace-separated word of a message, stripped of the punctuation a
// sentence puts around a hostname, that ends in the app domain. Used to pull
// the address back OUT of the WhatsApp message and put it through the router's
// own parser -- a message carrying `kaiibi.com/xamdi-electronics` yields a
// token slugFromHostname refuses, which is exactly the failure being guarded.
function hostsIn(message: string): string[] {
  return message
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-z0-9]+/i, '').replace(/[^a-z0-9]+$/i, ''))
    .filter((word) => word.toLowerCase().endsWith(APP_DOMAIN));
}

describe('sharing a live page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (copyText as jest.Mock).mockResolvedValue(true);
  });

  it('offers the address and both ways to send it once the page is live', () => {
    const tree = renderBar({ status: 'live' });
    expect(has(tree, 'publish-bar-address')).toBe(true);
    expect(has(tree, 'publish-bar-copy-link')).toBe(true);
    expect(has(tree, 'publish-bar-share-whatsapp')).toBe(true);
  });

  // A draft page has no working address. Offering to share it hands a
  // shopkeeper a link that 404s -- the same class of mistake as the
  // `kaiibi.com/<slug>` path form this screen already shipped once.
  it('offers nothing to share while the page is only a draft', () => {
    const tree = renderBar({ status: 'draft' });
    expect(has(tree, 'publish-bar-address')).toBe(false);
    expect(has(tree, 'publish-bar-copy-link')).toBe(false);
    expect(has(tree, 'publish-bar-share-whatsapp')).toBe(false);
  });

  // Unsaved edits do not take a published page down -- the address still
  // resolves, so the share controls stay. Gating them on `dirty` would take
  // the link away from a shop mid-edit for no reason.
  it('keeps the share controls up while a live page has unsaved edits', () => {
    const tree = renderBar({ status: 'live', dirty: true });
    expect(has(tree, 'publish-bar-copy-link')).toBe(true);
  });

  it('shows nothing to share when a live page somehow has no address', () => {
    const tree = renderBar({ status: 'live', slug: null });
    expect(has(tree, 'publish-bar-address')).toBe(false);
    expect(has(tree, 'publish-bar-share-whatsapp')).toBe(false);
  });

  // The address is a SUBDOMAIN. Asserting it against the router's own parser
  // -- the function that decides which shop a hostname resolves to -- is what
  // stops the two drifting: `kaiibi.com/<slug>` parses to null here.
  it('shows the subdomain form, and one the router actually resolves', () => {
    const shown = textOf(renderBar({ status: 'live' }), 'publish-bar-address');
    expect(shown).toBe(ADDRESS);
    expect(slugFromHostname(shown)).toBe(SLUG);
  });

  // THE WHOLE CHAIN, END TO END: the address a shop reads on screen and prints
  // on a card -> the parser that decides which shop a hostname is ->
  // the path the app redirects that shop's visitor to -> the route file that
  // has to exist for the page to render at all.
  //
  // Each link was already covered somewhere; NONE of them was pinned to the
  // next. That is precisely how the segment rename could ship broken: the
  // parser and the redirect could agree on `/store/` while `src/app/store/`
  // was never created, and every test above would still pass while a customer
  // got "no shop at this address". The filesystem is the only assertion here
  // that cannot be satisfied by restating a constant.
  it('resolves, end to end, to a route file that actually exists', () => {
    const shown = textOf(renderBar({ status: 'live' }), 'publish-bar-address');

    const slug = slugFromHostname(shown);
    expect(slug).toBe(SLUG);

    const servedPath = storefrontPath(slug!);
    expect(servedPath.endsWith(`/${slug}`)).toBe(true);

    const segment = servedPath.split('/').filter(Boolean)[0];
    const routeFile = path.join(__dirname, '..', '..', 'app', segment, '[slug].tsx');
    expect(fs.existsSync(routeFile)).toBe(true);
  });

  it('sends the address to WhatsApp through the shared helper', () => {
    const tree = renderBar({ status: 'live' });
    press(tree, 'publish-bar-share-whatsapp');

    expect(shareOnWhatsApp).toHaveBeenCalledTimes(1);
    const message = (shareOnWhatsApp as jest.Mock).mock.calls[0][0] as string;

    // Carries the address, in the form the router resolves.
    expect(hostsIn(message).map((host) => slugFromHostname(host))).toEqual([SLUG]);
    // ...and names the shop, because a forwarded message has no other context.
    expect(message).toContain(SHOP_NAME);
    // The link that actually opens is the one whatsapp.ts builds, not a
    // string this component assembled itself.
    expect(openExternalUrl).toHaveBeenCalledWith(`https://wa.me/?text=${encodeURIComponent(message)}`);
  });

  it('copies the address through the shared copy helper', async () => {
    const tree = renderBar({ status: 'live' });
    await pressAsync(tree, 'publish-bar-copy-link');
    expect(copyText).toHaveBeenCalledWith(ADDRESS);
  });

  it('says so when the copy worked', async () => {
    const tree = renderBar({ status: 'live' });
    expect(textOf(tree, 'publish-bar-copy-link')).toBe('Copy link');
    await pressAsync(tree, 'publish-bar-copy-link');
    expect(textOf(tree, 'publish-bar-copy-link')).toBe('Copied');
  });

  it('says plainly when the copy failed, with the address still on screen', async () => {
    (copyText as jest.Mock).mockResolvedValue(false);
    const tree = renderBar({ status: 'live' });
    await pressAsync(tree, 'publish-bar-copy-link');
    expect(textOf(tree, 'publish-bar-copy-link')).toBe('Copy link');
    expect(textOf(tree, 'publish-bar-address')).toBe(ADDRESS);
  });
});

// The other caller. One implementation, two buttons -- the drawer's Copy link
// must go through the same helper, or the extraction did not happen.
describe('the content drawer copy button', () => {
  const VALUE: ContentDrawerValue = {
    slug: SLUG,
    headline: '',
    about: '',
    heroImageUrl: null,
    whatsappE164: null,
  };

  it('copies through the same shared helper', async () => {
    jest.clearAllMocks();
    (copyText as jest.Mock).mockResolvedValue(true);
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(
        <ContentDrawer
          value={VALUE}
          onChange={jest.fn()}
          onClaimSlug={jest.fn()}
          slugState="idle"
          shopName={SHOP_NAME}
          claimedSlug={SLUG}
        />
      );
    });
    await pressAsync(tree!, 'content-drawer-copy-address');
    expect(copyText).toHaveBeenCalledWith(ADDRESS);
  });
});
