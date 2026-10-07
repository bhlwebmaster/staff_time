-- ============================================================
-- BHL Attendance — Supabase schema
-- Run once in Supabase → SQL Editor → New query → Run.
-- Safe to re-run: functions are replaced, tables are created if missing.
-- ============================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- Tables ----------

create table if not exists public.settings (
  id              int primary key default 1 check (id = 1),
  timezone        text    not null default 'Europe/London',  -- the clock the team works to ("GMT" in the WhatsApp group)
  grace_mins      int     not null default 5,                -- arriving within this many minutes of schedule is not "late"
  ot_block_mins   int     not null default 15,               -- OT is credited in whole blocks (36 min → 30 min)
  count_early     boolean not null default false,            -- count minutes before scheduled start as worked time
  company_name    text    not null default 'BioHack London'
);
insert into public.settings (id) values (1) on conflict (id) do nothing;
-- Judge by hours: no Late/undertime when the day's hours are complete; short time uses OT first
alter table public.settings add column if not exists flex_hours boolean not null default true;
alter table public.settings add column if not exists rules_version int not null default 0;
-- Sept 2026 rule update (runs once): OT in 30-minute blocks, count from actual time in
update public.settings set ot_block_mins = 30, count_early = true, rules_version = 2 where rules_version < 2;

create table if not exists public.staff (
  id               uuid primary key default gen_random_uuid(),
  full_name        text not null,                 -- as used on timesheets, e.g. "BINGHOY, RAE"
  display_name     text not null,                 -- what they tap on, e.g. "Rae"
  sched_start      time not null default '06:00',
  sched_end        time not null default '15:00',
  lunch_mins       int  not null default 60,      -- unpaid
  active           boolean not null default true,
  pin_hash         text,
  failed_attempts  int not null default 0,
  locked_until     timestamptz,
  created_at       timestamptz not null default now()
);

create table if not exists public.attendance (
  id           uuid primary key default gen_random_uuid(),
  staff_id     uuid not null references public.staff(id) on delete cascade,
  work_date    date not null,                    -- date in settings.timezone
  sched_start  time not null,                    -- the schedule for THIS day (may differ, e.g. an offset day)
  sched_end    time not null,
  time_in      timestamptz,
  lunch_out    timestamptz,
  lunch_in     timestamptz,
  time_out     timestamptz,
  note         text,
  source       text not null default 'app',      -- app | admin | import
  updated_at   timestamptz not null default now(),
  unique (staff_id, work_date)
);
-- The day's PLANNED schedule (from the weekly schedule) when they clocked in. sched_start/end can differ if they
-- started later or left earlier using yesterday's OT; expected hours come from the plan.
alter table public.attendance add column if not exists plan_start time;
alter table public.attendance add column if not exists plan_end   time;
-- Extra OT credit (minutes) an admin granted for this day, e.g. to use OT that already expired
alter table public.attendance add column if not exists ot_adjust  int not null default 0;

-- After-hours OT ("call-outs"), only for people an admin turns it on for (Staff → After-hours OT).
-- From ot_carry_from on, that person's OT also carries over until used (no next-day expiry).
alter table public.staff add column if not exists ot_carry_from date;
-- Soft cap on a carry-over OT bank: OT above it is still banked, admins are warned
alter table public.settings add column if not exists ot_bank_cap_mins int not null default 480;
-- The most of a carry-over OT bank one day can use (the rest stays banked)
alter table public.settings add column if not exists ot_daily_use_mins int not null default 180;
-- Minutes of finished after-hours OT sessions on this day (kept up to date from ot_sessions)
alter table public.attendance add column if not exists after_mins int not null default 0;
-- What the schedule says the day is (shift, rest, holiday, leave). Rest days count every minute as OT. Set in schedule.sql.
alter table public.attendance add column if not exists day_kind text;

create table if not exists public.ot_sessions (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null,
  work_date     date not null,                     -- the day it counts towards (the shift they had clocked out of)
  started_at    timestamptz not null,
  ended_at      timestamptz,                       -- null while it's running
  note          text not null,                     -- who asked and what for
  auto_stopped  boolean not null default false,    -- no End OT tapped: stopped after 4 hours, worth a check
  source        text not null default 'app',       -- app | admin
  created_at    timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at),
  foreign key (staff_id, work_date) references public.attendance (staff_id, work_date) on delete cascade on update cascade
);
create unique index if not exists ot_sessions_one_open on public.ot_sessions (staff_id) where ended_at is null;
create index if not exists ot_sessions_day_idx on public.ot_sessions (work_date);
-- Profile touches (chosen by the staff member)
alter table public.staff add column if not exists avatar  text;   -- preset avatar key, e.g. 'mango'
alter table public.staff add column if not exists photo   text;   -- own photo as small JPEG data URL (≤ 60 KB)
alter table public.staff add column if not exists tagline text;   -- short motto, ≤ 40 chars
alter table public.staff add column if not exists color   text;   -- card colour key

