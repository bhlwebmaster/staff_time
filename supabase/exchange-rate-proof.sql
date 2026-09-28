-- ============================================================
-- BHL Attendance: EXCHANGE-RATE PROOF (screenshot per pay period)
-- Run once in Supabase → SQL Editor after payroll.sql. Safe to re-run.
--
-- Each pay period can hold one screenshot (or PDF) showing the GBP → PHP
-- rate the payroll transfer was sent at. Files live in a PRIVATE storage
-- bucket: only admin and finance logins can open them; admins upload,
-- replace and remove. Staff (name + PIN) can never see or list them.
-- ============================================================

-- Where the proof file is, and who uploaded it
alter table public.pay_periods add column if not exists fx_proof_path        text;        -- path inside the fx-proofs bucket
alter table public.pay_periods add column if not exists fx_proof_name        text;        -- original file name, for display
alter table public.pay_periods add column if not exists fx_proof_uploaded_at timestamptz;
alter table public.pay_periods add column if not exists fx_proof_uploaded_by text;        -- admin email, set by the server

-- The server fills in who/when, so it can't be typed in from the browser
create or replace function public._fx_proof_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if tg_op = 'UPDATE' then v_old := old.fx_proof_path; end if;
  if new.fx_proof_path is null then
    new.fx_proof_name := null; new.fx_proof_uploaded_at := null; new.fx_proof_uploaded_by := null;
  elsif new.fx_proof_path is distinct from v_old then
    -- new or replaced file: stamp who and when
    new.fx_proof_uploaded_at := now();
    new.fx_proof_uploaded_by := (select email from public.admins where user_id = auth.uid());
  else
    -- same file: keep the original stamp
    new.fx_proof_uploaded_at := old.fx_proof_uploaded_at;
    new.fx_proof_uploaded_by := old.fx_proof_uploaded_by;
  end if;
  return new;
end $$;
revoke execute on function public._fx_proof_stamp() from public, anon, authenticated;

drop trigger if exists fx_proof_stamp on public.pay_periods;
create trigger fx_proof_stamp before insert or update on public.pay_periods
  for each row execute function public._fx_proof_stamp();

-- Private bucket: images or PDF, up to 5 MB each
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fx-proofs', 'fx-proofs', false, 5242880,
        array['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Who can do what with the files (anon = staff app: nothing at all)
drop policy if exists fx_proofs_read   on storage.objects;
drop policy if exists fx_proofs_insert on storage.objects;
drop policy if exists fx_proofs_update on storage.objects;
drop policy if exists fx_proofs_delete on storage.objects;
create policy fx_proofs_read   on storage.objects for select to authenticated
  using (bucket_id = 'fx-proofs' and public.is_admin());          -- admin + finance
create policy fx_proofs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'fx-proofs' and public.is_full_admin()); -- admin only
create policy fx_proofs_update on storage.objects for update to authenticated
  using (bucket_id = 'fx-proofs' and public.is_full_admin())
  with check (bucket_id = 'fx-proofs' and public.is_full_admin());
create policy fx_proofs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'fx-proofs' and public.is_full_admin());

-- Refresh Supabase's column list so the app sees changes immediately
notify pgrst, 'reload schema';
