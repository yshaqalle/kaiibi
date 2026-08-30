import fs from 'node:fs';
import path from 'node:path';

import { act, create } from 'react-test-renderer';

// Lives here rather than beside the routes ON PURPOSE -- see
// storefront-route.test.tsx's note: expo-router builds its route table from
// `require.context(src/app)`, and nothing on that scan skips `.test.tsx`. A
// test file under src/app would become a real route shipped in the bundle.

// THE SHAPE OF THIS FILE. Expo Router is file-based, so the DIRECTORY NAME IS
// THE URL SEGMENT -- there is no route table to assert against. A test that
// only checked `storefrontPath('xamdi') === '/store/xamdi'` would restate the
// constant and pass happily while `src/app/store/` did not exist and every
// customer got a 404. So the assertions below end at the filesystem: the path
// the app BUILDS is resolved to the file that would have to SERVE it, and that
// file has to be there.

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createElement } = require('react');
  return {
    Redirect: function Redirect({ href }: { href: string }) {
      return createElement('Redirect', { href });
    },
    useLocalSearchParams: jest.fn(() => ({ slug: 'xamdi' })),
  };
});

import {
  APP_DOMAIN,
  LEGACY_STOREFRONT_SEGMENT,
  ORDER_SEGMENT,
  orderAddress,
  orderPath,
  STOREFRONT_SEGMENT,
  storefrontPath,
} from '@/lib/storefront-host';

// A real 26-character Crockford token shape -- no i, l, o or u.
const TOKEN = 'a1b2c3d4e5f6g7h8j9k0mnpqrs';

// Required lazily, inside the one test that renders it, rather than imported
// at the top. A top-level import of a route that has been DELETED takes the
// whole suite down with a module-resolution error -- so the check below that
// exists precisely to catch that deletion would never get to run, and the
// failure would read as a broken test file rather than as "every link a shop
// ever shared is now a 404".
// eslint-disable-next-line @typescript-eslint/no-require-imports
const LegacyStorefrontRoute = () => require('@/app/s/[slug]').default();

const APP_DIR = path.join(__dirname, '..', 'app');

// The route file a given public path would be served by, under Expo Router's
// file-based convention. `/store/xamdi` is served by `src/app/store/[slug].tsx`
// -- the concrete slug is whatever fills the dynamic segment, so it is the
// segment plus `[slug]` that has to exist on disk.
function routeFileFor(publicPath: string, param = 'slug'): string {
  const segment = publicPath.split('/').filter(Boolean)[0];
  return path.join(APP_DIR, segment, `[${param}].tsx`);
}

describe('the canonical public address is a route that exists', () => {
  it('serves /store/<slug> from a real route file', () => {
    const built = storefrontPath('xamdi');

    // Not a restatement of the constant: this resolves the built path to the
    // file Expo Router would need in order to answer it, and looks.
    expect(fs.existsSync(routeFileFor(built))).toBe(true);
    expect(built).toBe(`/${STOREFRONT_SEGMENT}/xamdi`);
  });

  // The whole reason the old segment is not simply deleted. `/s/<slug>` is the
  // only address that has ever worked in public -- `<slug>.kaiibi.com` was
  // never given a wildcard DNS record (docs/backlog/2026-08-27-storefront-
  // wildcard-dns.md) -- so every link a shop has printed or sent is a `/s/`
  // link. Removing the file is how those become 404s.
  it('still serves the old /s/<slug> from a real route file, so a shared link survives', () => {
    expect(fs.existsSync(routeFileFor(`/${LEGACY_STOREFRONT_SEGMENT}/xamdi`))).toBe(true);
  });

  it('sends the old address to the canonical one rather than rendering a second copy of the page', () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<LegacyStorefrontRoute />);
    });

    const redirects = tree!.root.findAllByType('Redirect' as never);
    expect(redirects).toHaveLength(1);
    expect(redirects[0].props.href).toBe(storefrontPath('xamdi'));

    act(() => {
      tree.unmount();
    });
  });
});

// ── The order link (Part 3) ─────────────────────────────────────────────
//
// Same file, same reasoning, second address. An order link is the other
// public URL this app hands out, and it is handed out in a form that is
// harder to take back than a storefront address: it is sent to ONE customer
// over WhatsApp and sits in their chat history.
//
// #108's post-mortem is why these assertions look like this rather than
// comparing a constant to itself: the old tests pinned each surface to its
// own literal, so all of them could be -- and were -- wrong together, and
// shops copied `<slug>.kaiibi.com`, for which no wildcard DNS record has ever
// existed. The test that would have caught it is the one that ends at the
// filesystem.
describe('the order link is a route that exists', () => {
  it('serves /o/<token> from a real route file', () => {
    const built = orderPath(TOKEN);
    expect(fs.existsSync(routeFileFor(built, 'token'))).toBe(true);
    expect(built).toBe(`/${ORDER_SEGMENT}/${TOKEN}`);
  });

  it('builds the address from APP_DOMAIN, so settling path-vs-subdomain stays a one-file change', () => {
    expect(orderAddress(TOKEN)).toBe(`${APP_DOMAIN}${orderPath(TOKEN)}`);
    // Not two independent literals that happen to agree today -- the address
    // CONTAINS the path, so a change to one cannot leave the other behind.
    expect(orderAddress(TOKEN)).toContain(orderPath(TOKEN));
  });

  // The token comes off gen_random_bytes through a fixed alphabet, so this is
  // belt and braces rather than a live risk -- but `orderPath` is the single
  // place a URL is built, and a URL builder that does not escape is a defect
  // waiting for the first input that is not what it expected.
  it('escapes a token that somehow contains a URL-significant character', () => {
    expect(orderPath('a/b')).toBe(`/${ORDER_SEGMENT}/a%2Fb`);
  });

  // Decision 3, asserted so it cannot be quietly reversed: there is NO
  // legacy order segment and no redirect promise. An unused
  // LEGACY_ORDER_SEGMENT constant is exactly how the next person concludes
  // the guarantee exists -- so its absence is the thing under test.
  it('makes no permanent-redirect promise, unlike the storefront address', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const host = require('@/lib/storefront-host');
    expect(host.LEGACY_ORDER_SEGMENT).toBeUndefined();
  });
});
