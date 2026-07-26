# Product modal header Save button

## Problem
`ProductModal` ("Edit product" / "Add product") shows a header with a `Done` button that
only closes the modal — it doesn't save. The actual Save button lives at the bottom of
`ProductForm`'s scrollable content, so saving a change (e.g. updating stock) requires
scrolling all the way down.

## Design
Add a compact "Save" button in the modal header, to the left of `Done`, that triggers the
same save flow as the existing bottom button.

- `ProductForm` exposes its `submit` function (and `submitting`/`valid` state) to the
  parent via `forwardRef` + `useImperativeHandle`.
- `ProductModal` holds a ref to `ProductForm`, renders a header "Save" button that calls
  `ref.current?.submit()`, and mirrors the same disabled/"Saving…" treatment as the bottom
  button.
- No changes to validation, upload flow, or auto-close-on-success — the header button
  invokes the exact same `submit()` used today.
- The bottom Save button is unchanged and stays in place.

## Out of scope
- Reworking `Done` into a cancel-with-confirmation affordance.
- Any change to `src/app/(owner)/product/[id].tsx` (separate, apparently-unused routed
  screen).
