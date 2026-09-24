-- ============================================================
-- BHL Attendance: STAFF SCHEDULE REQUESTS add-on
-- Staff propose their week (this week + the next 2), an admin approves or rejects.
-- Run after schedule.sql. Safe to re-run.
-- ============================================================

create table if not exists public.schedule_requests (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references public.staff(id) on delete cascade,
  week_start  date not null,                 -- the Sunday the week starts on
  days        jsonb not null,                -- {"2026-09-27": {"kind":"shift","s":"09:00","e":"18:00"}, "2026-09-28": {"kind":"rest"}, ...}
  note        text,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  admin_note  text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  text
);
create unique index if not exists schedule_requests_one_pending on public.schedule_requests (staff_id, week_start) where status = 'pending';
alter table public.schedule_requests enable row level security;
drop policy if exists team_read on public.schedule_requests;
create policy team_read on public.schedule_requests for select to authenticated using (public.is_admin());
grant select on public.schedule_requests to authenticated;

-- Today's date and the first Sunday staff may no longer go past (this week + next 2 weeks)
create or replace function public._team_today() returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce((select timezone from settings where id = 1), 'Europe/London'))::date;
$$;

-- The usual-week plan for a date, ignoring one-off changes
create or replace function public._pattern_day(p_staff uuid, p_date date)
returns table (kind text, start_time time, end_time time)
language plpgsql stable security definer set search_path = public as $$
declare s staff; d jsonb;
begin
  select * into s from staff where id = p_staff;
  if s.week_pattern is not null then
    d := s.week_pattern -> extract(dow from p_date)::int::text;
    if d is null or jsonb_typeof(d) = 'null' then return query select 'rest'::text, null::time, null::time; return; end if;
    return query select 'shift'::text, (d->>'s')::time, (d->>'e')::time; return;
  end if;
  if extract(isodow from p_date) >= 6 then return query select 'rest'::text, null::time, null::time; return; end if;
  return query select 'shift'::text, s.sched_start, s.sched_end;
end $$;
-- Same as above, but a public holiday on a working day counts as 'holiday' (what the schedule shows by default)
create or replace function public._base_day(p_staff uuid, p_date date)
returns table (kind text, start_time time, end_time time)
language plpgsql stable security definer set search_path = public as $$
declare pd record;
begin
  select * into pd from _pattern_day(p_staff, p_date);
  if pd.kind = 'shift' and exists (select 1 from holidays h where h.holiday_date = p_date) then
    return query select 'holiday'::text, pd.start_time, pd.end_time; return; end if;
  return query select pd.kind, pd.start_time, pd.end_time;
end $$;

-- Staff: send (or replace) a request for one week
create or replace function public.request_week(p_staff uuid, p_pin text, p_week date, p_days jsonb, p_note text)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_err text; v_today date := _team_today(); v_this date; k text; v jsonb; v_row schedule_requests;
begin
  v_err := _check_pin(p_staff, p_pin);
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  v_this := v_today - extract(dow from v_today)::int;
  if extract(dow from p_week) <> 0 or p_week < v_this or p_week > v_this + 14 then
    return json_build_object('ok', false, 'error', 'You can only change this week and the next 2 weeks.');
  end if;
  if jsonb_typeof(p_days) <> 'object' or p_days = '{}'::jsonb then
    return json_build_object('ok', false, 'error', 'No changes to send.');
  end if;
  for k, v in select * from jsonb_each(p_days) loop
    if k !~ '^\d{4}-\d{2}-\d{2}$' or k::date < p_week or k::date > p_week + 6 then
      return json_build_object('ok', false, 'error', 'A day is outside this week.'); end if;
    if k::date < v_today then
      return json_build_object('ok', false, 'error', 'Past days can''t be changed. Ask an admin.'); end if;
    if coalesce(v->>'kind', '') not in ('shift', 'rest', 'vacation', 'sick', 'emergency', 'unpaid') then
      return json_build_object('ok', false, 'error', 'Unknown day type.'); end if;
    if v->>'kind' = 'shift' and (coalesce(v->>'s', '') !~ '^\d{2}:\d{2}$' or coalesce(v->>'e', '') !~ '^\d{2}:\d{2}$') then
      return json_build_object('ok', false, 'error', 'Add a start and end time for each working day.'); end if;
  end loop;
  delete from schedule_requests where staff_id = p_staff and week_start = p_week and status = 'pending';
  insert into schedule_requests (staff_id, week_start, days, note)
    values (p_staff, p_week, p_days, nullif(left(btrim(coalesce(p_note, '')), 300), ''))
    returning * into v_row;
  return json_build_object('ok', true, 'request', row_to_json(v_row));
