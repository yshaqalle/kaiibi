# Storefront and Orders — handoff, 2026-08-29

Written at the end of a long session, for whoever picks this up next. Everything
here was checked against the repo, the database or a running app on the day, not
recalled. It follows `HANDOFF-2026-08-27-storefront.md` and
`GAPS-2026-08-28-storefront.md`; both still stand except where corrected below.

---

## The one-paragraph version

Three PRs merged (#107, #108, #109) and one is open (#110). A lapsed shop now
keeps its work; the app shows shops an address that actually resolves; native
testing is unblocked for the first time; and Orders Part 0 removes the two
defects that blocked the storefront journey outright. **The number that matters
did not move: 11 shops, 1 published page, 0 orders ever.** The most useful thing
found all day is not a feature — it is that the app was handing every shop a
share link that could not resolve.

---

## What shipped

| PR | What | State |
|---|---|---|
| #107 | A lapsed storefront keeps its work — a month of grace, then the data stays, the page comes down, the nav greys | **merged, migrations applied** |
| #108 | Shops are shown an address that resolves; a gated route cannot render without its wall; four filed minors | **merged** |
| #109 | `expo-dev-client`, so a worktree can serve its own port — plus the two native defects that unblocking it immediately found | **merged** |
| #110 | Orders Part 0 — fulfilment needs no till, and pick-up is visible | **open, rebased, green** |

---

## The finding that matters most

**The app was handing shops a storefront address that does not resolve.**

Both share surfaces built the subdomain form `<slug>.kaiibi.com`, but the wildcard
DNS record was never created — `dig +short xamdi.kaiibi.com` returns nothing while
`kaiibi.com` returns `76.76.21.21`. So **the address shown never worked, and the
address that works was never shown.**

A shop that published, pressed Share, and sent the link to a customer watched it
fail — and had no reason to try again. After six sessions of making this feature
more correct, this is the first concrete candidate for *why* 11 shops have
produced 1 published page and 0 orders.

Fixed in #108: the app now shows `kaiibi.com/store/<slug>`, verified end to end
against production in a real browser. **The DNS question itself is still open** —
which form is canonical is the A/B/C decision in
`docs/backlog/2026-08-27-storefront-wildcard-dns.md`, deliberately deferred. All
seven address-building sites now route through one `storefrontAddress()` in
`src/lib/storefront-host.ts`, so switching later is one line.

---

## Traps that cost real time today — read before debugging

**1. `jest -t` is a regex, and a filter that matches nothing exits 0.**
`jest -t "keeps the 9+ badge …"` selects **no tests** — `9+` means "one or more
9s". It prints `0 of 2 total` and exits **successfully**. A mutation verified that
way looks killed while never having run. Two agents hit this; the second only
caught it by checking the selected count before mutating. **Always confirm the
filter selected what you think it did.**

**2. "Mergeable/clean" is not "still works".** #108 and #109 were each green and
GitHub reported both `MERGEABLE/CLEAN`. Merging main into #109 produced **4
failing tests and 1 type error**: #108 had replaced `getMyStorefront` with a
cheaper `shopHasStorefront` head-count, and #109's new tests still stubbed the old
name. Textual conflicts and semantic conflicts are different things. **Run the
merged tree before merging.**

**3. The "18 pre-existing tsc errors" figure is a myth, and now explained.** It
reproduces only in a *fresh worktree* missing the gitignored `expo-env.d.ts`.
Running the dev server regenerates the file and the count drops to **0**. It was
circulated as a baseline for most of a session. A real checkout is 0 errors.

**4. `raise notice 'FAIL …'` does not fail a database check.**
`supabase/tests/run-all.sh:82` greps the **whole output** for `ALL CHECKS PASSED`,
so a printed FAIL is inert — and a verdict line placed on an early block gets
printed even when a later block fails. Assertions must `raise exception`, and the
verdict must sit where a failing check prevents reaching it.

**5. Migration ancestors must be verified, never taken from a document.** The
convention here is that a migration reproduces its functions **whole**. A plan
named `20260929000200` as `complete_storefront_order`'s newest definition; it is
`20260929000250:69`. Copying the named one would have silently deleted a 33-line
`elsif` raising the typed `order_line_out_of_range`, **with nothing failing**.
Note two functions edited in one migration can have *different* newest ancestors —
`complete_sale`'s really was `20260929000200:233`.

**6. Port 8081 is no longer a bottleneck — see below.** But while it was, it
served `main` against **production**, and driving a simulator against it would
have meant lapsing a real shop's subscription on the live database.

---

## Native testing is unblocked (#109)

`eas.json` already declared a `development` profile with `developmentClient: true`
— the package was simply never installed. Without the launcher, an installed debug
build carries no `main.jsbundle` and fetches JS from `localhost:8081` **whatever
URL it was launched with**, so only one worktree at a time could run on a
simulator. That is why the native half of the storefront series went five sessions
unexercised.

`expo-dev-client` is now a dependency. `expo run:ios --port 8085` connects to
8085. **The tell that you are on your own bundle is `iOS Bundled …` lines
appearing in *your* Metro log.**

Notes for the next person driving a simulator:
- Maestro is at `~/.maestro/bin/maestro` and needs Java:
  `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`.
- **Pass `--device <udid>`.** An Android emulator is often running from another
  session and Maestro picks it by default — a tap went to the wrong device.
- System dialogs need a flow scoped to `appId: com.apple.springboard`, tapped by
  `point: "x%,y%"`; a flow scoped to the app cannot see them.
- Expo Go is **not** a workaround: version 57.0.6 matches the SDK and still
  segfaults after bundling.

### What the first native hour found

Both invisible to a fully green suite and to a browser, and both in
`src/components/admin-tabs.tsx` — which had **no test file at all**:

- **The ☰ badge could not fit `"9+"`** — it rendered `9` stacked above `+` in a
  tall pill covering a third of the glyph. Single digits fit, which is why five
  sessions missed it. Cause isolated by changing only the glyph's `fontSize`:
  `menuButtonDot` was absolutely positioned with no width, and Yoga measures such
  a node against its parent's content box.
- **The ☰ sheet was a single accessibility element**, so no row was individually
  reachable. Since the ☰ is now the *only* route to Storefront and Orders on a
  phone, a screen-reader user could reach neither. Cause: the backdrop is a
  `Pressable`, and React Native defaults `accessible` to true.

**Both were in the web sidebar too, byte-identical — and that is not only web.**
`admin-tabs.tsx` renders `AdminSidebar` on every **tablet**, so iPad carried both.

---

## Two security findings, both closed by mechanism

**A `security definer` parameter is a client-settable parameter.** Orders Part 0
first added `p_require_register boolean default true` to `complete_sale` so
storefront fulfilment could opt out. But `complete_sale` is granted to
`authenticated` and exposed over PostgREST, and the guard's own comment says *"the
client is the party it is meant to constrain."* Proven live as `authenticated`:
`=> false` **and** `=> null` both bypassed a shop's `require_open_register`.

The parameter was removed. The opt-out now rides `storefront_order_fulfilments` —
the RLS-with-no-policies, no-grant table `complete_storefront_order` already
inserts before the call and deletes after, matched on `xact_id` and shop. That
precedent had **already rejected** a `set_config` marker for a reason worth
repeating (`20260928000500:34-63`): **a custom GUC authenticates *that* a value was
set, never *who* set it.**

**A default is not an enforcement.** The general lesson: when adding an opt-out to
a function the client can call, ask who may assert it, not what it defaults to.

---

## What a green suite did not catch, again

Continuing the pattern from the previous handoff — the score is now much worse for
tests and better for looking:

- The **once-per-screen** nav rule was guarded in 1 of 3 files; the real
  `BottomNav` never rendered in any test because a suite stubbed it.
- A **comped-override skip** had no non-vacuity proof: a mutation dropping
  `expires_at`, `kind` and `key` passed the **entire suite** while reopening the
  hole it was written to close.
- The **entire wiring layer** of the pick-up address was unbound — deleting the
  prop from a theme passed all 3506 tests, and `tsc` could not see it because the
  prop is optional.
- Wrapping a component and then exporting the **unwrapped** one passed a
  source-text grep 6/6 while failing a real render test.
- A route file named `orders.web.tsx` was invisible to both route guards, because
  each derived the route by stripping only `.tsx`.

**Mutation-testing every check is what found all five.** Perturb the
implementation, not the test.

---

## Decisions still waiting on a human

1. **Which storefront address is canonical** — configure wildcard DNS, or keep
   the path form. Open A/B/C in the backlog doc. Everything else about the address
   is now one line away from either answer.
2. **Is a delivery fee taxable at a tax-charging shop?** (`GAPS` A1) Still costs
   nothing to settle at 0 orders.
3. **Should a shop that revoked `discounts.manual` still fulfil a repriced
   order?** (`GAPS` A2)
4. **Paying before collection** — the design note is merged (#92); the decision
   is not made.
5. **Should Standard include the storefront?** #107 makes it less urgent — a
   lapsing shop no longer loses its work — but it is unanswered.

---

## If you are about to execute Orders Parts 1+

The design is `specs/2026-08-29-orders-amend-and-share-design.md`; the mockup is
`docs/design/orders-redesign-mockup.html`. Part 0 is PR #110.

**Three defects were found in the Part 0 plan document itself.** The same author
and method will produce the later plans, so check for all three:

1. A **wrong function-ancestor pointer** that would have silently deleted a fix.
2. **Checks that print `FAIL` without failing**, with the verdict line misplaced.
3. **Tests importing `@testing-library/react-native`**, which is not installed —
   they could not have run as written.

Also: a brief instructed adding a key to a `jsonb_build_object` that does not
exist, because the function is `returns table`.

**And check what a column actually contains before building on it.**
`shop_locations.address` is empty for nearly every shop — no automated path has
ever written it; the only writer is an optional hand-typed field in Settings. The
plan specified rendering it alone, which would have shipped a blank line and left
the customer as lost as before. The line is now `[address, neighborhood, city]`,
the place-string this repo already uses in three places. `neighborhood` is
backfilled for **every** shop and is literally the where-to-find-us field
(`20260808000000:47-48`).

---

## Recommendation

1. **Read `20261010000000_fulfilment_needs_no_register.sql` before merging #110.**
   It rewrites `complete_sale` — the function every sale runs through. It is the
   most verified thing in the queue and still the one worth ten minutes of human
   attention. Then `npx supabase db push` (plain — these sort after main's newest).
2. **Settle the DNS question.** It is the cheapest thing that might move the
   number.
3. **Talk to one shopkeeper.** Six sessions have made this feature more correct.
   None has made it used, and the code can no longer tell you why.
4. **Build nothing further on the storefront until a shop uses it.** Lapse and
   grace, the agreed price, flyers, the carousel, the address, and now Part 0 are
   all correct, all shipped, and none has been used by a customer.

The number to watch is unchanged from two handoffs ago: **a second published
storefront, and then a first order.**
