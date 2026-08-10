# Help & support — design

**Date:** 2026-08-09
**Mockup:** [docs/design/support-request-mockup.html](../../design/support-request-mockup.html)
**Status:** approved, ready to plan

## What we're building

A two-way message line between a store and the people who run Kaiibi.

A shop opens it from the ☰ on any screen and writes to us. An operator opens it from the
platform console and can write to a shop first. Both are the same object: a **thread** with
**messages** in it. Building outbound as a separate announcement system would double the work
and split each store's history across two places.

Every reply is written into the thread regardless of the sender's stated preference — that is
what keeps one record of what was said. WhatsApp is a hand-off, not a channel: choosing it
flags the thread and gives the operator a `wa.me` link that opens their own WhatsApp with the
reply already composed. **Kaiibi never sends a WhatsApp or email message itself.**

## Why it exists

Today a store with a problem has no route to us inside the app. Two cases make that urgent:

- Payments are matched by hand (ZAAD/eDahab). A shop that has paid and still reads as lapsed
  has no way to say so.
- A staff member whose role grants nothing lands on `NoAccessScreen`, and a shop on a module
  they don't pay for lands on `UpgradeScreen`. Both render *instead of* the shell, so neither
  has a ☰ — the two people most stuck are the two who currently cannot reach anyone.

## Scope

**In:** the store's sheet (compose, list, thread, reply), the operator's Support tab (queue,
reply panel, outbound composer), attachments both ways, an unread count on the ☰ and on the
console tab.

**Out, deliberately:** broadcasts to a plan tier, help articles, assignment between operators
(there is one), CSAT, canned replies, live chat, push notifications, any automated sending of
WhatsApp or email.

---

## 1. The store's side

### 1.1 Entry point

A **Help & support** row in the ☰ menu, between Settings and the divider above Sign out. It
carries a count chip when there are unread messages from us.

The same menu is duplicated in three shells and all three get the same row:

- [src/components/admin-sidebar.tsx](../../../src/components/admin-sidebar.tsx) — wide native/web
- [src/components/admin-tabs.web.tsx](../../../src/components/admin-tabs.web.tsx) — mobile web
- [src/components/admin-tabs.tsx](../../../src/components/admin-tabs.tsx) — native phone

**Ungated.** The Settings row beside it is wrapped in `canEditShop`; this one is not. A cashier
who cannot ring up a sale is the person most likely to need it, and today their ☰ contains one
item: Sign out.

Because the three menus already carry near-identical markup, the row and its unread badge are
extracted into one shared component rather than pasted three times.

`NoAccessScreen` and `UpgradeScreen` each get their own **Contact support** button opening the
same sheet, since neither renders the shell.

### 1.2 The sheet

One `AppModal` with a scrolling body — not a route, not a wizard. Bento surfaces throughout:
`bentoSurface` card at `BENTO_RADIUS`, `bentoSoft` identity strip, `bentoAccentWash` for the
selected category and for anything we said. No hex literals.

Three views inside one sheet, switched by local state:

| View | What it is |
|---|---|
| `compose` | The form. Default view when there is nothing unread. |
| `list` | Every thread, ours and theirs, newest first. Default view when something is unread. |
| `thread` | One conversation, with a reply box. |

**The form, top to bottom:**

1. **Sent as** — a read-only identity strip: name, role, shop, plan, branch, email, phone. Below
   a hairline, the line "Attached automatically: app *version* (*build*) · *device* · you were on
   *screen* · store id *…4f21*". Identity is captured, never asked for.
2. **What's this about?** — eight category chips (§1.3).
3. **A second dropdown** — label and options depend on the category (§1.3). **Always optional.**
4. **Subject** — one line, required.
5. **Details** — multiline, required, 4000 characters, label and prompt set by the category.
6. **Attachments** — optional, up to 5 files, 10 MB each.
7. **Reply to me on** — In the app (default) / WhatsApp / Email.

Send is disabled until category, subject and details are all present. No validation message
appears on an untouched form; the first press of Send reveals the message under whichever field
is empty.

