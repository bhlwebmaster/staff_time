-- ============================================================
-- BHL Attendance: FULL DATABASE UPDATE (core + payroll + weekly schedule + schedule requests)
-- Paste all of this into Supabase → SQL Editor → Run. Safe to run again; keeps all data.
-- ============================================================
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
  foreach t in array array['settings', 'staff', 'attendance'] loop
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

-- ---------- Staff-facing functions (callable with the public anon key) ----------

-- Who's on the team + today's status. No PINs, no history.
create or replace function public.roster() returns json
language sql stable security definer set search_path = public as $$
  with s as (select * from settings where id = 1),
  d as (select (now() at time zone (select timezone from s))::date as today)
  select json_build_object(
    'now',      now(),
    'today',    (select today from d),
    'settings', (select json_build_object('timezone', timezone, 'grace_mins', grace_mins,
                   'ot_block_mins', ot_block_mins, 'count_early', count_early, 'company_name', company_name) from s),
    'staff', coalesce((
      select json_agg(json_build_object(
        'id', st.id, 'display_name', st.display_name, 'full_name', st.full_name,
        'has_pin', st.pin_hash is not null,
        'sched_start', st.sched_start, 'sched_end', st.sched_end, 'lunch_mins', st.lunch_mins,
        'avatar', st.avatar, 'photo', st.photo, 'tagline', st.tagline, 'color', st.color,
        'recent', coalesce((select json_agg(json_build_object('work_date', r.work_date, 'sched_start', r.sched_start,
            'sched_end', r.sched_end, 'time_in', r.time_in, 'lunch_out', r.lunch_out, 'lunch_in', r.lunch_in,
            'time_out', r.time_out) order by r.work_date)
          from attendance r where r.staff_id = st.id and r.work_date >= (select today from d) - 45), '[]'::json),
        'today', case when a.id is null then null else json_build_object(
            'sched_start', a.sched_start, 'sched_end', a.sched_end,
            'time_in', a.time_in, 'lunch_out', a.lunch_out, 'lunch_in', a.lunch_in, 'time_out', a.time_out) end
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

-- The one staff action: check | in | lunch_start | lunch_end | out | note
-- Uses the SERVER clock, so phone time can't be faked.
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
begin
  v_err := _check_pin(p_staff, p_pin);
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;

  select timezone into v_tz from settings where id = 1;
  v_day := (now() at time zone v_tz)::date;
  select * into s from staff where id = p_staff;
  select * into a from attendance where staff_id = p_staff and work_date = v_day for update;
  perform set_config('bhl.actor', 'staff: ' || s.display_name, true);

  if p_action = 'in' then
    if a.time_in is not null then return json_build_object('ok', false, 'error', 'You already clocked in today.'); end if;
    if p_sched_start is not null and coalesce(p_sched_end, s.sched_end) <= p_sched_start then
      return json_build_object('ok', false, 'error', 'Schedule end must be after start.');
    end if;
    -- Default to the day's planned schedule (weekly schedule add-on), else the usual hours
    if p_sched_start is null and to_regprocedure('public.day_schedule(uuid,date)') is not null then
      execute 'select start_time, end_time from public.day_schedule($1, $2)' into v_ss, v_se using p_staff, v_day;
    end if;
    insert into attendance (staff_id, work_date, sched_start, sched_end, time_in, note)
      values (p_staff, v_day, coalesce(p_sched_start, v_ss, s.sched_start), coalesce(p_sched_end, v_se, s.sched_end), now(), v_note);
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
  elsif p_action <> 'check' then
    return json_build_object('ok', false, 'error', 'Unknown action.');
  end if;

  return json_build_object(
    'ok', true,
    'now', now(),
    'staff', json_build_object('id', s.id, 'display_name', s.display_name, 'full_name', s.full_name,
               'sched_start', s.sched_start, 'sched_end', s.sched_end, 'lunch_mins', s.lunch_mins,
               'avatar', s.avatar, 'photo', s.photo, 'tagline', s.tagline, 'color', s.color),
    'settings', (select json_build_object('timezone', timezone, 'grace_mins', grace_mins,
               'ot_block_mins', ot_block_mins, 'count_early', count_early) from settings where id = 1),
    -- this month + last month, for the personal OT bank
    'rows', coalesce((select json_agg(x order by x.work_date) from (
               select work_date, sched_start, sched_end, time_in, lunch_out, lunch_in, time_out, note
               from attendance where staff_id = p_staff
                 and work_date >= date_trunc('month', v_day - interval '1 month')::date) x), '[]'::json)
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
-- Signed-in users can't read PIN hashes or lock-out counters directly.
revoke select on public.staff from anon, authenticated;
grant select (id, full_name, display_name, sched_start, sched_end, lunch_mins, active, created_at, avatar, photo, tagline, color) on public.staff to authenticated;

-- ---------- Make yourself the first admin (one time) ----------
-- 1. Supabase → Authentication → Users → Add user (your email + a password, tick Auto confirm).
-- 2. Run:  insert into public.admins (user_id, email, role)
--          select id, email, 'admin' from auth.users where email = 'you@example.com';
-- After that, create every other login from the Admin page → Access tab.
-- ============================================================
-- BHL Attendance: PAYROLL add-on
-- Run once in Supabase → SQL Editor after schema.sql. Safe to re-run.
-- ============================================================

-- Pay details on each staff member
alter table public.staff add column if not exists start_date date;              -- employment start date
alter table public.staff add column if not exists pay_rate   numeric(12,2);     -- GBP: per day (daily) or per pay period
-- 'daily'  = paid for each day worked (plus paid leave) × daily rate
-- 'period' = fixed amount per pay period, minus absences
alter table public.staff add column if not exists pay_type   text not null default 'daily';
alter table public.staff drop constraint if exists staff_pay_type_check;
alter table public.staff add constraint staff_pay_type_check check (pay_type in ('daily', 'period'));

-- A pay period (created by an admin each time)
create table if not exists public.pay_periods (
  id              uuid primary key default gen_random_uuid(),
  start_date      date not null,
  end_date        date not null,
  pay_date        date not null,
  exchange_rate   numeric(12,4),                  -- PHP per 1 GBP
  transfer_fee    numeric(12,2) not null default 0, -- total transfer fee for the batch, in PHP
  status          text not null default 'draft' check (status in ('draft', 'final')),
  created_at      timestamptz not null default now(),
  check (end_date >= start_date)
);

-- One payslip per person per period (a snapshot; overrides kept separately)
create table if not exists public.payslips (
  id              uuid primary key default gen_random_uuid(),
  period_id       uuid not null references public.pay_periods(id) on delete cascade,
  staff_id        uuid not null references public.staff(id) on delete cascade,
  employee_name   text not null,
  start_date      date,
  rate            numeric(12,2) not null default 0,
  pay_type        text not null default 'daily',
  days_scheduled  int not null default 0,
  days_worked     int not null default 0,
  late_mins       int not null default 0,
  undertime_mins  int not null default 0,
  absences        numeric(5,1) not null default 0,
  late_ded        numeric(12,2) not null default 0,
  undertime_ded   numeric(12,2) not null default 0,
  absence_ded     numeric(12,2) not null default 0,
  other_ded       numeric(12,2) not null default 0,   -- CA, loans, taxes
  other_note      text,
  total_ded       numeric(12,2) not null default 0,
  gross           numeric(12,2) not null default 0,
  net             numeric(12,2) not null default 0,
  exchange_rate   numeric(12,4),
  gross_php       numeric(14,2),
  net_php         numeric(14,2),
  fee_share       numeric(7,4),                        -- 0.2258 = 22.58%
  fee_php         numeric(14,2),
  received_php    numeric(14,2),
  overrides       jsonb not null default '{}'::jsonb,  -- values an admin typed over the automatic ones
  updated_at      timestamptz not null default now(),
  unique (period_id, staff_id)
);

alter table public.payslips add column if not exists pay_type text not null default 'daily';
alter table public.payslips add column if not exists paid_days numeric(5,1) not null default 0;

alter table public.pay_periods enable row level security;
alter table public.payslips    enable row level security;
do $$
declare t text;
begin
  foreach t in array array['pay_periods', 'payslips'] loop
    execute format('drop policy if exists team_read on public.%I', t);
    execute format('drop policy if exists admin_write on public.%I', t);
    execute format('create policy team_read on public.%I for select to authenticated using (public.is_admin())', t);
    execute format('create policy admin_write on public.%I for all to authenticated using (public.is_full_admin()) with check (public.is_full_admin())', t);
  end loop;
end $$;
grant select, insert, update, delete on public.pay_periods, public.payslips to authenticated;
grant select (start_date, pay_rate, pay_type) on public.staff to authenticated;

-- Staff list for admins now includes pay details
create or replace function public.admin_staff() returns json
language sql stable security definer set search_path = public as $$
  select case when not public.is_admin() then '[]'::json else coalesce((
    select json_agg(json_build_object('id', id, 'full_name', full_name, 'display_name', display_name,
      'sched_start', sched_start, 'sched_end', sched_end, 'lunch_mins', lunch_mins, 'active', active,
      'has_pin', pin_hash is not null, 'created_at', created_at,
      'avatar', avatar, 'photo', photo, 'tagline', tagline, 'color', color,
      'start_date', start_date, 'pay_rate', pay_rate, 'pay_type', pay_type) order by display_name)
    from staff), '[]'::json) end;
$$;

-- Staff see ONLY their own FINALISED payslips, with their PIN.
create or replace function public.my_payslips(p_staff uuid, p_pin text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_err text;
begin
  v_err := _check_pin(p_staff, p_pin);
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  return json_build_object('ok', true,
    'company', (select company_name from settings where id = 1),
    'payslips', coalesce((select json_agg(x order by x.pay_date desc) from (
      select ps.*, pp.start_date as period_start, pp.end_date as period_end, pp.pay_date
      from payslips ps join pay_periods pp on pp.id = ps.period_id
      where ps.staff_id = p_staff and pp.status = 'final') x), '[]'::json));
end $$;
grant execute on function public.my_payslips(uuid, text) to anon, authenticated;

-- Refresh Supabase's column list so the app sees changes immediately
notify pgrst, 'reload schema';
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
  kind        text not null check (kind in ('shift', 'rest', 'vacation', 'sick', 'holiday', 'unpaid')),
  start_time  time,
  end_time    time,
  note        text,
  unique (staff_id, work_date)
);
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
    if coalesce(v->>'kind', '') not in ('shift', 'rest', 'vacation', 'sick', 'unpaid') then
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
      select * into pd from _pattern_day(r.staff_id, k::date);
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
revoke all on function public._team_today() from public, anon, authenticated;
grant execute on function public.request_week(uuid, text, date, jsonb, text) to anon, authenticated;
grant execute on function public.my_schedule_requests(uuid, text) to anon, authenticated;
grant execute on function public.cancel_schedule_request(uuid, text, uuid) to anon, authenticated;
grant execute on function public.decide_schedule_request(uuid, boolean, text) to authenticated;

notify pgrst, 'reload schema';