create index if not exists attendance_date_idx on public.attendance (work_date);

create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       text not null,
  action      text not null,
  staff_id    uuid,
  work_date   date,
  before      jsonb,
  after       jsonb
);
create index if not exists audit_staff_idx on public.audit_log (staff_id, work_date);

create table if not exists public.admins (
  user_id  uuid primary key,
  email    text
);
-- role: 'admin' = full access incl. creating users; 'finance' = view timesheets + export only
alter table public.admins add column if not exists role text not null default 'admin';
alter table public.admins add column if not exists created_at timestamptz not null default now();
alter table public.admins drop constraint if exists admins_role_check;
alter table public.admins add constraint admins_role_check check (role in ('admin', 'finance'));

-- ---------- Row level security ----------
-- Staff (anonymous) never touch tables directly: they go through the
-- PIN-checked functions below. Admins (signed in + listed in admins) get full access.

alter table public.settings   enable row level security;
alter table public.staff      enable row level security;
alter table public.attendance enable row level security;
alter table public.audit_log  enable row level security;
alter table public.admins     enable row level security;
alter table public.ot_sessions enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Full admins only (can edit, manage staff and create users).
create or replace function public.is_full_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid() and role = 'admin');
$$;

-- The signed-in user's role: 'admin', 'finance' or null.
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.admins where user_id = auth.uid();
$$;

-- Everyone in admins can read; only role 'admin' can write.
do $$
declare t text;
begin
  foreach t in array array['settings', 'staff', 'attendance', 'ot_sessions'] loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('drop policy if exists team_read on public.%I', t);
    execute format('drop policy if exists admin_write on public.%I', t);
    execute format('create policy team_read on public.%I for select to authenticated using (public.is_admin())', t);
    execute format('create policy admin_write on public.%I for all to authenticated using (public.is_full_admin()) with check (public.is_full_admin())', t);
  end loop;
end $$;
drop policy if exists admin_read on public.audit_log;
create policy admin_read on public.audit_log for select to authenticated using (public.is_admin());
-- The admins list is readable by full admins; users are created/removed only by the
-- admin-users Edge Function (it holds the service key), never from the browser.
drop policy if exists admin_read on public.admins;
create policy admin_read on public.admins    for select to authenticated using (public.is_full_admin() or user_id = auth.uid());

-- ---------- Audit trail (every insert / edit / delete) ----------

create or replace function public.attendance_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor text := coalesce(auth.jwt() ->> 'email', current_setting('bhl.actor', true), 'system');
begin
  if tg_op = 'INSERT' then
    insert into audit_log(actor, action, staff_id, work_date, after)
      values (v_actor, 'create', new.staff_id, new.work_date, to_jsonb(new));
    return new;
  elsif tg_op = 'UPDATE' then
    new.updated_at := now();
    insert into audit_log(actor, action, staff_id, work_date, before, after)
      values (v_actor, 'edit', new.staff_id, new.work_date, to_jsonb(old), to_jsonb(new));
    return new;
  else
    insert into audit_log(actor, action, staff_id, work_date, before)
      values (v_actor, 'delete', old.staff_id, old.work_date, to_jsonb(old));
    return old;
  end if;
end $$;

drop trigger if exists attendance_audit_trg on public.attendance;
create trigger attendance_audit_trg
  before insert or update or delete on public.attendance
  for each row execute function public.attendance_audit();

-- After-hours OT: keep a day's after_mins in step with its finished sessions
create or replace function public._ot_day_sync(p_staff uuid, p_date date) returns void
language sql security definer set search_path = public as $$
  update attendance a set after_mins = x.mins
  from (select coalesce(sum(round(extract(epoch from o.ended_at - o.started_at) / 60)), 0)::int as mins
        from ot_sessions o where o.staff_id = p_staff and o.work_date = p_date and o.ended_at is not null) x
  where a.staff_id = p_staff and a.work_date = p_date and a.after_mins is distinct from x.mins;
$$;