**No priority field.** Everyone picks "urgent", so it measures frustration rather than impact.
Urgency is inferred from category on the operator side.

### 1.3 The taxonomy

Two levels, defined once in `src/lib/support-taxonomy.ts` and read by both the store's sheet and
the operator's filters, so adding a category is one edit rather than four.

| Category | Second dropdown (label — options) | Details label |
|---|---|---|
| 🐞 Something's broken | *Where in the app?* — POS & checkout, Inventory & products, People & staff, Customers, Accounting & reports, Settings, Signing in, Receipts & printing, **Somewhere else** | What happened? |
| 💬 I need help using it | *Where in the app?* — same list | What are you trying to do? |
| 💳 Billing or payment | *What kind?* — A payment I've made isn't showing, I want to change plan, I was charged wrong, I need an invoice or receipt, My plan lapsed and I'm locked out, **Something else** | What do you need? |
| 🔐 Account or access | *What kind?* — I can't sign in, I forgot my password, Someone's role is wrong, Add or remove a person, Add a branch, **Something else** | What's happening? |
| 📊 Wrong numbers or missing data | *Which numbers?* — Stock counts, A sale that's missing or duplicated, Dashboard or reports, Payroll or hours, Customer records, **Something else** | What's wrong, and what should it say? |
| 🖨 Scanner, printer or till | *Which one?* — Barcode scanner, Receipt printer, Cash drawer, Card or mobile-money terminal, The tablet or phone itself, **Something else** | What's it doing? |
| ✨ Feature request | *Where would it live?* — same app list | What would you like it to do? |
| 🗒 Something else | free text — "Then what is it about?" | Tell us more |

