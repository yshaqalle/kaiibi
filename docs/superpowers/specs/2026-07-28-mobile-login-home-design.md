# Mobile login-first home

## Problem
On native (iOS/Android), the app always opens to the marketing landing page
(`src/app/(public)/(tabs)/index.tsx`), regardless of auth state. Root layout
(`src/app/_layout.tsx`) mounts `(public)` and `(admin)` unconditionally with no
redirect; the `(admin)` gate (`src/app/(admin)/_layout.tsx:17-19`) only protects
dashboard routes from unauthenticated access — it doesn't route an existing session
there automatically. So every native launch, including for already-logged-in shop
owners, shows the marketing/tabs experience first, with a "Go to your dashboard"
button buried in the hero instead of actually landing there. There's also no home for
a `customer`-role account: the role exists in `src/types/models.ts:5` but nothing
creates or routes to it yet — it's a stub for the not-yet-built marketplace.

## Design

### Home resolution (native only; web unchanged)
Add auth/role-aware redirect logic gating native's `(public)` group, mirroring the
existing loading/redirect pattern in `(admin)/_layout.tsx`:
- loading → spinner
- `session` && `profile.role` is `admin`/`staff` → `<Redirect href="/(admin)" />`
- `session` && `profile.role` is `customer` → `<Redirect>` to a new placeholder
  screen (`(public)/marketplace-coming-soon.tsx`, static "coming soon" copy, no
  functionality) — a structural stub so nothing breaks when customer accounts become
  real, without building marketplace UI now
- no session → render the login-first stack described below

Web is untouched: `(public)/(tabs)/index.tsx` stays the web homepage for everyone,
tab bar unchanged, header "Log in" button unchanged.

### Native `(public)` restructure
Native's `(public)` group stops being tab-based (`(tabs)` with `index`/`about`/
`signup`) and becomes a plain `Stack` where `login` is the index/first route.
`landing` (today's `index.tsx` hero/features content), `about` ("How it works"), and
`signup` (3-step wizard) become pushed stack screens with no tab bar — reached only
via explicit links/buttons on the login screen, never as parallel tab destinations.

This is a platform split following the existing `app-tabs.web.tsx` convention: web
keeps its current `(tabs)` structure unchanged; native gets its own layout that
renders the stack instead.

### Login screen (Design C — brand-forward split)
`src/app/(public)/login.tsx` gains a black hero band above the existing form:
- Eyebrow "SIMPLE POS & INVENTORY", serif tagline "Sell fast.\nStock smart.", trust
  line ("No monthly fees · Works on phone or browser") — copy reused from the
  existing landing hero
- Two links: "How it works" (→ `about`) and "Create a shop" (→ `signup`)
- The new K-mark image (`assets/images/cover.jpeg`) rendered as a large, faint
  (~20% opacity) watermark bleeding off the right edge of the band — safe there
  because the image's own background is already black, no transparent re-export
  needed

Below the band: a small rounded-square tile (26×26, full opacity) of the same K mark
next to "WELCOME BACK", replacing the current plain "KA IIBI" eyebrow. The
email/password fields and `signIn` submit logic (`src/lib/auth.ts`) are unchanged.

The existing bag+K mark (`kaiibi-mark-black.png`) remains the functional brand icon
everywhere else (web nav, app icon, footer). This new K mark is scoped to the login
hero band only — not a rebrand.

### Landing / how-it-works content
No changes to `about.tsx` or the landing page's copy/features — stays single,
shop-owner-focused. No split for marketplace/customer content, since no
customer-facing screens exist yet to route a "customer" path to.

## Out of scope
- Any real marketplace/customer UI beyond the single placeholder redirect target.
- Web behavior changes — web keeps landing-first, tab-based navigation exactly as
  today.
- Replacing the bag+K brand mark anywhere outside the login hero band (app icon,
  splash screen, nav, footer) — that would be a separate rebrand effort.
- Signup wizard content/flow changes.
- A transparent-background version of the new K mark — it's used only against black
  backgrounds as delivered.