-- ...and log every session change in the day's history
create or replace function public._ot_sessions_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor text := coalesce(auth.jwt() ->> 'email', nullif(current_setting('bhl.actor', true), ''), 'system');
  v_action text;
begin
  if tg_op <> 'INSERT' then perform _ot_day_sync(old.staff_id, old.work_date); end if;
  if tg_op <> 'DELETE' then perform _ot_day_sync(new.staff_id, new.work_date); end if;
  if tg_op = 'INSERT' then
    v_action := case when new.ended_at is null then 'after-hours OT started' else 'after-hours OT added' end;
    insert into audit_log(actor, action, staff_id, work_date, after) values (v_actor, v_action, new.staff_id, new.work_date, to_jsonb(new));
    return null;
  elsif tg_op = 'DELETE' then
    insert into audit_log(actor, action, staff_id, work_date, before) values (v_actor, 'after-hours OT deleted', old.staff_id, old.work_date, to_jsonb(old));
    return null;
  end if;
  v_action := case when old.ended_at is null and new.ended_at is not null
                   then case when new.auto_stopped then 'after-hours OT auto-stopped after 4h' else 'after-hours OT ended' end
                   else 'after-hours OT edited' end;
  insert into audit_log(actor, action, staff_id, work_date, before, after)
    values (v_actor, v_action, new.staff_id, new.work_date, to_jsonb(old), to_jsonb(new));
  return null;
end $$;

drop trigger if exists ot_sessions_sync_trg on public.ot_sessions;
create trigger ot_sessions_sync_trg
  after insert or update or delete on public.ot_sessions
  for each row execute function public._ot_sessions_sync();

-- A session nobody ended stops itself 4 hours after it started (flagged for an admin to check)
create or replace function public.ot_autostop() returns void
language sql security definer set search_path = public as $$
  update ot_sessions set ended_at = started_at + interval '4 hours', auto_stopped = true
  where ended_at is null and started_at < now() - interval '4 hours';
$$;

-- ---------- Staff-facing functions (callable with the public anon key) ----------

-- Who's on the team + today's status. No PINs, no history.
-- Each person's usual week (also created in schedule.sql). Needed here because roster() returns it.
alter table public.staff add column if not exists week_pattern jsonb;

create or replace function public.roster() returns json
language sql stable security definer set search_path = public as $$
  with s as (select * from settings where id = 1),
  d as (select (now() at time zone (select timezone from s))::date as today)
  select json_build_object(
    'now',      now(),
    'today',    (select today from d),
    'settings', (select json_build_object('timezone', timezone, 'grace_mins', grace_mins,
                   'ot_block_mins', ot_block_mins, 'count_early', count_early, 'flex_hours', flex_hours, 'company_name', company_name,
                   'ot_bank_cap_mins', ot_bank_cap_mins, 'ot_daily_use_mins', ot_daily_use_mins) from s),
    'staff', coalesce((
      select json_agg(json_build_object(
        'id', st.id, 'display_name', st.display_name, 'full_name', st.full_name,
        'has_pin', st.pin_hash is not null,
        'sched_start', st.sched_start, 'sched_end', st.sched_end, 'lunch_mins', st.lunch_mins, 'week_pattern', st.week_pattern,
        'avatar', st.avatar, 'photo', st.photo, 'tagline', st.tagline, 'color', st.color, 'ot_carry_from', st.ot_carry_from,
        'recent', coalesce((select json_agg(json_build_object('work_date', r.work_date, 'sched_start', r.sched_start,
            'sched_end', r.sched_end, 'plan_start', r.plan_start, 'plan_end', r.plan_end, 'ot_adjust', r.ot_adjust, 'time_in', r.time_in, 'lunch_out', r.lunch_out, 'lunch_in', r.lunch_in,
            'time_out', r.time_out, 'after_mins', r.after_mins, 'day_kind', r.day_kind) order by r.work_date)
          from attendance r where r.staff_id = st.id and r.work_date >= (select today from d) - 45), '[]'::json),
        'today', case when a.id is null then null else json_build_object(
            'sched_start', a.sched_start, 'sched_end', a.sched_end,
            'time_in', a.time_in, 'lunch_out', a.lunch_out, 'lunch_in', a.lunch_in, 'time_out', a.time_out,
            'ot_open', exists (select 1 from ot_sessions o where o.staff_id = st.id and o.ended_at is null)) end
      ) order by st.display_name)
      from staff st
      left join attendance a on a.staff_id = st.id and a.work_date = (select today from d)
      where st.active), '[]'::json)
  );