Each category also sets the hint under Details (the mockup's §3 table carries the exact wording).
**Billing** additionally shows a `Caveat tone="context"` above the field naming the plan and
renewal date.

**Every "something else" is captured, not swallowed.** Choosing it as a category, or
*Somewhere else* / *Something else* in any dropdown, reveals a short text input stored in
`area_other`. The console counts those answers, so the tenth person who types "training" is the
evidence that Training should be a category. A category list guessed up front is always wrong;
this is the mechanism that corrects it.

The app list mirrors the sidebar's own words — POS, Inventory, People, Accounting, Settings — so
nobody has to translate what they were looking at into our vocabulary. "Signing in" and
"Receipts & printing" are added because both are outside the nav and both generate support.

### 1.4 Attachments

Images via `expo-image-picker`, documents via `expo-document-picker`. Up to 5 per message, 10 MB
each. Images show as thumbnails with a remove control; documents as a row with name and size.
An upload in flight shows a progress bar. Files over 5 MB warn before uploading — a short clip
is the most useful bug attachment and the most expensive one on a metered connection.

### 1.5 Sent, and failing to send

On success the sheet swaps to a confirmation: a tick, "Sent. We've got it.", where the answer
will arrive, and the `KB-####` reference. Reference format is short enough to read down a phone
line, which is how half of these will be followed up.

On failure a `Caveat tone="wrong"` appears above the still-filled form with a **Try again**
action and our WhatsApp number as the fallback. **Nothing typed is ever lost** — the draft
survives closing the sheet and closing the app. Attachments are re-picked, because file URIs
don't outlive a restart.

### 1.6 Reply preference

In the app is the default and always works. Choosing WhatsApp sets a flag on the thread; it does
not change where the reply is written. The WhatsApp option is hidden when the profile carries no
phone number.

---

## 2. The platform's side

A new **Support** tab in [src/app/platform/index.tsx](../../../src/app/platform/index.tsx),
between Requests and Plans, with an unread badge on its pill. Implementation lives in
`src/components/platform/support-tab.tsx`, mirroring `requests-tab.tsx`'s shape.

### 2.1 The queue

A KPI strip (open, billing waiting, median first reply, feature requests all time), then the
conversation list with category filter chips and a **New message** button.

Four states, each naming **whose move it is** — sorting by that rather than by age is what keeps
a one-operator queue honest:

| State | Meaning |
|---|---|
| Needs a reply | They wrote last |
| Waiting on them | We wrote last |
| Unread by them | We wrote and nobody has opened it — the state that matters for outbound |
| Closed | Done |

A thread whose sender asked for WhatsApp carries a green **Wants WhatsApp** chip in the row.

### 2.2 Answering one

Two columns: the conversation and reply box on the left, a context rail on the right carrying

- **Who this is** — store, person, role, WhatsApp (with an **Open chat** button), email
- **Money** — plan, renewal date, last payment, whether it matched, and a link into Stores
- **Sent from** — app version, device, screen, branch

That rail is the entire argument for answering here rather than on WhatsApp: half of what an
operator would otherwise go looking for is already on screen.

Three send controls: **Send reply**, **Send & close** (most billing answers are one message
long), and **Send & open WhatsApp** — which writes the reply to the thread *first*, then opens
`wa.me` with it pre-filled. Because the thread is written before the link opens, a failed
hand-off loses nothing.

### 2.3 Starting one

Same composer with the fields flipped: a recipient row instead of an identity strip.

- **To** — store search, multi-select but capped low in v1
- **Who at the store** — Owners / One person / Everyone
- **Category** — a shorter list than the store's: Billing, Their account, A problem we found,
  Something's changed, Something else. An operator never files a feature request or a hardware
  fault against a store.
- Subject, message, attachments, and a **Preview as the store** control.

Also reachable as **Message this store** from `ShopDrawer`, pre-filled — an operator noticing
something wrong shouldn't have to change tabs and search for the store they're looking at.

**One store at a time, not a broadcast.** "Message every store on Starter" has different failure
modes: an announcement nobody can reply to, sent 200 times, turning the unread chip into noise
people learn to dismiss. If a real broadcast is wanted it should be designed as one, with a
reply-disabled thread type.

---

## 3. Data

### 3.1 Tables

Migration `20260825000000_support_threads.sql`, following the timestamp convention of the recent
migrations.

**`support_threads`** — shop, opened_by (`shop` | `platform`), author, addressed-to, category,
area, `area_other`, subject, status, reference (`KB-####` from a sequence), contact preference,
a JSONB `client_context` blob for version/platform/screen/branch, and read timestamps for each
end.

**`support_messages`** — thread, author kind (`shop` | `platform`), author id, body, created_at.
Attachments are rows on `support_attachments` pointing at storage paths, so a message can carry
several.

### 3.2 Who can read what

This is the part to get right, and it is not "everyone at the shop".

| Thread | Visible to |
|---|---|
| Opened by a store | Its author, and operators. **Nobody else at the shop.** |
| Opened by us, addressed to one person | That person, and operators. |
| Opened by us, addressed to the store | Holders of `settings.access`, and operators. |

A cashier writing to us about a manager must not be readable by that manager. Billing belongs to
the owner, not to whoever was on the till.

Enforced in RLS on both tables, not in the client. The client filtering is a courtesy; the
policy is the rule.

### 3.3 Attachments storage

**A new private bucket — not `product-images`.** Two independent reasons:

1. `product-images` is public-read (migration `0002_storage.sql`). A support screenshot may show
   customer names and sale totals.
2. Its insert policy requires `inventory.edit`, `settings.access` or `staff.manage` (migrations
   `0024_permission_gates.sql`, `20260820000300_staff_photo.sql`) — precisely the permissions a
   stuck cashier lacks. Their upload would 403.

Private bucket, signed URLs for reads, insert allowed to any authenticated member of the shop
under a path whose first segment is the thread id, and read access for operators.

`src/lib/storage.ts`'s `uploadImage` is hardcoded to `product-images`; support uploads need
their own function in `src/lib/support.ts` rather than a bucket parameter bolted onto it — the
existing comment there is explicit that its permission story is bucket-specific.

---

## 4. Writes

### 4.1 The store writes directly

Ordinary RLS-guarded inserts through `supabase-js` in `src/lib/support.ts`. No edge function:
the policies already express the rule and a store creating its own thread is not a privileged
action.

### 4.2 The operator writes through `platform-admin`

New actions on
[supabase/functions/platform-admin/index.ts](../../../supabase/functions/platform-admin/index.ts):
`open_support`, `reply_support`, `close_support`. Same path as plan approvals, so every reply and
every outbound message lands in `platform_audit_log` automatically. A conversation with a paying
customer is exactly the kind of thing to keep an append-only record of.

**One friction point to resolve deliberately.** That function requires a non-empty `reason` on
*every* action (index.ts:112) — the audit trail's whole design. Asking an operator to type a
separate justification for each reply would be absurd, so for these three actions **the message
body is the reason**: the client passes the reply text as `reason`, and the audit row therefore
records what was said. This keeps the invariant ("no unlogged change, no unexplained change")
without inventing an exemption in the function.

---

## 5. Unread counts

A count query on mount plus a Supabase realtime subscription on `support_messages` while the app
is running. No new infrastructure.

Honest about the limits: a tablet living on the POS all day will see a message arrive; a phone in
a pocket will not. Real push needs the delivery infrastructure that
`docs/backlog/2026-08-01-notification-delivery.md` records as not existing yet. Anything genuinely
urgent still goes out over WhatsApp by hand, which is what the hand-off button is for.

A one-line banner on the next app open, in addition to the ☰ chip, so an unread message is not
represented solely by a small number someone has to notice.

---

## 6. Files

| Path | What |
|---|---|
| `src/lib/support-taxonomy.ts` | Categories, areas, labels, prompts — one source for both sides |
| `src/lib/support.ts` | Store-side queries, inserts, attachment upload, unread count |
| `src/lib/support-draft.ts` | Persists the unsent draft so it survives a closed sheet and a killed app |
| `src/components/support/support-sheet.tsx` | The modal shell and its three views |
| `src/components/support/support-banner.tsx` | The one-line "you have a message" bar (§5) |
| `src/components/support/support-compose.tsx` | The form |
| `src/components/support/support-thread.tsx` | One conversation + reply box (shared with the console) |
| `src/components/support/support-menu-item.tsx` | The ☰ row + unread badge, used by all three shells |
| `src/components/platform/support-tab.tsx` | Queue, reply panel, outbound composer |
| `src/lib/platform.ts` | `listSupportThreads`, `listSupportMessages` + the three new action calls |
| `supabase/migrations/20260825000000_support_threads.sql` | Tables, RLS, sequence, bucket |
| `supabase/functions/platform-admin/index.ts` | `open_support`, `reply_support`, `close_support` |

Three edits to existing shells for the menu row, two to `_layout.tsx` for the wall screens, one
to `src/app/platform/index.tsx` for the tab, one to `shop-drawer.tsx` for **Message this store**.

## 7. Testing

- **Taxonomy** — every category resolves a label, prompt and dropdown; every dropdown ends in an
  "else" option; the "else" option reveals capture.
- **Visibility** — RLS tests are the important ones. A cashier's thread is invisible to the shop
  owner. A store-addressed thread is visible to `settings.access` holders and no one else. An
  operator sees everything. A member of another shop sees nothing.
- **Reference** — sequence produces unique, monotonic `KB-####`.
- **Draft survival** — a failed send leaves the form filled; the draft outlives a remount.
- **Attachments** — over-count and over-size are refused with a message naming the limit.
- **Audit** — each of the three operator actions writes a `platform_audit_log` row carrying the
  message body as its reason.
- **On device** — the sheet on an Android tablet and on a phone, per this repo's rule that native
  layout is verified in the simulator rather than by reading code.

## 8. Known gaps, accepted

- **Unread delivery is best-effort** (§5). Accepted; urgent things go out by hand.
- **"Open chat" uses the operator's personal WhatsApp.** One operator makes this fine now. It is
  a thing to replace later, not a thing that quietly scales.
- **Attachments are re-picked after a restart**, since file URIs don't survive one.
- **No broadcast.** By choice, §2.3.
