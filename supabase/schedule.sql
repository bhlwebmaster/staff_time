-- ============================================================
-- BHL Attendance: WEEKLY SCHEDULE add-on
-- Run once in Supabase → SQL Editor (after schema.sql and payroll.sql). Safe to re-run.
-- ============================================================

-- Each person's usual week. Keys "0".."6" = Sunday..Saturday.
-- A day is {"s":"05:00","e":"14:00"} for a shift, or null for a rest day.
-- If week_pattern is empty, Monday–Friday on their usual start/end is assumed.
alter table public.staff add column if not exists week_pattern jsonb;

-- Changes for specific dates (a different shift, rest day or leave)
create table if not exists public.schedule_days (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references public.staff(id) on delete cascade,
  work_date   date not null,
  kind        text not null,
  start_time  time,
  end_time    time,
  note        text,
  unique (staff_id, work_date)
);
-- Allowed day types (Emergency Leave added later; re-created so older databases get it too)
alter table public.schedule_days drop constraint if exists schedule_days_kind_check;
alter table public.schedule_days add constraint schedule_days_kind_check
  check (kind in ('shift', 'rest', 'vacation', 'sick', 'emergency', 'holiday', 'unpaid'));
alter table public.schedule_days enable row level security;
drop policy if exists team_read on public.schedule_days;
drop policy if exists admin_write on public.schedule_days;
create policy team_read on public.schedule_days for select to authenticated using (public.is_admin());
create policy admin_write on public.schedule_days for all to authenticated using (public.is_full_admin()) with check (public.is_full_admin());
grant select, insert, update, delete on public.schedule_days to authenticated;
grant select (week_pattern) on public.staff to authenticated;

-- The schedule for one person on one date: override → weekly pattern → Mon–Fri default
create or replace function public.day_schedule(p_staff uuid, p_date date)
returns table (kind text, start_time time, end_time time)
language plpgsql stable security definer set search_path = public as $$
declare s staff; o schedule_days; d jsonb;
begin
  select * into s from staff where id = p_staff;
  select * into o from schedule_days where staff_id = p_staff and work_date = p_date;
  if found then return query select o.kind, coalesce(o.start_time, s.sched_start), coalesce(o.end_time, s.sched_end); return; end if;
  if s.week_pattern is not null then
    d := s.week_pattern -> extract(dow from p_date)::int::text;
    if d is null or jsonb_typeof(d) = 'null' then return query select 'rest'::text, s.sched_start, s.sched_end; return; end if;
    return query select 'shift'::text, (d->>'s')::time, (d->>'e')::time; return;
  end if;
  if extract(isodow from p_date) >= 6 then return query select 'rest'::text, s.sched_start, s.sched_end; return; end if;
  return query select 'shift'::text, s.sched_start, s.sched_end;
end $$;

-- Team week for the homepage (anyone with the link, like the WhatsApp group). Times only, no pay.
create or replace function public.week_schedule(p_from date) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('from', p_from, 'staff', coalesce((
    select json_agg(json_build_object('id', st.id, 'display_name', st.display_name, 'color', st.color, 'avatar', st.avatar,
      'sched_start', st.sched_start, 'sched_end', st.sched_end, 'week_pattern', st.week_pattern,
      'days', coalesce((select json_agg(json_build_object('work_date', sd.work_date, 'kind', sd.kind, 'start_time', sd.start_time,
                'end_time', sd.end_time, 'note', sd.note)) from schedule_days sd
                where sd.staff_id = st.id and sd.work_date between p_from and p_from + 6), '[]'::json)) order by st.display_name)
    from staff st where st.active), '[]'::json));
$$;
grant execute on function public.week_schedule(date) to anon, authenticated;
revoke all on function public.day_schedule(uuid, date) from public, anon, authenticated;

-- Admin staff list: include the weekly pattern and pay details
create or replace function public.admin_staff() returns json
language sql stable security definer set search_path = public as $$
  select case when not public.is_admin() then '[]'::json else coalesce((
    select json_agg(json_build_object('id', id, 'full_name', full_name, 'display_name', display_name,
      'sched_start', sched_start, 'sched_end', sched_end, 'lunch_mins', lunch_mins, 'active', active,
      'has_pin', pin_hash is not null, 'created_at', created_at,
      'avatar', avatar, 'photo', photo, 'tagline', tagline, 'color', color,
      'start_date', start_date, 'pay_rate', pay_rate, 'pay_type', pay_type, 'week_pattern', week_pattern) order by display_name)
    from staff), '[]'::json) end;
$$;

-- Refresh Supabase's column list so the app sees changes immediately
notify pgrst, 'reload schema';
