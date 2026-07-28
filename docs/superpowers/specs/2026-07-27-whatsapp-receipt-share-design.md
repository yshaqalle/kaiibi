# WhatsApp receipt share

## Problem

The receipt modal ([receipt-modal.tsx](../../../src/components/receipt-modal.tsx)) offers Print (web), Email, and a generic Share (native), but no direct way to send a receipt via WhatsApp — a common channel for merchants texting receipts to customers. The code already anticipated this (`receipt.ts` comment: "used for the Email body and the WhatsApp prefilled message") but it was never wired up.

## Constraint: text only, no PDF attachment

WhatsApp's URL scheme (`wa.me`/`whatsapp://send`) only supports a prefilled text message — it cannot attach a file. Attaching the PDF receipt to WhatsApp is already possible today via the existing native-only generic Share button (the OS share sheet lets the user pick WhatsApp, PDF included); that path needs no changes. This feature adds a dedicated, text-only WhatsApp button that also works on web, where no WhatsApp option exists today.

## Design

Add a `shareWhatsApp` handler to `ReceiptModal`, following the same shape as the existing `mailtoFallback` handler:

```js
const shareWhatsApp = () => {
  const digits = receipt.customer.phone?.replace(/\D/g, '') ?? '';
  openExternal(`https://wa.me/${digits}?text=${encodeURIComponent(buildReceiptText(receipt))}`);
};
```

- **Recipient**: if the sale captured a customer phone number, strip it to digits and use it as the `wa.me` path segment, deep-linking straight into that chat. Phone numbers in this app are free text with no country-code validation, so this only resolves correctly when the merchant entered the number with a country code — that's an accepted, known limitation (no new validation UI is in scope here).
- **No customer phone captured**: `digits` is `''`, producing `https://wa.me/?text=...`, which opens WhatsApp's own contact picker with the message pre-filled. Same code path handles both cases; no branching needed.
- **Message body**: reuses `buildReceiptText(receipt)` as-is — no changes to `receipt.ts`.
- **Opening the URL**: reuses the existing `openExternal` helper, which already handles the web-new-tab-vs-native-`Linking.openURL` split correctly (see the comment above `openExternal` in `receipt-modal.tsx` explaining why a real `<a target="_blank">` click is used on web instead of `window.open`).
- **No busy/loading state**: opening a URL is synchronous-ish, same as `mailtoFallback` (unlike `shareEmail`/`shareGeneric`, which await PDF generation and do show a spinner).

## UI

New action button in the `actions` row of the modal: 💬 icon (matching the emoji-icon style of 🖨️/✉️/↗️), label "WhatsApp". Visible on **both** web and native — unlike Print (web-only) and the generic Share (native-only) buttons it sits alongside. `actions` is already `flexWrap`, so the extra button reflows without layout changes.

## Out of scope

- Attaching the PDF to a WhatsApp message (not achievable via URL scheme on any platform; native users already have this via the generic Share button).
- Phone number validation/formatting UI to guarantee country-code correctness.