$$;

-- Internal: verify a PIN with lock-out after 5 wrong tries (15 min).
create or replace function public._check_pin(p_staff uuid, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare s staff;
begin
  select * into s from staff where id = p_staff and active for update;
  if not found then return 'Name not found — ask an admin.'; end if;
  if s.pin_hash is null then return 'No PIN set yet.'; end if;
  if s.locked_until is not null and s.locked_until > now() then
    return format('Too many wrong PINs. Try again in %s min.', ceil(extract(epoch from s.locked_until - now()) / 60));
  end if;
  if crypt(coalesce(p_pin, ''), s.pin_hash) <> s.pin_hash then
    update staff set
      locked_until    = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end,
      failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end
      where id = p_staff;
    return 'Wrong PIN.';
  end if;
  update staff set failed_attempts = 0, locked_until = null where id = p_staff;
  return null;
end $$;

-- First-time PIN setup, or change PIN (needs current PIN).
create or replace function public.set_pin(p_staff uuid, p_current text, p_new text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare s staff; v_err text;
begin
  if p_new !~ '^[0-9]{4}$' then return json_build_object('ok', false, 'error', 'PIN must be 4 digits.'); end if;
  select * into s from staff where id = p_staff and active;
  if not found then return json_build_object('ok', false, 'error', 'Name not found — ask an admin.'); end if;
  if s.pin_hash is not null then
    v_err := _check_pin(p_staff, p_current);
    if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  end if;
  update staff set pin_hash = crypt(p_new, gen_salt('bf')), failed_attempts = 0, locked_until = null where id = p_staff;
  return json_build_object('ok', true);
end $$;

-- The one staff action: check | in | lunch_start | lunch_end | out | note | ot_start | ot_end
-- Uses the SERVER clock, so phone time can't be faked.
-- ot_start / ot_end: out-of-hours OT before the shift (working days), after clocking out, or on a rest day
-- (only for people with Out-of-hours OT turned on).
create or replace function public.punch(
  p_staff uuid, p_pin text, p_action text,
  p_sched_start time default null, p_sched_end time default null, p_note text default null
) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_err  text;
  v_tz   text;
  v_day  date;
  s      staff;
  a      attendance;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_ss   time;
  v_se   time;
  v_kind text;
  o      ot_sessions;
begin
  v_err := _check_pin(p_staff, p_pin);
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  perform ot_autostop();

  select timezone into v_tz from settings where id = 1;
  v_day := (now() at time zone v_tz)::date;
  select * into s from staff where id = p_staff;
  select * into a from attendance where staff_id = p_staff and work_date = v_day for update;
  perform set_config('bhl.actor', 'staff: ' || s.display_name, true);

  if p_action = 'in' then
    if a.time_in is not null then return json_build_object('ok', false, 'error', 'You already clocked in today.'); end if;
    if exists (select 1 from ot_sessions where staff_id = p_staff and ended_at is null) then
      return json_build_object('ok', false, 'error', 'Tap End OT first, then clock in.');
    end if;
    if p_sched_start is not null and coalesce(p_sched_end, s.sched_end) <= p_sched_start then
      return json_build_object('ok', false, 'error', 'Schedule end must be after start.');
    end if;
    -- The day's planned schedule (weekly schedule add-on), else the usual hours
    if to_regprocedure('public.day_schedule(uuid,date)') is not null then
      execute 'select start_time, end_time from public.day_schedule($1, $2)' into v_ss, v_se using p_staff, v_day;
    end if;
    if a.id is not null then
      -- the day already exists (pre-shift OT was clocked before the shift): clock in on it
      update attendance set sched_start = coalesce(p_sched_start, v_ss, s.sched_start), sched_end = coalesce(p_sched_end, v_se, s.sched_end),
        plan_start = coalesce(v_ss, s.sched_start), plan_end = coalesce(v_se, s.sched_end), time_in = now(), note = coalesce(v_note, note)
        where id = a.id;
    else
      insert into attendance (staff_id, work_date, sched_start, sched_end, plan_start, plan_end, time_in, note)
        values (p_staff, v_day, coalesce(p_sched_start, v_ss, s.sched_start), coalesce(p_sched_end, v_se, s.sched_end),
                coalesce(v_ss, s.sched_start), coalesce(v_se, s.sched_end), now(), v_note);
    end if;
  elsif p_action = 'lunch_start' then
    if a.time_in is null then return json_build_object('ok', false, 'error', 'Clock in first.'); end if;
    if a.time_out is not null then return json_build_object('ok', false, 'error', 'You already clocked out.'); end if;
    if a.lunch_out is not null then return json_build_object('ok', false, 'error', 'Lunch already started.'); end if;
    update attendance set lunch_out = now() where id = a.id;
  elsif p_action = 'lunch_end' then
    if a.lunch_out is null then return json_build_object('ok', false, 'error', 'Start lunch first.'); end if;
    if a.lunch_in is not null then return json_build_object('ok', false, 'error', 'Lunch already ended.'); end if;
    update attendance set lunch_in = now() where id = a.id;
  elsif p_action = 'out' then
    if a.time_in is null then return json_build_object('ok', false, 'error', 'Clock in first.'); end if;
    if a.time_out is not null then return json_build_object('ok', false, 'error', 'You already clocked out.'); end if;
    if a.lunch_out is not null and a.lunch_in is null then
      return json_build_object('ok', false, 'error', 'End your lunch before clocking out.');
    end if;
    update attendance set time_out = now(), note = coalesce(v_note, note) where id = a.id;
  elsif p_action = 'note' then
    if a.id is null then return json_build_object('ok', false, 'error', 'Clock in first.'); end if;
    update attendance set note = v_note where id = a.id;
  elsif p_action = 'ot_start' then
    if s.ot_carry_from is null then return json_build_object('ok', false, 'error', 'After-hours OT isn''t turned on for you. Ask an admin.'); end if;
    if exists (select 1 from ot_sessions where staff_id = p_staff and ended_at is null) then
      return json_build_object('ok', false, 'error', 'You''re already on after-hours OT. Tap End OT first.');
    end if;
    if a.time_in is not null and a.time_out is null then
      return json_build_object('ok', false, 'error', 'Clock out of your shift first, then start after-hours OT.');
    end if;
    if v_note is null then return json_build_object('ok', false, 'error', 'Add a short note: who asked and what it''s for.'); end if;
    if a.time_in is null then
      -- Pre-shift OT on a working day, or rest-day OT (every minute counts). Not on leave or a holiday.
      v_kind := 'shift';
      if to_regprocedure('public.day_schedule(uuid,date)') is not null then
        execute 'select kind, start_time, end_time from public.day_schedule($1, $2)' into v_kind, v_ss, v_se using p_staff, v_day;
      end if;
      if v_kind not in ('shift', 'rest') then
        return json_build_object('ok', false, 'error', 'You''re off today (leave or a holiday). Ask an admin to add the OT if you were called in.');
      end if;
      if a.id is null then   -- the day starts with the OT; on a working day Clock in later fills in the shift
        insert into attendance (staff_id, work_date, sched_start, sched_end, plan_start, plan_end)
          values (p_staff, v_day, coalesce(v_ss, s.sched_start), coalesce(v_se, s.sched_end), coalesce(v_ss, s.sched_start), coalesce(v_se, s.sched_end));
      end if;
    end if;
    insert into ot_sessions (staff_id, work_date, started_at, note) values (p_staff, v_day, now(), left(v_note, 300));
  elsif p_action = 'ot_end' then
    select * into o from ot_sessions where staff_id = p_staff and ended_at is null for update;
    if not found then return json_build_object('ok', false, 'error', 'You''re not on after-hours OT.'); end if;
    update ot_sessions set ended_at = least(now(), o.started_at + interval '4 hours'),
      auto_stopped = now() > o.started_at + interval '4 hours' where id = o.id;
  elsif p_action <> 'check' then
    return json_build_object('ok', false, 'error', 'Unknown action.');
  end if;

  return json_build_object(
    'ok', true,
    'now', now(),
    'staff', json_build_object('id', s.id, 'display_name', s.display_name, 'full_name', s.full_name,
               'sched_start', s.sched_start, 'sched_end', s.sched_end, 'lunch_mins', s.lunch_mins, 'week_pattern', s.week_pattern,
               'avatar', s.avatar, 'photo', s.photo, 'tagline', s.tagline, 'color', s.color, 'ot_carry_from', s.ot_carry_from),
    'settings', (select json_build_object('timezone', timezone, 'grace_mins', grace_mins,
               'ot_block_mins', ot_block_mins, 'count_early', count_early, 'flex_hours', flex_hours, 'ot_bank_cap_mins', ot_bank_cap_mins, 'ot_daily_use_mins', ot_daily_use_mins) from settings where id = 1),
    -- this month + last month, for the personal OT bank (a carry-over bank goes back to when it started)
    'rows', coalesce((select json_agg(x order by x.work_date) from (
               select work_date, sched_start, sched_end, plan_start, plan_end, ot_adjust, after_mins, day_kind, time_in, lunch_out, lunch_in, time_out, note
               from attendance where staff_id = p_staff
                 and work_date >= least(date_trunc('month', v_day - interval '1 month')::date, coalesce(s.ot_carry_from - 5, v_day))) x), '[]'::json),
    -- after-hours OT sessions on those days, and the one running now (if any)
    'ot_sessions', coalesce((select json_agg(json_build_object('id', id, 'work_date', work_date, 'started_at', started_at, 'ended_at', ended_at,
               'note', note, 'auto_stopped', auto_stopped) order by started_at)
               from ot_sessions where staff_id = p_staff and work_date >= date_trunc('month', v_day - interval '1 month')::date), '[]'::json)
  );
end $$;

-- Staff list for the admin page, with has_pin but never the PIN hash itself
-- (4-digit PINs are guessable offline, so the hash stays unreadable to every login).
create or replace function public.admin_staff() returns json
language sql stable security definer set search_path = public as $$
  select case when not public.is_admin() then '[]'::json else coalesce((
    select json_agg(json_build_object('id', id, 'full_name', full_name, 'display_name', display_name,
      'sched_start', sched_start, 'sched_end', sched_end, 'lunch_mins', lunch_mins, 'active', active,
      'has_pin', pin_hash is not null, 'created_at', created_at,
      'avatar', avatar, 'photo', photo, 'tagline', tagline, 'color', color) order by display_name)
    from staff), '[]'::json) end;
$$;

-- Staff set their own avatar / photo / tagline / colour (PIN-checked).
create or replace function public.set_profile(p_staff uuid, p_pin text, p_avatar text, p_photo text, p_tagline text, p_color text)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_err text; v_photo text := nullif(p_photo, ''); v_tag text := nullif(btrim(coalesce(p_tagline, '')), '');
begin
  v_err := _check_pin(p_staff, p_pin);
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  if p_avatar is not null and p_avatar !~ '^[a-z0-9-]{1,24}$' then return json_build_object('ok', false, 'error', 'Unknown avatar.'); end if;
  if p_color is not null and p_color !~ '^[a-z0-9-]{1,24}$' then return json_build_object('ok', false, 'error', 'Unknown colour.'); end if;
  if v_photo is not null and (v_photo !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' or length(v_photo) > 60000) then
    return json_build_object('ok', false, 'error', 'Photo is too large or not an image. Try another one.');
  end if;
  if v_tag is not null and length(v_tag) > 40 then return json_build_object('ok', false, 'error', 'Keep your tagline to 40 characters.'); end if;
  update staff set avatar = p_avatar, photo = v_photo, tagline = v_tag, color = p_color where id = p_staff;
  return json_build_object('ok', true);
end $$;

-- ---------- Permissions ----------
revoke all on function public._check_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.roster() to anon, authenticated;
grant execute on function public.set_pin(uuid, text, text) to anon, authenticated;
grant execute on function public.punch(uuid, text, text, time, time, text) to anon, authenticated;
grant execute on function public.set_profile(uuid, text, text, text, text, text) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_full_admin() to authenticated;
grant execute on function public.my_role() to authenticated;
grant execute on function public.admin_staff() to authenticated;
revoke all on function public._ot_day_sync(uuid, date) from public, anon, authenticated;
revoke all on function public._ot_sessions_sync() from public, anon, authenticated;
revoke all on function public.ot_autostop() from public, anon;
grant execute on function public.ot_autostop() to authenticated;
grant select, insert, update, delete on public.ot_sessions to authenticated;
-- Signed-in users can't read PIN hashes or lock-out counters directly.
revoke select on public.staff from anon, authenticated;
grant select (id, full_name, display_name, sched_start, sched_end, lunch_mins, active, created_at, avatar, photo, tagline, color, ot_carry_from) on public.staff to authenticated;

-- ---------- Make yourself the first admin (one time) ----------
-- 1. Supabase → Authentication → Users → Add user (your email + a password, tick Auto confirm).
-- 2. Run:  insert into public.admins (user_id, email, role)
--          select id, email, 'admin' from auth.users where email = 'you@example.com';
-- After that, create every other login from the Admin page → Access tab.
