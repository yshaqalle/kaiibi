# Storefront subdomains (backlog)

**Status:** Backlog — the last unshipped piece of the storefront. All code works; no repo change is needed.

Shops are reachable today at `kaiibi.com/s/<slug>` but **not** at `<slug>.kaiibi.com`, because no
DNS for shop subdomains was ever created. Deferred twice on purpose:

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

`kaiibi.com/s/yusefshop` was loaded in a real browser and renders correctly — hero, three
products with prices and stock, Add/Ask, WhatsApp and Basket. The storefront itself is sound.

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

### C. Do nothing — keep `kaiibi.com/s/<slug>`

Already works. No infrastructure, no cost, uglier URL.

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

## Once it works

The reserved-slug list ([`storefront-slug.ts`](../../src/lib/storefront-slug.ts)) already blocks
`www`, `app`, `api`, `mail` and 20 others, so a shopkeeper cannot claim a label that would collide
with infrastructure. No code follow-up is required.
