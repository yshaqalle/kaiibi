import fs from 'node:fs';
import path from 'node:path';

import { act, create } from 'react-test-renderer';

import { ContentDrawer } from '@/components/storefront/editor/content-drawer';
import { PublishBar } from '@/components/storefront/editor/publish-bar';
import { copyText } from '@/lib/copy-text';
import { APP_DOMAIN, slugFromHostname, storefrontAddress, storefrontPath } from '@/lib/storefront-host';
import { shareOnWhatsApp } from '@/lib/whatsapp';

// THE BUG THIS FILE EXISTS FOR.
//
// Both editor surfaces built `<slug>.kaiibi.com` by hand, and no wildcard DNS
// record was ever created for it (docs/backlog/2026-08-27-storefront-wildcard-
// dns.md). `dig +short xamdi.kaiibi.com` returns nothing. So a shop published,
// pressed Copy link, sent the address to a customer, and the customer got a
// DNS failure -- while `kaiibi.com/store/<slug>`, which works, was never shown
// anywhere.
//
// The shape of the defect is DRIFT: two files each assembling the address, so
// a wrong answer could exist in two places at once and be fixed in only one.
// The property below is therefore not "the address is correct" -- it is that
// every surface emits the SAME string, and that the string is one the router
// serves. Restating the constant in each test would not have caught this; it
// is exactly what the old tests did.

jest.mock('@/lib/copy-text', () => ({ copyText: jest.fn() }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));
jest.mock('@/lib/whatsapp', () => {
  const actual = jest.requireActual('@/lib/whatsapp');
  return { ...actual, shareOnWhatsApp: jest.fn(actual.shareOnWhatsApp) };
});

const SLUG = 'xamdi-electronics';
const SHOP_NAME = 'Xamdi Electronics';

function nodes(tree: ReturnType<typeof create>, testID: string) {
  return tree.root.findAll((node) => node.props?.testID === testID);
}

// The rendered text of one testID'd node, joined with NO separator: an address
// split across adjacent text children is still one address on screen, and no
// address has a space in it.
function textOf(tree: ReturnType<typeof create>, testID: string): string {
  const found = nodes(tree, testID);
  if (found.length === 0) throw new Error(`no node with testID "${testID}"`);
  const out: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === 'string') out.push(child);
    else if (typeof child === 'number') out.push(String(child));
    else if (Array.isArray(child)) child.forEach(walk);
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

function renderBar() {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(
      <PublishBar
        status="live"
        blockers={[]}
        dirty={false}
        slug={SLUG}
        shopName={SHOP_NAME}
        onEdit={jest.fn()}
        onFocusBlocker={jest.fn()}
        onGoToInventory={jest.fn()}
        onTogglePreview={jest.fn()}
        onPublish={jest.fn()}
        onUnpublish={jest.fn()}
      />
    );
  });
  return tree!;
}

function renderDrawer() {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(
      <ContentDrawer
        value={{ slug: SLUG, headline: '', about: '', heroImageUrl: null, whatsappE164: null }}
        onChange={jest.fn()}
        onClaimSlug={jest.fn()}
        slugState="idle"
        shopName={SHOP_NAME}
        claimedSlug={SLUG}
      />
    );
  });
  return tree!;
}

// Pull the address back OUT of a sentence written for a human. A WhatsApp
// message is prose, so the address arrives with whatever punctuation the
// sentence puts around it -- this keeps every token that names the app domain,
// whichever form it is in, so a message carrying the WRONG form is still
// found and still compared rather than silently yielding nothing.
function addressesIn(message: string): string[] {
  return message
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-z0-9]+/i, '').replace(/[^a-z0-9/]+$/i, ''))
    .filter((word) => word.toLowerCase().includes(APP_DOMAIN));
}

