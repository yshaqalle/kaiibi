# Two-factor authentication (backlog)

**Status:** Backlog — not scheduled. Currently a UI-only mock.

**Where it lives today:** Settings → Security (`src/components/settings/panels/phase2-panels.tsx`, `SecurityPanel`). The "Authenticator app" and "SMS verification" rows are plain `useState` toggles with no backing data — they reset on reload and don't call anything.

## What this covers

- **Authenticator app (TOTP)** — "Use an app like Google Authenticator."
- **SMS verification** — "Receive a code via text message."

## What real implementation would need

Supabase Auth has built-in MFA support (`supabase.auth.mfa.*`) that should be used instead of hand-rolling TOTP/SMS — this is mostly a matter of wiring the existing Supabase MFA API up, not building a new auth mechanism.

- **TOTP factor:**
  - Enrollment flow: `supabase.auth.mfa.enroll({ factorType: 'totp' })` → show the returned QR code/secret → verify the first code the user enters (`mfa.challenge` + `mfa.verify`) to confirm enrollment.
  - Unenroll flow, and a way to regenerate/display recovery codes.
  - A challenge step inserted into login (`aal1` → `aal2`) once a factor is enrolled — this touches the login screen(s), not just Settings.
- **SMS factor:**
  - Requires an SMS provider configured on the Supabase project (e.g. Twilio) — a cost/ops dependency, not just app code.
  - Same enroll/challenge/verify shape as TOTP, but phone-based.
- **Settings UI:** the current toggles need to become real enrollment entry points (tapping "on" starts the enroll flow instead of just flipping a switch), reflecting `supabase.auth.mfa.listFactors()` for current state rather than local boolean state.
- **Sessions section** (also currently a mock in `SecurityPanel`) is related: "Active sessions" / "Sign out all" would use Supabase's session management once this is tackled.

## Dependencies / open questions

- Need to decide whether SMS MFA is worth the provider cost for this user base, or whether TOTP-only is sufficient to start.
- Login flow (`src/app/(public)/login.tsx` or wherever sign-in lives) needs a second step for the MFA challenge — this is a real change to the auth flow, not additive-only.
