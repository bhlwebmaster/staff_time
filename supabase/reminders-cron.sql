-- ============================================================
-- BHL Attendance: run the shift reminders every 5 minutes (one time setup, after deploying send-reminders)
-- Do this LAST: after database-update.sql, the Edge Function secrets and deploying send-reminders.
-- 1. Replace PASTE-CRON-SECRET-HERE below with the CRON_SECRET you saved as an Edge Function secret.
-- 2. Run this in SQL Editor. It turns on pg_cron and pg_net itself. Safe to re-run (it replaces the job).
-- To stop reminders completely:  select cron.unschedule('bhl-shift-reminders');
-- ============================================================
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
select cron.unschedule('bhl-shift-reminders') where exists (select 1 from cron.job where jobname = 'bhl-shift-reminders');
select cron.schedule('bhl-shift-reminders', '*/5 * * * *', $$
  select net.http_post(
    url     := 'https://qvcaflgabaqhzruaircy.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'PASTE-CRON-SECRET-HERE'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000);
$$);
-- Old run history piles up: keep a week
select cron.unschedule('bhl-cron-cleanup') where exists (select 1 from cron.job where jobname = 'bhl-cron-cleanup');
select cron.schedule('bhl-cron-cleanup', '17 3 * * *', $$ delete from cron.job_run_details where end_time < now() - interval '7 days' $$);
