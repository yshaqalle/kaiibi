import type { OrderStatus } from './storefront-admin';

// Task 7: what a shop still owes an order -- accept or decline a new one,
// prep an accepted one, or hand over/settle a ready one. 'ready' counts on
// purpose: a prepped order nobody has collected or delivered is just as
// unfinished as one nobody has looked at. 'completed' and 'cancelled' are the
// two terminal states and are deliberately absent -- a badge that counted
// them would never clear, and a badge that never clears is one a shop stops
// trusting by the second week.
//
// This is its own dependency-free module rather than living in
// storefront-admin.ts, on purpose: storefront-admin.ts imports
// lib/supabase.ts, which throws at import time without live env vars, and
// orders.tsx's own test suite blanket-automocks '@/lib/storefront-admin'
// (`jest.mock('@/lib/storefront-admin')`, no factory), which silently
// replaces a plain array export with an empty one. Pulling OrderStatus in as
// a `type` import keeps this file itself free of both problems, so every
// consumer can import the one real value instead of hand-keeping a copy in
// sync by comment.
//
// N3 narrowed who that is: storefront-admin.ts uses this array itself, in
// countOrdersNeedingAction's own `.in('status', ORDERS_NEEDING_ACTION)`, and
// re-exports it for orders.tsx's own unconfirmedOrders filter (which needs
// the actual matching rows, to sum their totals -- not just a count).
// attention.ts, dashboard.tsx and settings-sidebar.tsx no longer import this
// at all: the filtering they needed moved server-side, into
// countOrdersNeedingAction, so what reaches them is already the integer they
// were computing this array down to.
export const ORDERS_NEEDING_ACTION: OrderStatus[] = ['pending', 'accepted', 'ready'];
