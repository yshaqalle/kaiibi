-- Which session a handover came from.
--
-- A handover closes one session and opens another, so a till worked by two
-- people in a day is two rows. To show that as one run -- combined takings on
-- top, each person's own variance underneath -- the link between them has to be
-- readable.
--
-- IT CANNOT BE INFERRED FROM TIMESTAMPS, which is the whole reason for this
-- column. Adjacency looks identical in the two cases that matter most:
--
--   * a genuine handover, where one count is both the close and the next float;
--   * a close, a bank run, and a fresh open a minute later with a new float.
--
-- The second one deliberately DREW a money boundary. Rendering it as a handover
-- would join two runs that have nothing to do with each other and imply the
-- outgoing person's count carried into the incoming person's drawer, which is
-- exactly the claim a handover makes and that close refused to make.
--
-- So it is recorded at the moment it happens, by the one function that performs
-- it, and is null everywhere else.

alter table public.register_sessions
  add column if not exists handed_over_from uuid references public.register_sessions(id) on delete set null;

create index if not exists register_sessions_handover_idx
  on public.register_sessions(handed_over_from) where handed_over_from is not null;

comment on column public.register_sessions.handed_over_from is
  'The session this one took over from, set only by handover_register_session.
   Null for a register opened fresh -- including one opened moments after a
   close, which is a new run and not a handover.';

-- ---------------------------------------------------------------------------
-- handover_register_session, reproduced whole
--
-- Reproduced per the house convention. The only change is that the session it
-- opens now records where it came from.
-- ---------------------------------------------------------------------------

create or replace function public.handover_register_session(
  p_session_id uuid,
  p_incoming_member_id uuid default null,
  p_cash jsonb default '[]'::jsonb,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_register_id uuid;
  v_new_session_id uuid;
  v_open_cash jsonb;
begin
  select register_id into v_register_id from public.register_sessions
   where id = p_session_id and closed_at is null;
  if v_register_id is null then
    raise exception 'no open register session %', p_session_id;
  end if;

  perform public.close_register_session(p_session_id, p_cash, p_note);

  -- The counted figure becomes the incoming float, per currency, with the
  -- closing denominations carried across -- it is the same notes.
  select coalesce(jsonb_agg(jsonb_build_object(
           'currency_code', c.currency_code,
           'amount_minor', c.closing_counted_minor,
           'rate_to_usd', c.closing_rate_to_usd,
           'denominations', c.closing_denominations
         )), '[]'::jsonb)
    into v_open_cash
    from public.register_session_cash c
   where c.session_id = p_session_id;

  v_new_session_id := public.open_register_session(v_register_id, p_incoming_member_id, v_open_cash, null);

  -- Written after the open rather than passed into it, so open_register_session
  -- keeps one meaning: it opens a register. Only a handover creates this link,
  -- and only here.
  update public.register_sessions
     set handed_over_from = p_session_id
   where id = v_new_session_id;

  return v_new_session_id;
end;
$$;

grant execute on function public.handover_register_session(uuid, uuid, jsonb, text) to authenticated;