// Every surface a shop can read, copy or send its own address from, collected
// through the real components rather than described.
async function everyAddressOnOffer(): Promise<Record<string, string>> {
  (copyText as jest.Mock).mockResolvedValue(true);

  const bar = renderBar();
  const barShown = textOf(bar, 'publish-bar-address');

  (copyText as jest.Mock).mockClear();
  await pressAsync(bar, 'publish-bar-copy-link');
  const barCopied = (copyText as jest.Mock).mock.calls[0][0] as string;

  (shareOnWhatsApp as jest.Mock).mockClear();
  press(bar, 'publish-bar-share-whatsapp');
  const message = (shareOnWhatsApp as jest.Mock).mock.calls[0][0] as string;
  const shared = addressesIn(message);
  expect(shared).toHaveLength(1);

  const drawer = renderDrawer();
  const drawerShown = textOf(drawer, 'content-drawer-claimed-address');

  (copyText as jest.Mock).mockClear();
  await pressAsync(drawer, 'content-drawer-copy-address');
  const drawerCopied = (copyText as jest.Mock).mock.calls[0][0] as string;

  return {
    'the publish bar shows': barShown,
    'the publish bar copies': barCopied,
    'the WhatsApp message carries': shared[0],
    'the content drawer shows': drawerShown,
    'the content drawer copies': drawerCopied,
  };
}

describe('a shop is told one address, and it is the one that works', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (copyText as jest.Mock).mockResolvedValue(true);
  });

  // DISPLAY, COPY AND SHARE CANNOT DRIFT. Asserted as one set rather than five
  // equalities against a constant: a constant can be edited to match a wrong
  // value, but five surfaces cannot disagree with each other and still pass.
  it('shows, copies and sends the same string from every surface', async () => {
    const offered = await everyAddressOnOffer();
    const distinct = Array.from(new Set(Object.values(offered)));
    expect({ distinct, offered }).toEqual({ distinct: [expect.any(String)], offered });
    expect(distinct).toHaveLength(1);
  });

  // ...and that one string is a URL the router actually serves. The route file
  // on disk is the only assertion here that cannot be satisfied by restating a
  // constant: Expo Router is file-based, so a segment nobody created is a
  // confident redirect to a 404.
  it('offers an address the router serves, down to the route file on disk', async () => {
    const offered = await everyAddressOnOffer();
    const address = Object.values(offered)[0];

    expect(address.startsWith(`${APP_DOMAIN}/`)).toBe(true);
    const servedPath = address.slice(APP_DOMAIN.length);
    expect(servedPath).toBe(storefrontPath(SLUG));

    const segment = servedPath.split('/').filter(Boolean)[0];
    const routeFile = path.join(__dirname, '..', '..', 'app', segment, '[slug].tsx');
    expect(fs.existsSync(routeFile)).toBe(true);
  });

  // The regression itself, named. `<slug>.kaiibi.com` has no DNS record, so an
  // address that parses as a bare hostname is an address that fails at the
  // customer's end -- which is what shipped.
  it('never offers the bare subdomain form, which has no DNS record', async () => {
    const offered = await everyAddressOnOffer();
    for (const [surface, address] of Object.entries(offered)) {
      expect({ surface, resolvesAsHostname: slugFromHostname(address) }).toEqual({
        surface,
        resolvesAsHostname: null,
      });
    }
  });

  // ONE PLACE. Every surface above must come through the shared builder, or
  // the next form change is a hunt across files again -- which is how the same
  // wrong address came to exist in two of them.
  it('builds every one of them from the shared source', async () => {
    const offered = await everyAddressOnOffer();
    for (const [surface, address] of Object.entries(offered)) {
      expect({ surface, address }).toEqual({ surface, address: storefrontAddress(SLUG) });
    }
  });
});

// UNBROKEN, and deliberately so. Showing the path form today is a presentation
// decision forced by missing DNS; it is NOT a decision that the subdomain is
// dead. If a wildcard record (or a per-shop CNAME) is ever added,
// `<slug>.kaiibi.com` must still serve the right shop the moment it resolves.
describe('the subdomain resolver still works, and still fails closed', () => {
  it('still resolves a shop subdomain to that shop', () => {
    expect(slugFromHostname(`${SLUG}.${APP_DOMAIN}`)).toBe(SLUG);
  });

  // Two labels is not a shop. Guessing which half of `a.b.kaiibi.com` is the
  // slug is how you serve the wrong shop's prices.
  it('still refuses www in front of a shop subdomain', () => {
    expect(slugFromHostname(`www.${SLUG}.${APP_DOMAIN}`)).toBeNull();
  });
});
