-- ============================================================================
-- ELMS (Employee Leave Management System) — Supabase Schema
-- ============================================================================
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste → Run
-- Safe to re-run on a fresh project. Drops nothing existing by accident since
-- it uses IF NOT EXISTS / OR REPLACE where sensible.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extensions
-- ----------------------------------------------------------------------------
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- Enum types
-- ----------------------------------------------------------------------------
do $$ begin
  create type public.user_role as enum ('Employee', 'Manager', 'HR Admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.leave_type as enum ('Casual', 'Sick', 'Earned');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.leave_status as enum ('Pending', 'Approved', 'Rejected');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

-- One row per company / tenant
create table if not exists public.companies (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,       -- e.g. COMP-1234, shown to HR to share
  name       text not null,
  created_at timestamptz not null default now()
);

-- One row per user, 1:1 with auth.users. This is what replaces your old
-- "elms_users" localStorage array. Passwords are NOT stored here — Supabase
-- Auth handles credentials securely.
create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  name           text not null,
  email          text not null,
  role           public.user_role not null,
  company_id     uuid not null references public.companies(id) on delete cascade,
  casual_balance numeric not null default 12,
  sick_balance   numeric not null default 10,
  earned_balance numeric not null default 15,
  created_at     timestamptz not null default now()
);

-- Replaces "elms_requests"
create table if not exists public.leave_requests (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  user_name         text not null,
  company_id        uuid not null references public.companies(id) on delete cascade,
  leave_type        public.leave_type not null,
  start_date        date not null,
  end_date          date not null,
  reason            text not null,
  status            public.leave_status not null default 'Pending',
  rejection_reason  text,
  created_at        timestamptz not null default now(),
  check (end_date >= start_date)
);

create index if not exists idx_profiles_company on public.profiles (company_id);
create index if not exists idx_requests_company on public.leave_requests (company_id);
create index if not exists idx_requests_user on public.leave_requests (user_id);
create index if not exists idx_requests_status on public.leave_requests (status);

-- ----------------------------------------------------------------------------
-- Auto-generate a unique company code on insert, if one wasn't supplied
-- ----------------------------------------------------------------------------
create or replace function public.generate_company_code()
returns text
language plpgsql
as $$
declare
  v_code text;
  v_exists boolean;
begin
  loop
    v_code := 'COMP-' || floor(random() * 9000 + 1000)::int;
    select exists(select 1 from public.companies where code = v_code) into v_exists;
    exit when not v_exists;
  end loop;
  return v_code;
end;
$$;

create or replace function public.set_company_code()
returns trigger
language plpgsql
as $$
begin
  if new.code is null or new.code = '' then
    new.code := public.generate_company_code();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_company_code on public.companies;
create trigger trg_set_company_code
  before insert on public.companies
  for each row execute function public.set_company_code();

-- ----------------------------------------------------------------------------
-- Helper functions used inside RLS policies (SECURITY DEFINER so they can
-- read profiles without recursing into the policies that call them)
-- ----------------------------------------------------------------------------
create or replace function public.current_company_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select company_id from public.profiles where id = auth.uid();
$$;

create or replace function public.current_role()
returns public.user_role
language sql stable security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.leave_requests enable row level security;

-- companies: code needs to be look-up-able during signup (before a profile
-- exists), so allow read to anyone. Nothing sensitive lives on this table.
drop policy if exists "companies_select_all" on public.companies;
create policy "companies_select_all" on public.companies
  for select using (true);

drop policy if exists "companies_insert_authenticated" on public.companies;
create policy "companies_insert_authenticated" on public.companies
  for insert to authenticated
  with check (true);

-- profiles
drop policy if exists "profiles_select_own_or_company" on public.profiles;
create policy "profiles_select_own_or_company" on public.profiles
  for select using (
    id = auth.uid()
    or company_id = public.current_company_id()
  );

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

-- Only Managers/HR Admins can adjust balances (used by approve_leave_request)
drop policy if exists "profiles_update_by_manager_hr" on public.profiles;
create policy "profiles_update_by_manager_hr" on public.profiles
  for update using (
    company_id = public.current_company_id()
    and public.current_role() in ('Manager', 'HR Admin')
  );

-- leave_requests
drop policy if exists "requests_select_own_or_company_manager" on public.leave_requests;
create policy "requests_select_own_or_company_manager" on public.leave_requests
  for select using (
    user_id = auth.uid()
    or (
      company_id = public.current_company_id()
      and public.current_role() in ('Manager', 'HR Admin')
    )
  );

drop policy if exists "requests_insert_own" on public.leave_requests;
create policy "requests_insert_own" on public.leave_requests
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and company_id = public.current_company_id()
  );

drop policy if exists "requests_update_by_manager_hr" on public.leave_requests;
create policy "requests_update_by_manager_hr" on public.leave_requests
  for update using (
    company_id = public.current_company_id()
    and public.current_role() in ('Manager', 'HR Admin')
  );

-- ----------------------------------------------------------------------------
-- Approve a leave request + deduct balance atomically (avoids a race between
-- the two separate writes the old localStorage code did one after another)
-- ----------------------------------------------------------------------------
create or replace function public.approve_leave_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.leave_requests;
  v_days int;
begin
  select * into v_request from public.leave_requests where id = p_request_id;

  if v_request is null then
    raise exception 'Request not found';
  end if;

  if public.current_role() not in ('Manager', 'HR Admin')
     or v_request.company_id <> public.current_company_id() then
    raise exception 'Not authorized to approve this request';
  end if;

  if v_request.status <> 'Pending' then
    raise exception 'Request is not pending';
  end if;

  v_days := (v_request.end_date - v_request.start_date) + 1;

  update public.leave_requests set status = 'Approved' where id = p_request_id;

  if v_request.leave_type = 'Casual' then
    update public.profiles set casual_balance = casual_balance - v_days where id = v_request.user_id;
  elsif v_request.leave_type = 'Sick' then
    update public.profiles set sick_balance = sick_balance - v_days where id = v_request.user_id;
  else
    update public.profiles set earned_balance = earned_balance - v_days where id = v_request.user_id;
  end if;
end;
$$;

grant execute on function public.approve_leave_request(uuid) to authenticated;

-- Reject is just a status + reason update, allowed already via the
-- "requests_update_by_manager_hr" policy — no RPC needed for it.

-- ============================================================================
-- Done. Next: create your first HR Admin account from the app's sign-up form,
-- which will insert a row into companies and profiles automatically.
-- ============================================================================
