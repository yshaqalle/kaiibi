-- Settlement cash belongs to the till that took it.
--
-- register_session_expected attributes every payment through the SALE's session
-- (`s.register_session_id`), which was the only session a payment could belong to
-- while all of a sale's money arrived at once.
--
-- A settlement breaks that. The money is handed over days later at whatever till
-- is open, and 20260831000100 records which one on the payment row -- but nothing
-- read it. So the till that took the cash closed with a surplus variance it could
-- not explain, and the sale's original session, long since counted and signed
-- off, was credited with money that never went through it.
--
-- coalesce(payment, sale): a payment written by complete_sale carries no session
-- of its own and falls back to the sale's, so every existing figure is unchanged.
-- Only a settlement, which is the only thing that sets the column, moves.

create or replace function public.register_session_expected(p_session_id uuid)
returns table (currency_code text, expected_minor integer)
language sql security definer stable set search_path = public as $$
  with cash_in as (
    -- Base currency: cash with no currency_code, in USD cents.
    select 'USD'::text as code,
           sum(sp.amount_cents)::numeric as amount
      from public.sale_payments sp
      join public.sales s on s.id = sp.sale_id
     where coalesce(sp.register_session_id, s.register_session_id) = p_session_id
       and sp.method = 'cash'
       and sp.currency_code is null
    having sum(sp.amount_cents) is not null
    union all
    -- Foreign currencies: the notes that actually moved, in their own minor
    -- unit. Change leaves the same pile it came from (the picker converts the
    -- change back at the line's own rate), so it nets off here.
    select sp.currency_code,
           sum(sp.foreign_amount_cents - coalesce(sp.foreign_change_cents, 0))::numeric
      from public.sale_payments sp
      join public.sales s on s.id = sp.sale_id
     where coalesce(sp.register_session_id, s.register_session_id) = p_session_id
       and sp.method = 'cash'
       and sp.currency_code is not null
     group by sp.currency_code
  ),
  -- Per refund, the share of the original sale settled in each cash bucket.
  refund_share as (
    select coalesce(sp.currency_code, 'USD') as code,
           sum(
             r.total_cents::numeric
             * (case when sp.currency_code is null then sp.amount_cents else sp.amount_cents end)::numeric
             / nullif(s.total_cents, 0)
             -- Foreign buckets are held in their own minor unit, so convert the
             -- USD-denominated share back at the rate that line was taken at.
             * (case when sp.currency_code is null then 1 else coalesce(sp.exchange_rate, 1) end)
           ) as amount
      from public.refunds r
      join public.sales s on s.id = r.sale_id
      join public.sale_payments sp on sp.sale_id = s.id and sp.method = 'cash'
     where r.register_session_id = p_session_id
     group by coalesce(sp.currency_code, 'USD')
  )
  select c.currency_code,
         round(
           c.opening_float_minor
           + coalesce((select ci.amount from cash_in ci where ci.code = c.currency_code), 0)
           - coalesce((select rs.amount from refund_share rs where rs.code = c.currency_code), 0)
         )::integer
    from public.register_session_cash c
   where c.session_id = p_session_id;
$$;

grant execute on function public.register_session_expected(uuid) to authenticated;