end $$;

-- Staff: my requests for recent and upcoming weeks
create or replace function public.my_schedule_requests(p_staff uuid, p_pin text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_err text; v_today date := _team_today();
begin
  v_err := _check_pin(p_staff, p_pin);
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  return json_build_object('ok', true, 'requests', coalesce((
    select json_agg(row_to_json(r) order by r.created_at desc) from schedule_requests r
    where r.staff_id = p_staff and r.week_start >= v_today - extract(dow from v_today)::int - 7), '[]'::json));
end $$;

-- Staff: withdraw a pending request
create or replace function public.cancel_schedule_request(p_staff uuid, p_pin text, p_id uuid) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_err text;
begin
  v_err := _check_pin(p_staff, p_pin);
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  update schedule_requests set status = 'cancelled', decided_at = now()
    where id = p_id and staff_id = p_staff and status = 'pending';
  return json_build_object('ok', true);
end $$;

-- Admin: approve (writes the schedule) or reject
create or replace function public.decide_schedule_request(p_id uuid, p_approve boolean, p_note text) returns json
language plpgsql security definer set search_path = public as $$
declare r schedule_requests; k text; v jsonb; pd record; v_by text;
begin
  if not public.is_full_admin() then return json_build_object('ok', false, 'error', 'Only admins can approve schedules.'); end if;
  select * into r from schedule_requests where id = p_id for update;
  if not found or r.status <> 'pending' then return json_build_object('ok', false, 'error', 'This request was already handled or withdrawn.'); end if;
  select email into v_by from admins where user_id = auth.uid();
  if p_approve then
    for k, v in select * from jsonb_each(r.days) loop
      select * into pd from _base_day(r.staff_id, k::date);
      if v->>'kind' = pd.kind and (v->>'kind' <> 'shift' or ((v->>'s')::time = pd.start_time and (v->>'e')::time = pd.end_time)) then
        delete from schedule_days where staff_id = r.staff_id and work_date = k::date;   -- same as usual week
      else
        insert into schedule_days (staff_id, work_date, kind, start_time, end_time, note)
          values (r.staff_id, k::date, v->>'kind',
                  case when v->>'kind' = 'shift' then (v->>'s')::time end,
                  case when v->>'kind' = 'shift' then (v->>'e')::time end,
                  r.note)
          on conflict (staff_id, work_date) do update
            set kind = excluded.kind, start_time = excluded.start_time, end_time = excluded.end_time, note = excluded.note;
      end if;
    end loop;
  end if;
  update schedule_requests set status = case when p_approve then 'approved' else 'rejected' end,
    admin_note = nullif(btrim(coalesce(p_note, '')), ''), decided_at = now(), decided_by = v_by
    where id = p_id;
  return json_build_object('ok', true);
end $$;

revoke all on function public._pattern_day(uuid, date) from public, anon, authenticated;
revoke all on function public._base_day(uuid, date) from public, anon, authenticated;
revoke all on function public._team_today() from public, anon, authenticated;
grant execute on function public.request_week(uuid, text, date, jsonb, text) to anon, authenticated;
grant execute on function public.my_schedule_requests(uuid, text) to anon, authenticated;
grant execute on function public.cancel_schedule_request(uuid, text, uuid) to anon, authenticated;
grant execute on function public.decide_schedule_request(uuid, boolean, text) to authenticated;

notify pgrst, 'reload schema';
