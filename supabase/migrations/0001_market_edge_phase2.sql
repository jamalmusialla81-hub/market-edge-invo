-- Market Edge Phase 2: identities, entitlements and private cloud journals.
-- Apply through the Supabase SQL editor or Supabase CLI. This migration is
-- deliberately separate from the Worker D1 research database.

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'USER' check (role in ('USER','ADMIN')),
  plan text not null default 'FREE' check (plan in ('FREE','PAID')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id uuid primary key references public.user_profiles(id) on delete cascade,
  balance numeric,
  risk_pct numeric,
  max_leverage numeric,
  max_exposure_pct numeric,
  updated_at timestamptz not null default now(),
  check (balance is null or balance >= 0),
  check (risk_pct is null or (risk_pct > 0 and risk_pct <= 1)),
  check (max_leverage is null or (max_leverage >= 1 and max_leverage <= 100)),
  check (max_exposure_pct is null or (max_exposure_pct > 0 and max_exposure_pct <= 1))
);

create table if not exists public.scan_usage (
  id uuid primary key default gen_random_uuid(),
  principal_type text not null check (principal_type in ('GUEST','USER')),
  principal_id uuid not null,
  user_id uuid references public.user_profiles(id) on delete cascade,
  guest_id uuid,
  request_id text not null check (char_length(request_id) between 8 and 160),
  scan_id text,
  usage_day_sydney date not null,
  status text not null check (status in ('RESERVED','FINALIZED','RELEASED')),
  reserved_at timestamptz not null default now(),
  finalized_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  check ((principal_type = 'USER' and user_id = principal_id and guest_id is null) or (principal_type = 'GUEST' and guest_id = principal_id and user_id is null)),
  unique (principal_id, usage_day_sydney, request_id)
);
create index if not exists scan_usage_principal_day_idx on public.scan_usage(principal_id, usage_day_sydney, status);

create table if not exists public.scan_recommendations (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null,
  scan_id text not null,
  snapshot jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (principal_id, scan_id)
);
create index if not exists scan_recommendations_principal_idx on public.scan_recommendations(principal_id, expires_at desc);

create table if not exists public.user_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles(id) on delete restrict,
  source text not null default 'MARKET_EDGE' check (source = 'MARKET_EDGE'),
  scan_id text not null,
  recommendation_id uuid not null references public.scan_recommendations(id) on delete restrict,
  snapshot jsonb not null,
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  entry_fill numeric,
  exit_price numeric,
  closed_at timestamptz,
  realized_r numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, recommendation_id)
);
create index if not exists user_trades_user_status_idx on public.user_trades(user_id, status, created_at desc);

-- RLS is deliberately enabled even though the browser receives no direct
-- table grants. The trusted Worker uses the service role and owns writes.
alter table public.user_profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.scan_usage enable row level security;
alter table public.scan_recommendations enable row level security;
alter table public.user_trades enable row level security;

revoke all on table public.user_profiles, public.user_settings, public.scan_usage, public.scan_recommendations, public.user_trades from anon, authenticated;

create policy "profiles are private" on public.user_profiles for select to authenticated using (auth.uid() = id);
create policy "settings are private" on public.user_settings for select to authenticated using (auth.uid() = user_id);
create policy "trades are private" on public.user_trades for select to authenticated using (auth.uid() = user_id);

-- Server-only entitlement functions. No browser role receives EXECUTE.
create or replace function public.market_edge_bootstrap_profile(
  p_user_id uuid, p_email text, p_is_admin boolean default false
) returns public.user_profiles
language plpgsql security definer set search_path = public
as $$
declare result public.user_profiles;
begin
  insert into public.user_profiles (id,email,role,plan)
  values (p_user_id, lower(p_email), case when p_is_admin then 'ADMIN' else 'USER' end, 'FREE')
  on conflict (id) do update set
    email = excluded.email,
    role = case when public.user_profiles.role = 'ADMIN' or p_is_admin then 'ADMIN' else 'USER' end,
    updated_at = now()
  returning * into result;
  return result;
