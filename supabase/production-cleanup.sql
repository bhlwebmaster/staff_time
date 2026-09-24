-- ============================================================
-- BHL Attendance: clear test entries before going live (OPTIONAL)
-- Run in Supabase -> SQL Editor. Nothing is deleted until you
-- remove the "--" in front of the DELETE lines you want.
-- Staff, PINs, profiles and admin logins are always kept.
-- ============================================================

-- 1) LOOK FIRST: what's in the database right now
select s.display_name, a.work_date, a.time_in, a.time_out, a.source
from public.attendance a join public.staff s on s.id = a.staff_id
order by a.work_date, s.display_name;

-- 2) Choose ONE option, remove the "--" in front of its lines, then Run again.

-- Option A: delete everything before your go-live date (change the date)
-- delete from public.attendance where work_date < date '2026-09-28';

-- Option B: delete only the entries imported from WhatsApp by seed.sql
-- delete from public.attendance where source = 'import';

-- Option C: delete ALL attendance and start completely fresh
-- delete from public.attendance;

-- Also clear the edit history for the deleted entries (recommended with A, B or C)
-- delete from public.audit_log where (staff_id, work_date) not in (select staff_id, work_date from public.attendance);

-- Optional: remove a test staff member completely (their entries go too)
-- delete from public.staff where display_name = 'Test';
