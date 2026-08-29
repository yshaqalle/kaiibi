# Storefront subdomains (backlog)

**Status:** Backlog — the last unshipped piece of the storefront. All code works; no repo change is needed.

Shops are reachable today at `kaiibi.com/store/<slug>` but **not** at `<slug>.kaiibi.com`, because
no DNS for shop subdomains was ever created. Deferred twice on purpose:

- [`plans/2026-08-24-storefront-foundation.md:2140`](../superpowers/plans/2026-08-24-storefront-foundation.md) — *"the wildcard DNS record is not configured … an infrastructure step that belongs with Plan 2."*
- [`plans/2026-08-25-storefront-editor.md:828`](../superpowers/plans/2026-08-25-storefront-editor.md) — *"Infrastructure, not code. Point `*.kaiibi.com` at the Vercel project once a shop can claim a slug."*

Plan 2 shipped slug claiming. This half never happened.

## Verified state (2026-08-27)

| Host | DNS | Note |
|---|---|---|
| `kaiibi.com` | A `76.76.21.21` | Vercel; 308-redirects to `www.kaiibi.com` |
| `www.kaiibi.com` | CNAME `cname.vercel-dns.com` | the live site |
| `*.kaiibi.com` | — | no wildcard record |
| `<slug>.kaiibi.com` | — | does not resolve; browsers report DNS failure |

Nameservers are Namecheap's (`dns1`/`dns2.registrar-servers.com`).

`kaiibi.com/s/yusefshop` was loaded in a real browser on **2026-08-27** and rendered correctly —
hero, three products with prices and stock, Add/Ask, WhatsApp and Basket. The storefront itself is
sound.

That check is recorded exactly as it was run, at the address that existed on the day. **The path
has since changed** (see below): the same page is now canonically `kaiibi.com/store/yusefshop`,
and `/s/yusefshop` redirects to it. What was verified — that the storefront renders — still
stands; the URL it was verified at is no longer the canonical one.

## The path segment is `store`, and `/s/` still works (2026-08-29)

`/s/<slug>` became `/store/<slug>`. `s` was a segment nobody could read aloud, and this address is
the one shops print on cards.

`/s/<slug>` was **not** removed. Because the subdomain form below never shipped, `/s/` is the only
address any shop has ever actually been given — every printed card and forwarded WhatsApp link is
one of those. [`src/app/s/[slug].tsx`](../../src/app/s/%5Bslug%5D.tsx) is now a redirect onto the
canonical path, so those links still arrive. Both segments are named once, in
[`src/lib/storefront-host.ts`](../../src/lib/storefront-host.ts), and the app-boot subdomain
redirect in [`src/app/_layout.tsx`](../../src/app/_layout.tsx) now targets `/store/`.

None of this changes the DNS position: the wildcard record is still missing, and `<slug>.kaiibi.com`
still does not resolve. Everything below is unaffected.

## The address has no `www`

[`src/lib/storefront-host.ts`](../../src/lib/storefront-host.ts) accepts **exactly one label**
before `kaiibi.com`, so `www.<slug>.kaiibi.com` resolves to `null` and loads the ordinary app
instead of the shop. That is deliberate — guessing which half of `a.b.kaiibi.com` is the slug is
how you serve the wrong shop's prices.

This is an easy trap, because the main site *does* force `www`. The shop address never does:

- ✅ `https://yusefshop.kaiibi.com`
- ❌ `https://www.yusefshop.kaiibi.com`

## The blocker: wildcard and email cannot coexist

The obvious plan — add `*.kaiibi.com` to Vercel and keep DNS at Namecheap — **is not possible.**
Two vendor constraints collide head-on:

- **Vercel requires nameserver delegation for wildcard domains.** Per
  [Vercel's docs](https://vercel.com/docs/domains/working-with-domains/add-a-domain): *"If using
  your custom domain as a wildcard domain, you must use the nameservers method for verification …
  Vercel's nameservers will be automatically enabled for you on saving."* There is no CNAME-plus-TXT
  path for a wildcard.
- **Namecheap free email forwarding requires Namecheap nameservers.** The zone forwards
  `info@kaiibi.com` via MX `eforward1-5.registrar-servers.com` and
  `v=spf1 include:spf.efwd.registrar-servers.com`. Namecheap only offers this *"for domains pointed
  to our BasicDNS, PremiumDNS, or FreeDNS systems."* Delegating to Vercel kills it.

`info@kaiibi.com` is published in [`src/constants/contact.ts`](../../src/constants/contact.ts) and
the privacy policy, so losing it silently is not an option.

## Options

### A. Per-shop subdomain via CNAME — no nameserver change

Add each shop's subdomain to Vercel as an ordinary subdomain and point one CNAME at it. Email is
untouched. Vercel shows a project-specific CNAME target (e.g. `d1d4fc829fe7bc7c.vercel-dns-017.com`),
so use whatever the dashboard displays rather than assuming `cname.vercel-dns.com`.

- Unblocks a shop in minutes, zero risk to email.
- Two manual actions per shop. Automatable later via Vercel's REST API
  (`POST /v10/projects/{id}/domains`) at slug-claim time.
- Vercel Hobby caps a project at 50 custom domains; check the plan before relying on this at scale.

### B. True wildcard — delegate nameservers, relocate email first

Point `kaiibi.com` at Vercel's nameservers, re-create the apex A and `www` CNAME in Vercel DNS, and
move `info@kaiibi.com` forwarding to a provider that works with external DNS (Cloudflare Email
Routing, ImprovMX, and Zoho all have free tiers), adding its MX and SPF records in Vercel DNS.

- Scales to unlimited shops with no per-shop work.
- Touches the live site's DNS and the published support address. Do the email migration **first**
  and confirm delivery before switching nameservers.

### C. Do nothing — keep `kaiibi.com/store/<slug>`

Already works. No infrastructure, no cost, longer URL — though `store` reads a good deal better on
a card than the `s` this option was first written against.

Worth knowing if C is chosen: the editor and the publish bar currently **show and copy
`<slug>.kaiibi.com`**, the form that does not resolve — not the path form that does. Under A or B
that resolves itself. Under C it does not, and those two screens would need to show
`kaiibi.com/store/<slug>` instead. See "What the app tells shops their address is" below.

**Suggested order:** A now to unblock shops, B later if shop count justifies the migration.

## The redirect trap — applies to A and B alike

`kaiibi.com` is configured in Vercel to 308-redirect to `www.kaiibi.com`. If a shop subdomain picks
up the same rule, `yusefshop.kaiibi.com` gets bounced to `www.yusefshop.kaiibi.com` — which, per the
section above, resolves to `null` and shows the marketing site. Shop subdomains must serve directly,
with no redirect.

## Verification

```sh
dig +short yusefshop.kaiibi.com          # expect a CNAME/A, not empty
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://yusefshop.kaiibi.com/
                                          # expect 200 and NO redirect to www.*
dig +short kaiibi.com MX                  # eforward1-5 must still be present (option A)
```

Then open `https://yusefshop.kaiibi.com` in a browser: it must land on the storefront, and the URL
bar must still read `yusefshop.kaiibi.com` afterwards.

## What the app tells shops their address is

**The one live consequence of this backlog item, and it is not cosmetic.** Both places a shop can
read or send its own address build it as `<slug>.kaiibi.com` — the form that does not resolve:

- [`publish-bar.tsx:166`](../../src/components/storefront/editor/publish-bar.tsx) — the address under
  "Your page is at", the **Copy link** button, and the **Share on WhatsApp** message body.
- [`content-drawer.tsx:357`](../../src/components/storefront/editor/content-drawer.tsx) — the claimed
  address, its **Copy link** button, and the suffix shown beside the slug field.

Neither has ever emitted `/s/<slug>`, so the segment rename did not touch them. That means a shop
pressing Copy link today gets a link that fails DNS, while the address that works
(`kaiibi.com/store/<slug>`) is never shown. Whichever option above is taken, this is the screen to
check afterwards.

## Once it works

The reserved-slug list ([`storefront-slug.ts`](../../src/lib/storefront-slug.ts), mirrored in
`public.reserved_slugs()`) already blocks `www`, `app`, `api`, `mail` and 20 others, so a shopkeeper
cannot claim a label that would collide with infrastructure. No code follow-up is required.

The `store` segment needs no addition to that list. A slug never occupies a top-level path segment —
it only ever fills the dynamic half of `/store/<slug>` — so a shop slugged `store` resolves to
`kaiibi.com/store/store` and collides with nothing. (`s` cannot be claimed at all: both
`validateSlug` and the `shops_slug_is_a_dns_label` CHECK require three characters.) The list guards
*subdomains*, which is a question for options A and B, not for the path.