end;
$$;

create or replace function public.market_edge_reserve_scan(
  p_principal_type text, p_principal_id uuid, p_request_id text, p_usage_day date
) returns table (allowed boolean, reservation_id uuid, daily_limit integer, used_today integer, remaining_today integer, unlimited boolean, role text, plan text)
language plpgsql security definer set search_path = public
as $$
declare profile public.user_profiles; existing public.scan_usage; cap integer; consumed integer; is_unlimited boolean := false;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_principal_id::text || ':' || p_usage_day::text, 0));
  -- Abandoned requests must not permanently consume a daily allowance.
  update public.scan_usage set status='RELEASED', released_at=now()
  where principal_id = p_principal_id and usage_day_sydney = p_usage_day
    and status = 'RESERVED' and reserved_at <= now() - interval '15 minutes';
  if p_principal_type = 'USER' then select * into profile from public.user_profiles where id = p_principal_id; end if;
  is_unlimited := coalesce(profile.role = 'ADMIN', false);
  cap := case when is_unlimited then null when p_principal_type = 'GUEST' then 3 else 5 end;
  select * into existing from public.scan_usage where principal_id = p_principal_id and usage_day_sydney = p_usage_day and request_id = p_request_id;
  select count(*)::integer into consumed from public.scan_usage where principal_id = p_principal_id and usage_day_sydney = p_usage_day and status in ('RESERVED','FINALIZED') and reserved_at > now() - interval '15 minutes';
  if existing.id is not null then
    return query select existing.status <> 'RELEASED', existing.id, cap, greatest(0, consumed - case when existing.status = 'RELEASED' then 0 else 1 end), case when cap is null then null else greatest(0, cap - consumed) end, is_unlimited, coalesce(profile.role,'USER'), coalesce(profile.plan,'FREE');
    return;
  end if;
  if not is_unlimited and consumed >= cap then
    return query select false, null::uuid, cap, consumed, 0, false, coalesce(profile.role,'USER'), coalesce(profile.plan,'FREE');
    return;
  end if;
  insert into public.scan_usage(principal_type,principal_id,user_id,guest_id,request_id,usage_day_sydney,status)
  values (p_principal_type,p_principal_id,case when p_principal_type='USER' then p_principal_id else null end,case when p_principal_type='GUEST' then p_principal_id else null end,p_request_id,p_usage_day,'RESERVED')
  returning * into existing;
  return query select true, existing.id, cap, consumed, case when cap is null then null else greatest(0, cap - consumed - 1) end, is_unlimited, coalesce(profile.role,'USER'), coalesce(profile.plan,'FREE');
end;
$$;

create or replace function public.market_edge_finalize_scan(p_reservation_id uuid, p_scan_id text)
returns void language plpgsql security definer set search_path = public
as $$ begin
  update public.scan_usage set status='FINALIZED', scan_id=p_scan_id, finalized_at=now()
  where id=p_reservation_id and status='RESERVED';
  if not found and not exists (
    select 1 from public.scan_usage where id=p_reservation_id and status='FINALIZED'
  ) then raise exception 'Scan reservation is not available'; end if;
end; $$;

create or replace function public.market_edge_release_scan(p_reservation_id uuid)
returns void language plpgsql security definer set search_path = public
as $$ begin
  update public.scan_usage set status='RELEASED', released_at=now()
  where id=p_reservation_id and status='RESERVED';
end; $$;

revoke all on function public.market_edge_bootstrap_profile(uuid,text,boolean), public.market_edge_reserve_scan(text,uuid,text,date), public.market_edge_finalize_scan(uuid,text), public.market_edge_release_scan(uuid) from public, anon, authenticated;
grant execute on function public.market_edge_bootstrap_profile(uuid,text,boolean), public.market_edge_reserve_scan(text,uuid,text,date), public.market_edge_finalize_scan(uuid,text), public.market_edge_release_scan(uuid) to service_role;
