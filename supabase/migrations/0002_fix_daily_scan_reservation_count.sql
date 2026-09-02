-- A completed successful scan must count for its whole Sydney usage day.
-- The 15-minute window applies only to abandoned in-flight reservations.
create or replace function public.market_edge_reserve_scan(
  p_principal_type text, p_principal_id uuid, p_request_id text, p_usage_day date
) returns table (allowed boolean, reservation_id uuid, daily_limit integer, used_today integer, remaining_today integer, unlimited boolean, role text, plan text)
language plpgsql security definer set search_path = public
as $$
declare profile public.user_profiles; existing public.scan_usage; cap integer; consumed integer; is_unlimited boolean := false;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_principal_id::text || ':' || p_usage_day::text, 0));
  update public.scan_usage set status='RELEASED', released_at=now()
  where principal_id = p_principal_id and usage_day_sydney = p_usage_day
    and status = 'RESERVED' and reserved_at <= now() - interval '15 minutes';
  if p_principal_type = 'USER' then select * into profile from public.user_profiles where id = p_principal_id; end if;
  is_unlimited := coalesce(profile.role = 'ADMIN', false);
  cap := case when is_unlimited then null when p_principal_type = 'GUEST' then 3 else 5 end;
  select * into existing from public.scan_usage where principal_id = p_principal_id and usage_day_sydney = p_usage_day and request_id = p_request_id;
  select count(*)::integer into consumed from public.scan_usage
  where principal_id = p_principal_id and usage_day_sydney = p_usage_day
    and (status = 'FINALIZED' or (status = 'RESERVED' and reserved_at > now() - interval '15 minutes'));
  if existing.id is not null then
    return query select existing.status <> 'RELEASED', existing.id, cap,
      greatest(0, consumed - case when existing.status = 'RELEASED' then 0 else 1 end),
      case when cap is null then null else greatest(0, cap - consumed) end,
      is_unlimited, coalesce(profile.role,'USER'), coalesce(profile.plan,'FREE');
    return;
  end if;
  if not is_unlimited and consumed >= cap then
    return query select false, null::uuid, cap, consumed, 0, false, coalesce(profile.role,'USER'), coalesce(profile.plan,'FREE');
    return;
  end if;
  insert into public.scan_usage(principal_type,principal_id,user_id,guest_id,request_id,usage_day_sydney,status)
  values (p_principal_type,p_principal_id,case when p_principal_type='USER' then p_principal_id else null end,case when p_principal_type='GUEST' then p_principal_id else null end,p_request_id,p_usage_day,'RESERVED')
  returning * into existing;
  return query select true, existing.id, cap, consumed,
    case when cap is null then null else greatest(0, cap - consumed - 1) end,
    is_unlimited, coalesce(profile.role,'USER'), coalesce(profile.plan,'FREE');
end;
$$;
