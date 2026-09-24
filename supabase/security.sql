-- ============================================================
-- BHL Attendance: SECURITY TIDY-UP (Supabase Security Advisor)
-- Locks every internal / admin-only function to the people who need it. Safe to re-run.
--
-- Staff-app functions (roster, punch, set_pin, set_profile, my_payslips, week_schedule,
-- request_week, my_schedule_requests, cancel_schedule_request) stay callable without signing in
-- ON PURPOSE: staff don't have logins. Each one checks the staff PIN (bcrypt, 5 tries then a
-- 15-minute lock) before doing anything, and roster/week_schedule only show names and schedules.
-- The Security Advisor will keep listing those as warnings; that's expected.
-- ============================================================

-- Internal helpers and the audit trigger: nobody calls these directly
revoke execute on function public._check_pin(uuid, text)          from public, anon, authenticated;
revoke execute on function public.day_schedule(uuid, date)        from public, anon, authenticated;
revoke execute on function public._pattern_day(uuid, date)        from public, anon, authenticated;
revoke execute on function public._base_day(uuid, date)           from public, anon, authenticated;
revoke execute on function public._team_today()                   from public, anon, authenticated;
revoke execute on function public.attendance_audit()              from public, anon, authenticated;

-- Admin / finance only: signed-in users (each one also checks the admin role inside)
revoke execute on function public.admin_staff()                               from public, anon;
revoke execute on function public.decide_schedule_request(uuid, boolean, text) from public, anon;
revoke execute on function public.is_admin()                                  from public, anon;
revoke execute on function public.is_full_admin()                             from public, anon;
revoke execute on function public.my_role()                                   from public, anon;
grant  execute on function public.admin_staff()                               to authenticated;
grant  execute on function public.decide_schedule_request(uuid, boolean, text) to authenticated;
grant  execute on function public.is_admin()                                  to authenticated;
grant  execute on function public.is_full_admin()                             to authenticated;
grant  execute on function public.my_role()                                   to authenticated;

-- Staff app (no login, PIN-checked)
grant execute on function public.roster()                                                   to anon, authenticated;
grant execute on function public.week_schedule(date)                                        to anon, authenticated;
grant execute on function public.punch(uuid, text, text, time, time, text)                  to anon, authenticated;
grant execute on function public.set_pin(uuid, text, text)                                  to anon, authenticated;
grant execute on function public.set_profile(uuid, text, text, text, text, text)            to anon, authenticated;
grant execute on function public.my_payslips(uuid, text)                                    to anon, authenticated;
grant execute on function public.request_week(uuid, text, date, jsonb, text)                to anon, authenticated;
grant execute on function public.my_schedule_requests(uuid, text)                           to anon, authenticated;
grant execute on function public.cancel_schedule_request(uuid, text, uuid)                  to anon, authenticated;

notify pgrst, 'reload schema';
