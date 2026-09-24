-- ============================================================
-- BHL Attendance: PAYROLL add-on
-- Run once in Supabase → SQL Editor after schema.sql. Safe to re-run.
-- ============================================================

-- Pay details on each staff member
alter table public.staff add column if not exists start_date date;              -- employment start date
alter table public.staff add column if not exists pay_rate   numeric(12,2);     -- GBP per pay period (bi-weekly)

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
grant select (start_date, pay_rate) on public.staff to authenticated;

-- Staff list for admins now includes pay details
create or replace function public.admin_staff() returns json
language sql stable security definer set search_path = public as $$
  select case when not public.is_admin() then '[]'::json else coalesce((
    select json_agg(json_build_object('id', id, 'full_name', full_name, 'display_name', display_name,
      'sched_start', sched_start, 'sched_end', sched_end, 'lunch_mins', lunch_mins, 'active', active,
      'has_pin', pin_hash is not null, 'created_at', created_at,
      'avatar', avatar, 'photo', photo, 'tagline', tagline, 'color', color,
      'start_date', start_date, 'pay_rate', pay_rate) order by display_name)
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
