# Storefront wildcard DNS (backlog)

**Status:** Backlog — the last unshipped piece of the storefront. All code works; no repo change is needed.

Shops are reachable today at `kaiibi.com/s/<slug>` but **not** at `<slug>.kaiibi.com`, because
`*.kaiibi.com` was never pointed at the Vercel project. Deferred twice on purpose:

- [`plans/2026-08-24-storefront-foundation.md:2140`](../superpowers/plans/2026-08-24-storefront-foundation.md) — *"the wildcard DNS record is not configured … an infrastructure step that belongs with Plan 2."*
- [`plans/2026-08-25-storefront-editor.md:828`](../superpowers/plans/2026-08-25-storefront-editor.md) — *"Infrastructure, not code. Point `*.kaiibi.com` at the Vercel project once a shop can claim a slug."*

Plan 2 shipped slug claiming. This half never happened.

## Verified state (2026-08-27)

| Host | DNS | Note |
|---|---|---|
| `kaiibi.com` | A `76.76.21.21` | Vercel; 308-redirects to `www.kaiibi.com` |
| `www.kaiibi.com` | CNAME `cname.vercel-dns.com` | the live site |
| `*.kaiibi.com` | — | **missing — this is the whole bug** |
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

## Two traps before you start

**1. Do not move the nameservers to Vercel.** The zone runs Namecheap email forwarding —
MX to `eforward1-5.registrar-servers.com` plus `v=spf1 include:spf.efwd.registrar-servers.com`.
That forwarding only works on Namecheap's own nameservers. Delegating to Vercel silently kills
mail to `info@kaiibi.com` — the address published in
[`src/constants/contact.ts`](../../src/constants/contact.ts) and the privacy policy. Keep DNS at
Namecheap and satisfy Vercel's wildcard certificate with a TXT record instead.

**2. The wildcard must not inherit the apex's redirect.** `kaiibi.com` is configured in Vercel to
308 to `www.kaiibi.com`. If `*.kaiibi.com` picks up the same rule, `yusefshop.kaiibi.com` will be
bounced to `www.yusefshop.kaiibi.com` — which, per the section above, resolves to `null` and shows
the marketing site. The wildcard has to serve directly, with no redirect.

## Steps

1. **Vercel** → project → Settings → Domains → add `*.kaiibi.com`. Assign it to production and
   confirm it is set to serve directly, **not** to redirect to another domain.
2. Vercel will ask for a DNS-01 challenge for the wildcard certificate. Copy the
   `_acme-challenge` TXT record it shows.
3. **Namecheap** → Domain List → kaiibi.com → Advanced DNS. Add both:
   - `CNAME` — host `*` — value `cname.vercel-dns.com` (use whatever target Vercel displays)
   - `TXT` — host `_acme-challenge` — value from step 2
4. Leave every existing MX, SPF TXT, apex A and `www` CNAME record untouched.
5. Wait for propagation, then verify.

## Verification

```sh
dig +short yusefshop.kaiibi.com          # expect a CNAME/A, not empty
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://yusefshop.kaiibi.com/
                                          # expect 200 and NO redirect to www.*
dig +short kaiibi.com MX                  # eforward1-5 must still be present
```

Then open `https://yusefshop.kaiibi.com` in a browser: it must land on the storefront, and the URL
bar must still read `yusefshop.kaiibi.com` afterwards. If it reads `www.yusefshop.kaiibi.com` you
have hit trap 2.

## Once it works

The reserved-slug list ([`storefront-slug.ts`](../../src/lib/storefront-slug.ts)) already blocks
`www`, `app`, `api` and friends, so a shopkeeper cannot claim a label that would collide with
infrastructure. No code follow-up is required.
