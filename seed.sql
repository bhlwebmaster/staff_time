-- Optional: your current team + the entries already posted in the WhatsApp group.
-- Run after schema.sql. Staff create their own 4-digit PIN the first time they open the app.

insert into public.staff (id, full_name, display_name, sched_start, sched_end, lunch_mins) values
  ('11111111-1111-4111-8111-111111111111', 'BINGHOY, RAE',  'Rae',  '05:00', '14:00', 60),
  ('22222222-2222-4222-8222-222222222222', 'ALISEN, CESS',  'Cess', '06:00', '15:00', 60)
on conflict (id) do nothing;

select set_config('bhl.actor', 'import: WhatsApp', false);

-- Times below are UTC (UK is on BST, UTC+1, until 25 Oct 2026).
insert into public.attendance (staff_id, work_date, sched_start, sched_end, time_in, lunch_out, lunch_in, time_out, note, source) values
  ('11111111-1111-4111-8111-111111111111', '2026-09-22', '06:00', '14:00',
     '2026-09-22 04:42Z', null, null, '2026-09-22 14:10Z', 'Offset against 1-hour OT completed on Friday, September 18, 2026', 'import'),
  ('22222222-2222-4222-8222-222222222222', '2026-09-22', '06:00', '15:00',
     '2026-09-22 04:59Z', null, null, '2026-09-22 14:36Z', null, 'import'),
  ('11111111-1111-4111-8111-111111111111', '2026-09-23', '05:00', '14:00',
     '2026-09-23 03:52Z', '2026-09-23 11:10Z', '2026-09-23 12:10Z', null, null, 'import'),
  ('22222222-2222-4222-8222-222222222222', '2026-09-23', '06:30', '15:00',
     '2026-09-23 05:25Z', null, null, null, 'Offset against 30-minute OT yesterday', 'import')
on conflict (staff_id, work_date) do nothing;
