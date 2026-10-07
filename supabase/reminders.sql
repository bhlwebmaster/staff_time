-- ============================================================
-- BHL Attendance: SHIFT REMINDERS (push notifications) add-on
-- Before the shift starts, a lunch nudge, and before the shift ends. Admins set the times and messages.
-- Sent by the "send-reminders" Edge Function every 5 minutes (see README → Reminders). Safe to re-run.
-- ============================================================

-- Phones that turned reminders on (one row per phone/browser)
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references public.staff(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz
);

-- The three reminders. start: minutes BEFORE the shift starts; lunch: minutes AFTER it starts; end: minutes BEFORE it ends.
create table if not exists public.notify_rules (
  kind         text primary key check (kind in ('start', 'lunch', 'end')),
  enabled      boolean not null default true,
  offset_mins  int not null check (offset_mins between 0 and 720),
  title        text not null,
  body         text not null
);
insert into public.notify_rules (kind, offset_mins, title, body) values
  ('start', 30,  'Ready to start work?', 'Your shift starts in 30 minutes. Open the app to clock in when you start.'),
  ('lunch', 240, 'Time for a break', 'Rest first and take your lunch. Work-life balance matters. (Just a reminder: tap Start lunch in the app when you go.)'),
  ('end',   30,  'Time to wrap up', 'Your shift ends in 30 minutes. Wrap up and make sure everything scheduled for today is done.')
on conflict (kind) do nothing;

-- What was sent, so nobody gets the same reminder twice in a day
create table if not exists public.notify_log (
  staff_id   uuid not null references public.staff(id) on delete cascade,
  work_date  date not null,
  kind       text not null,
  sent_at    timestamptz not null default now(),
  primary key (staff_id, work_date, kind)
);

-- The browser half of the push keys (the private half is an Edge Function secret)
alter table public.settings add column if not exists push_public_key text;

alter table public.push_subscriptions enable row level security;
alter table public.notify_rules       enable row level security;
alter table public.notify_log         enable row level security;
drop policy if exists team_read on public.notify_rules;
drop policy if exists admin_write on public.notify_rules;
create policy team_read on public.notify_rules for select to authenticated using (public.is_admin());
create policy admin_write on public.notify_rules for all to authenticated using (public.is_full_admin()) with check (public.is_full_admin());
grant select, insert, update, delete on public.notify_rules to authenticated;
drop policy if exists team_read on public.push_subscriptions;
create policy team_read on public.push_subscriptions for select to authenticated using (public.is_admin());
grant select (id, staff_id, user_agent, created_at, last_ok_at) on public.push_subscriptions to authenticated;
drop policy if exists team_read on public.notify_log;
create policy team_read on public.notify_log for select to authenticated using (public.is_admin());
grant select on public.notify_log to authenticated;

-- Staff: turn reminders on for this phone (PIN-checked). The same phone moves to whoever turned it on last.
create or replace function public.save_push(p_staff uuid, p_pin text, p_endpoint text, p_p256dh text, p_auth text, p_ua text)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_err text;
begin
  v_err := _check_pin(p_staff, p_pin);
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  if coalesce(p_endpoint, '') !~ '^https://' or length(p_endpoint) > 1000 or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    return json_build_object('ok', false, 'error', 'This phone didn''t give a valid notification address. Try again.');
  end if;
  insert into push_subscriptions (staff_id, endpoint, p256dh, auth, user_agent)
    values (p_staff, p_endpoint, left(p_p256dh, 200), left(p_auth, 100), left(p_ua, 300))
    on conflict (endpoint) do update set staff_id = excluded.staff_id, p256dh = excluded.p256dh, auth = excluded.auth,
      user_agent = excluded.user_agent, created_at = now();
  return json_build_object('ok', true);
end $$;

-- Staff: turn reminders off for this phone
create or replace function public.remove_push(p_staff uuid, p_pin text, p_endpoint text)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_err text;
begin
  v_err := _check_pin(p_staff, p_pin);
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  delete from push_subscriptions where endpoint = p_endpoint and staff_id = p_staff;
  return json_build_object('ok', true);
end $$;

-- For the sender only (service key): the reminders due in the last p_window_mins minutes that weren't sent yet.
-- Claims them in notify_log, so a second run never sends them again. Working days only (not rest days, leave or holidays).
--   start: before clocking in;  lunch: clocked in, no lunch yet, not clocked out;  end: clocked in, not clocked out.
create or replace function public.due_reminders(p_window_mins int default 10)
returns table (staff_id uuid, kind text, title text, body text, endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_tz text; v_day date; s record; a attendance; r notify_rules; k text; v_s time; v_e time; v_start timestamptz; v_end timestamptz; v_at timestamptz;
begin
  select timezone into v_tz from settings where id = 1;
  v_day := (now() at time zone v_tz)::date;
  for s in select st.* from staff st where st.active and exists (select 1 from push_subscriptions p where p.staff_id = st.id) loop
    select ds.kind, ds.start_time, ds.end_time into k, v_s, v_e from day_schedule(s.id, v_day) ds;
    if k is distinct from 'shift' then continue; end if;
    select * into a from attendance x where x.staff_id = s.id and x.work_date = v_day;
    -- the day's times as clocked (start later / leave earlier move them), else the schedule
    v_start := (v_day + coalesce(a.sched_start, v_s)) at time zone v_tz;
    v_end   := (v_day + coalesce(a.sched_end, v_e)) at time zone v_tz;
    if v_end <= v_start then v_end := v_end + interval '1 day'; end if;
    for r in select * from notify_rules where enabled loop
      v_at := case r.kind when 'start' then v_start - make_interval(mins => r.offset_mins)
                          when 'lunch' then v_start + make_interval(mins => r.offset_mins)
                          else v_end - make_interval(mins => r.offset_mins) end;
      if v_at > now() or v_at <= now() - make_interval(mins => p_window_mins) then continue; end if;
      if r.kind = 'start' and a.time_in is not null then continue; end if;
      if r.kind = 'lunch' and (a.time_in is null or a.lunch_out is not null or a.time_out is not null) then continue; end if;
      if r.kind = 'end' and (a.time_in is null or a.time_out is not null) then continue; end if;
      insert into notify_log (staff_id, work_date, kind) values (s.id, v_day, r.kind) on conflict do nothing;
      if not found then continue; end if;
      return query select s.id, r.kind, r.title, r.body, p.endpoint, p.p256dh, p.auth from push_subscriptions p where p.staff_id = s.id;
    end loop;
  end loop;
end $$;

revoke all on function public.due_reminders(int) from public, anon, authenticated;
grant execute on function public.due_reminders(int) to service_role;
grant execute on function public.save_push(uuid, text, text, text, text, text) to anon, authenticated;
grant execute on function public.remove_push(uuid, text, text) to anon, authenticated;
grant select, delete, update on public.push_subscriptions to service_role;
grant select, insert, update, delete on public.notify_log to service_role;

notify pgrst, 'reload schema';
