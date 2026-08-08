import { assembleRun } from '@/lib/register-sessions';
import { supabase } from '@/lib/supabase';
import type {
  DrawerCountEntry,
  PaymentLine,
  Register,
  RegisterSession,
  RegisterSessionCash,
  SessionTransaction,
} from '@/types/models';

// Registers and their sessions. The IO half — the arithmetic lives in
// `register-sessions.ts` so Jest can load it without Supabase.
//
// Opening, closing and handover all go through RPCs rather than table writes.
// There is no write policy on `register_sessions` at all, which is what makes
// "one open session per register", "expected is computed server-side" and "you
// cannot sign off someone else's variance" enforceable instead of advisory.

function mapRegisterRow(row: any): Register {
  return {
    id: row.id,
    shopId: row.shop_id,
    locationId: row.location_id,
    name: row.name,
    note: row.note ?? null,
    kind: row.kind,
    shopMemberId: row.shop_member_id,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCashRow(row: any): RegisterSessionCash {
  return {
    id: row.id,
    sessionId: row.session_id,
    currencyCode: row.currency_code,
    openingFloatMinor: row.opening_float_minor,
    // numeric arrives as a string over PostgREST, same as tax_rate_percent.
    openingRateToUsd: Number(row.opening_rate_to_usd),
    closingCountedMinor: row.closing_counted_minor,
    closingRateToUsd: row.closing_rate_to_usd != null ? Number(row.closing_rate_to_usd) : null,
    expectedMinor: row.expected_minor,
    varianceMinor: row.variance_minor,
    openingDenominations: row.opening_denominations,
    closingDenominations: row.closing_denominations,
  };
}

function mapSessionRow(row: any): RegisterSession {
  return {
    id: row.id,
    shopId: row.shop_id,
    locationId: row.location_id,
    registerId: row.register_id,
    shopMemberId: row.shop_member_id,
    openedBy: row.opened_by,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    varianceBaseCents: row.variance_base_cents,
    openingNote: row.opening_note,
    closingNote: row.closing_note,
    handedOverFrom: row.handed_over_from ?? null,
    cash: (row.cash ?? []).map(mapCashRow),
  };
}

// The RPCs take one jsonb entry per currency, never a scalar — a drawer holds
// as many piles as it holds.
function cashPayload(entries: readonly DrawerCountEntry[]) {
  return entries.map((entry) => ({
    currency_code: entry.currencyCode,
    amount_minor: entry.amountMinor,
    rate_to_usd: entry.rateToUsd,
    denominations: entry.denominations,
  }));
}

export async function listRegisters(shopId: string, locationId?: string | null): Promise<Register[]> {
  let query = supabase.from('registers').select('*').eq('shop_id', shopId);
  if (locationId) query = query.eq('location_id', locationId);
  const { data, error } = await query.order('kind', { ascending: true }).order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapRegisterRow);
}

export async function createRegister(
  shopId: string,
  locationId: string,
  name: string,
  note?: string | null
): Promise<void> {
  const { error } = await supabase
    .from('registers')
    .insert({ shop_id: shopId, location_id: locationId, name: name.trim(), note: blankToNull(note) });
  if (error) throw error;
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function updateRegister(
  id: string,
  input: Partial<{ name: string; note: string | null; active: boolean; locationId: string }>
): Promise<void> {
  const { error } = await supabase
    .from('registers')
    .update({
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.note !== undefined && { note: blankToNull(input.note) }),
      ...(input.active !== undefined && { active: input.active }),
      ...(input.locationId !== undefined && { location_id: input.locationId }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
}

// Only ever succeeds for a register nothing points at: `register_sessions`
// references it `on delete restrict`, deliberately, so deleting a counter
// cannot erase its money history. Once it has sessions, deactivate instead.
export async function deleteRegister(id: string): Promise<void> {
  const { error } = await supabase.from('registers').delete().eq('id', id);
  if (error) throw error;
}

// Finds or creates the caller's own phone register at a location. Idempotent —
// the point of a mobile register is that it is reused, so a seller's history
// accumulates on one id instead of scattering across a row per shift.
export async function ensureMobileRegister(
  shopId: string,
  locationId: string,
  shopMemberId?: string | null
): Promise<string> {
  const { data, error } = await supabase.rpc('ensure_mobile_register', {
    p_shop_id: shopId,
    p_location_id: locationId,
    p_shop_member_id: shopMemberId ?? null,
  });
  if (error) throw error;
  return data as string;
}

// How many sessions each register has, so Settings can tell which are still
// deletable. An RPC rather than a count over `register_sessions`, because that
// table is gated on registers.manage / budgets.manage / sales.view and
// settings.access is deliberately none of them -- managing which tills exist is
// a different job from seeing who was short at close. See 20260822000100.
export async function registerSessionCounts(shopId: string): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc('register_session_counts', { p_shop_id: shopId });
  if (error) throw error;
  return new Map((data ?? []).map((row: any) => [row.register_id as string, Number(row.session_count)]));
}

const SESSION_SELECT = '*, cash:register_session_cash(*)';

export async function openRegisterSession(
  registerId: string,
  shopMemberId: string | null,
  cash: readonly DrawerCountEntry[],
  note?: string | null
): Promise<string> {
  const { data, error } = await supabase.rpc('open_register_session', {
    p_register_id: registerId,
    p_shop_member_id: shopMemberId,
    p_cash: cashPayload(cash),
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function closeRegisterSession(
  sessionId: string,
  cash: readonly DrawerCountEntry[],
  note?: string | null
): Promise<void> {
  const { error } = await supabase.rpc('close_register_session', {
    p_session_id: sessionId,
    p_cash: cashPayload(cash),
    p_note: note ?? null,
  });
  if (error) throw error;
}

// One count, one call: it closes the outgoing session and opens the incoming
// one in a single transaction, so a crash between the two cannot leave the
// register closed with nobody on it.
export async function handoverRegisterSession(
  sessionId: string,
  incomingMemberId: string,
  cash: readonly DrawerCountEntry[],
  note?: string | null
): Promise<string> {
  const { data, error } = await supabase.rpc('handover_register_session', {
    p_session_id: sessionId,
    p_incoming_member_id: incomingMemberId,
    p_cash: cashPayload(cash),
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as string;
}

// The open session at a location, if there is one the caller can see. RLS does
// the filtering: an ordinary cashier sees only sessions they are on, so this
// returns theirs; someone with registers.manage sees whichever is open here.
export async function openSessionAt(locationId: string): Promise<RegisterSession | null> {
  const { data, error } = await supabase
    .from('register_sessions')
    .select(SESSION_SELECT)
    .eq('location_id', locationId)
    .is('closed_at', null)
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? mapSessionRow(data) : null;
}

export async function listRegisterSessions(
  shopId: string,
  options?: { locationId?: string | null; limit?: number }
): Promise<RegisterSession[]> {
  let query = supabase.from('register_sessions').select(SESSION_SELECT).eq('shop_id', shopId);
  if (options?.locationId) query = query.eq('location_id', options.locationId);
  const { data, error } = await query
    .order('opened_at', { ascending: false })
    .limit(options?.limit ?? 30);
  if (error) throw error;
  return (data ?? []).map(mapSessionRow);
}

// Everything a close sheet needs to preview a variance before submitting: the
// cash lines rung through this session, and how many sales there were.
//
// The preview is a courtesy, not the answer. `close_register_session`
// recomputes all of it server-side and never trusts a number the client sends,
// because the client is the party the number is checking.
export async function sessionCashSummary(
  sessionId: string
): Promise<{ payments: PaymentLine[]; saleCount: number }> {
  const { data, error } = await supabase
    .from('sales')
    .select('id, payments:sale_payments(*)')
    .eq('register_session_id', sessionId);
  if (error) throw error;
  const rows = data ?? [];
  const payments: PaymentLine[] = [];
  for (const sale of rows) {
    for (const payment of (sale as any).payments ?? []) {
      payments.push({
        method: payment.method,
        amountCents: payment.amount_cents,
        tenderedCents: payment.tendered_cents,
        customerName: payment.customer_name,
        customerPhone: payment.customer_phone,
        currencyCode: payment.currency_code,
        exchangeRate: payment.exchange_rate != null ? Number(payment.exchange_rate) : null,
        foreignAmountCents: payment.foreign_amount_cents,
        foreignChangeCents: payment.foreign_change_cents,
      });
    }
  }
  return { payments, saleCount: rows.length };
}

// What each session has rung up: how many sales, and how much across every
// tender. One query for the whole list rather than one per row — a month of
// sessions would otherwise be sixty round trips to render one card.
//
// Takings here are ALL tenders, not just cash. "How is this till doing?" is a
// different question from "what should be in the drawer?", and conflating them
// is what makes a mobile-money-heavy session look empty.
export async function registerSessionTotals(
  sessionIds: readonly string[]
): Promise<Map<string, { saleCount: number; totalCents: number }>> {
  const totals = new Map<string, { saleCount: number; totalCents: number }>();
  if (sessionIds.length === 0) return totals;
  const { data, error } = await supabase
    .from('sales')
    .select('register_session_id, total_cents')
    .in('register_session_id', [...sessionIds]);
  if (error) throw error;
  for (const row of data ?? []) {
    const id = (row as any).register_session_id as string | null;
    if (!id) continue;
    const current = totals.get(id) ?? { saleCount: 0, totalCents: 0 };
    current.saleCount += 1;
    current.totalCents += (row as any).total_cents ?? 0;
    totals.set(id, current);
  }
  return totals;
}

// Every session in one continuous RUN of a register: the one asked for, plus
// whatever was handed over to or from it.
//
// A run is what someone means by "this register today" when two people worked
// it. It is walked through `handed_over_from` rather than by time, because
// adjacency cannot tell a handover from a close-and-reopen — see 20260822000400.
export async function sessionRun(sessionId: string): Promise<RegisterSession[]> {
  const { data, error } = await supabase
    .from('register_sessions')
    .select(SESSION_SELECT)
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return [];
  const anchor = mapSessionRow(data);

  // Recent sessions on this register, then walk the links in `assembleRun`.
  // BOUNDED: a busy till accumulates hundreds of sessions over a year and a run
  // is at most a handful, so an unbounded fetch would pull a year of history to
  // render one sheet. Ordered newest-first so the window always contains the
  // anchor and its neighbours.
  const { data: siblings, error: siblingError } = await supabase
    .from('register_sessions')
    .select(SESSION_SELECT)
    .eq('register_id', anchor.registerId)
    .order('opened_at', { ascending: false })
    .limit(50);
  if (siblingError) throw siblingError;
  const all = (siblings ?? []).map(mapSessionRow);
  // The anchor may fall outside the window on a very busy register; including
  // it explicitly means the sheet always has at least the session asked for.
  if (!all.some((session) => session.id === anchor.id)) all.push(anchor);

  return assembleRun(anchor.id, all);
}

// Sales and refunds rung through a set of sessions, newest first.
export async function sessionTransactions(sessionIds: readonly string[]): Promise<SessionTransaction[]> {
  if (sessionIds.length === 0) return [];
  const ids = [...sessionIds];
  const [salesResult, refundsResult] = await Promise.all([
    supabase
      .from('sales')
      .select('id, created_at, total_cents, item_count, customer_name, register_session_id, payments:sale_payments(*)')
      .in('register_session_id', ids),
    supabase.from('refunds').select('id, created_at, total_cents, register_session_id').in('register_session_id', ids),
  ]);
  if (salesResult.error) throw salesResult.error;
  if (refundsResult.error) throw refundsResult.error;

  const rows: SessionTransaction[] = (salesResult.data ?? []).map((sale: any) => ({
    id: sale.id,
    createdAt: sale.created_at,
    totalCents: sale.total_cents ?? 0,
    itemCount: sale.item_count ?? 0,
    customerName: sale.customer_name,
    kind: 'sale',
    payments: (sale.payments ?? []).map((payment: any) => ({
      method: payment.method,
      amountCents: payment.amount_cents,
      tenderedCents: payment.tendered_cents,
      customerName: payment.customer_name,
      customerPhone: payment.customer_phone,
      currencyCode: payment.currency_code,
      exchangeRate: payment.exchange_rate != null ? Number(payment.exchange_rate) : null,
      foreignAmountCents: payment.foreign_amount_cents,
      foreignChangeCents: payment.foreign_change_cents,
    })),
  }));

  for (const refund of refundsResult.data ?? []) {
    rows.push({
      id: (refund as any).id,
      createdAt: (refund as any).created_at,
      // Negative so it reads as money leaving without the list needing to know
      // what a refund is at every call site.
      totalCents: -((refund as any).total_cents ?? 0),
      itemCount: 0,
      customerName: null,
      kind: 'refund',
      payments: [],
    });
  }

  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// What the register was last closed at, per currency — the open sheet pre-fills
// the float from this, because overnight it is physically the same money. Its
// provenance is shown next to the field rather than presented as a bare
// default: it is wrong the day someone banks the takings, and the opener has to
// notice that and correct it.
export async function lastCloseFor(registerId: string): Promise<RegisterSession | null> {
  const { data, error } = await supabase
    .from('register_sessions')
    .select(SESSION_SELECT)
    .eq('register_id', registerId)
    .not('closed_at', 'is', null)
    .order('closed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? mapSessionRow(data) : null;
}
