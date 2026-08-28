# Storefront — handoff, 2026-08-27

Written at the end of a long session, for whoever picks this up next. Everything
here was checked against production or the repo on the day, not recalled.

---

## The one-paragraph version

The storefront now works end to end and is deployed. A shop can find it, publish
it, share the link, take an order, be told about it, fulfil it, and see the sale
land in the books — verified in a browser at 390px, not only in tests. **Nobody
has used it yet: 11 shops, 1 published page, 4 products listed online, 0 orders
ever placed.** The remaining work is not code. It is two decisions and one
conversation.

---

## Production state (checked 2026-08-27)

| | |
|---|---|
| Migrations | 207 applied, **none pending** — main and production are in sync |
| Shops | 11 |
| Storefronts published | **1** |
| Products listed online | **4** (across all shops) |
| Orders ever placed | **0** |
| Shops whose plan includes `storefront` | **10 of 11** |

That last row matters: entitlements are **not** why only one shop has published.

---

## What shipped today

All merged and deployed.

| PR | What |
|---|---|
| #85 | `complete_sale` honours the price a customer was quoted, and extracts tax from a quoted total. Fixed: a tax-charging shop could not complete a storefront order at all, and repricing stranded open orders. |
| #86 | The storefront address derives from the shop's name; a collision offers a **suffix** (the shop's neighbourhood) instead of a blank box. A claimed address never follows a rename. |
| #87 | Flyers. An offer flyer's words are derived from the `promotions` row, so the page cannot advertise a discount the till refuses. |
| #89 | Removed the SQL/TS duplication of that offer wording; fixed an availability verdict that could apply to a different address than the one asked about. |
| #90 | An offer's dates render in `Africa/Mogadishu`, not the reader's timezone. |
| #93 | The storefront is a nav item, not a setting. Was Settings › Business, four taps deep. Also: "Fix this →" on the products blocker did nothing. |
| #94 | The "Sell online" toggle (was "Expose to customers … Discover feed", a feature that does not exist), plus Online / Not online filters and a deep link from the blocker. |
| #95 | A live page shows its address with **Share on WhatsApp** and **Copy link**. Before this, publishing gave a shop no way to send anyone the link. |

### Still open

- **#97** — one paragraph in the testing skill's driver notes. Mergeable. Land it.
- **#92** — a design note holding a product decision. Not code.
- (#96 is the `reports-hub` session's, not this work.)

---

## The two decisions waiting on a human

### 1. Standard has no storefront — and seven trials expire in ten weeks

`plans.modules`:

| Plan | storefront? |
|---|---|
| Free | no |
| **Standard** | **no** |
| Trial | yes |
| Pro | yes |

Seven of eleven shops are on **Trial**, one already expired, the rest ending
**2 Nov – 8 Dec 2026**. When a trial lapses, or a shop converts to Standard, it
**loses the storefront**: the page it published and the address it printed stop
being reachable from the app.

I could not tell whether that is deliberate. If a storefront is how a small shop
reaches customers, it arguably belongs in the plan a small shop buys — a one-line
change to `plans.modules` with more impact than anything built today. If it is
deliberately Pro-only, the trial expiries are a customer-facing event that needs
planning, not discovering.

**This is the highest-leverage item left, and it is the only one with a deadline.**

### 2. Paying before collection (#92)

Should a shop be able to ask for payment before the customer collects?

The finding that reframes it: **this needs no payment provider.** Shops already
store their ZAAD and e-Dahab merchant numbers per branch
(`shop_locations.zaad_merchant_id`, `edahab_merchant_id`) and receipts already
print them. The storefront simply never shows them — `payment_mode` permits one
value, `'on_collection'`.

So the cheap option is: show the number, the customer pays in their own wallet
app, the shop confirms on arrival exactly as it does for a walk-in. No gateway, no
webhooks, **no accounting change** — the sale still posts at completion.

The cost is not technical. It moves risk to a customer with no recourse: a shop
that cancels after being paid has taken money for nothing, and the app would be
the thing that suggested it. **Recommendation: option A, or nothing. Do not build
a gateway for a channel with zero orders.**

---

## Not finished

**Native (iOS/Android) is not exercised.** Not passed, not failed. #93 and #95
are Jest-verified on native and fully browser-verified on web at both widths.

To close it you must **own port 8081** — see the trap below. The Maestro flow is
written; recreate it from the assertions in #93/#95 or ask for it. It is a
ten-minute run on a free machine.

---

## Traps that cost real time today — read before debugging

**1. Metro on 8081 serves whatever worktree started it.** Another session had it
on branch `reports-hub` with a *production* `.env`. Any simulator, and any browser
pointed at localhost, served that branch's code against production data. This
produced a screen that looked exactly like a broken feature three separate times.

    lsof -tiTCP:8081 -sTCP:LISTEN            # who holds it
    lsof -p <pid> | awk '$4=="cwd"'          # which tree
    git -C <tree> branch --show-current      # which branch
    cat <tree>/.env                          # which database

**2. `--port` cannot route a simulator build.** `expo-dev-client` is not a
dependency, so an installed debug build has no launcher: it carries no
`main.jsbundle` and fetches JS from `localhost:8081` at runtime whatever URL it
was launched with. `expo run:ios --port 8082` builds, installs, and still loads
from 8081. **The tell is zero bundling lines in your own Metro's log.** (#97)

**3. `process.env.TZ` does nothing inside a Jest test here.** The sandboxed
`process.env` is a plain copy with no setter, so a timezone test silently runs in
the machine's zone and passes for the wrong reason. Use
`jest/timezone-environment.js`.

**4. Migration numbering is partitioned.** `202609*` is storefront/fulfilment,
`202610*` is accounting (`docs/superpowers/ACCOUNTING-ROADMAP.md:166`). And
`ls supabase/migrations | sed 's/_.*//' | sort | uniq -d` **cannot prove a
timestamp is free** — it only sees one worktree, so a cross-branch collision is
invisible to it. The real guard is `supabase/tests/migration-version-guard.test.ts`
under `npm test`. This has bitten the repo three times.

**5. The local Supabase is shared and gets wiped mid-run** by other sessions.
Reset from your own worktree before trusting any result. If `db reset` fails on
accumulated Docker state, `docker rm -f` + `docker volume rm` clears it.

**6. Migrations that sort before what production already has** need
`db push --include-all`, and they apply **out of order**. Rehearse it: rebuild the
local DB to production's exact state, apply yours on top, run the suite. Doing
that caught nothing this time, but it is the only way to know.

---

## Two working habits that earned their keep

**Mutation-test every check.** Eight implementers on this project found their own
checks vacuous by perturbing an expected value and confirming the test then fails.
The worst example: the `complete_sale` baseline's central guarantee was vacuous
because every cart sent a price equal to the product price, so a function that
honoured the *cart* price passed all 13 checks.

**Walk the app before building on it.** Six defects across the storefront series
shipped through a fully green suite and were caught only in a browser. The
walkthrough that found the dead "Fix this →", the buried nav and the unshareable
link took about an hour and produced more value than the day's feature work.
**It should have come first.**

---

## Recommendation

1. **Decide the Standard plan question** — it has a deadline the others don't.
2. **Talk to one shopkeeper.** The 1-of-11 number no longer has a technical
   explanation. Whether they know it exists, want it, or have stock worth listing
   is unanswerable from the code.
3. Merge #97. Decide #92.
4. **Build nothing else on the storefront** until a shop uses it. Flyers, the
   carousel, agreed-price fulfilment and quoted tax are all correct, all shipped,
   and none of it has yet been used by a customer.

The number to watch is a second published storefront, and then a first order.
