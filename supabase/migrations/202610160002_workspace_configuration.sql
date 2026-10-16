-- Versioned application settings are stored separately from business inputs.
-- Restoring one of these versions never updates public.inputs or auth.users.
create table if not exists public.workspace_configuration (
  singleton boolean primary key default true check (singleton),
  maintenance_mode boolean not null default false,
  offline_entry_enabled boolean not null default true,
  max_record_length integer not null default 4000 check (max_record_length between 100 and 4000),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.workspace_configuration(singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.workspace_configuration_versions (
  id bigint generated always as identity primary key,
  maintenance_mode boolean not null,
  offline_entry_enabled boolean not null,
  max_record_length integer not null check (max_record_length between 100 and 4000),
  changed_by uuid references auth.users(id) on delete set null,
  reason text not null check (char_length(reason) between 3 and 500),
  created_at timestamptz not null default now()
);

insert into public.workspace_configuration_versions(
  maintenance_mode, offline_entry_enabled, max_record_length, changed_by, reason
)
select false, true, 4000, null, 'Initial default configuration'
where not exists (select 1 from public.workspace_configuration_versions);

alter table public.workspace_configuration enable row level security;
alter table public.workspace_configuration_versions enable row level security;
revoke all on public.workspace_configuration, public.workspace_configuration_versions from anon, authenticated;
grant select on public.workspace_configuration to authenticated;
grant select on public.workspace_configuration_versions to authenticated;

drop policy if exists "require aal2 for workspace configuration" on public.workspace_configuration;
create policy "require aal2 for workspace configuration"
  on public.workspace_configuration as restrictive for select to authenticated
  using ((select public.has_aal2()));
drop policy if exists "active users read workspace configuration" on public.workspace_configuration;
create policy "active users read workspace configuration"
  on public.workspace_configuration for select to authenticated
  using ((select public.current_app_role()) is not null);

drop policy if exists "require aal2 for configuration history" on public.workspace_configuration_versions;
create policy "require aal2 for configuration history"
  on public.workspace_configuration_versions as restrictive for select to authenticated
  using ((select public.has_aal2()));
drop policy if exists "admin roles read configuration history" on public.workspace_configuration_versions;
create policy "admin roles read configuration history"
  on public.workspace_configuration_versions for select to authenticated
  using ((select public.current_app_role()) in ('admin', 'administrator'));

create or replace function public.change_workspace_configuration(
  p_maintenance_mode boolean,
  p_offline_entry_enabled boolean,
  p_max_record_length integer,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_version bigint;
begin
  if v_actor is null or not public.has_aal2() or public.current_app_role() is distinct from 'administrator' then
    raise exception 'Administrator with verified MFA required' using errcode = '42501';
  end if;
  if p_max_record_length is null or p_max_record_length not between 100 and 4000 or p_reason is null or char_length(trim(p_reason)) not between 3 and 500 then
    raise exception 'Configuration values or change reason are invalid' using errcode = '22023';
  end if;

  perform 1 from public.workspace_configuration where singleton = true for update;

  insert into public.workspace_configuration_versions(
    maintenance_mode, offline_entry_enabled, max_record_length, changed_by, reason
  ) values (
    p_maintenance_mode, p_offline_entry_enabled, p_max_record_length, v_actor, trim(p_reason)
  ) returning id into v_version;

  update public.workspace_configuration
  set maintenance_mode = p_maintenance_mode,
      offline_entry_enabled = p_offline_entry_enabled,
      max_record_length = p_max_record_length,
      updated_by = v_actor,
      updated_at = now()
  where singleton = true;

  insert into public.audit_events(actor_id, event, details)
  values (v_actor, 'workspace_configuration_changed', jsonb_build_object('version_id', v_version, 'reason', trim(p_reason)));
  return v_version;
end;
$$;

create or replace function public.restore_workspace_configuration(
  p_version_id bigint,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_source public.workspace_configuration_versions%rowtype;
  v_version bigint;
begin
  if v_actor is null or not public.has_aal2() or public.current_app_role() is distinct from 'administrator' then
    raise exception 'Administrator with verified MFA required' using errcode = '42501';
  end if;
  if p_reason is null or char_length(trim(p_reason)) not between 3 and 500 then
    raise exception 'A restore reason between 3 and 500 characters is required' using errcode = '22023';
  end if;

  perform 1 from public.workspace_configuration where singleton = true for update;

  select * into v_source
  from public.workspace_configuration_versions
  where id = p_version_id;
  if not found then
    raise exception 'Configuration version not found' using errcode = 'P0002';
  end if;

  insert into public.workspace_configuration_versions(
    maintenance_mode, offline_entry_enabled, max_record_length, changed_by, reason
  ) values (
    v_source.maintenance_mode,
    v_source.offline_entry_enabled,
    v_source.max_record_length,
    v_actor,
    'Restored version ' || p_version_id::text || ': ' || trim(p_reason)
  ) returning id into v_version;

  update public.workspace_configuration
  set maintenance_mode = v_source.maintenance_mode,
      offline_entry_enabled = v_source.offline_entry_enabled,
      max_record_length = v_source.max_record_length,
      updated_by = v_actor,
      updated_at = now()
  where singleton = true;

  insert into public.audit_events(actor_id, event, details)
  values (v_actor, 'workspace_configuration_restored', jsonb_build_object('source_version_id', p_version_id, 'new_version_id', v_version, 'reason', trim(p_reason)));
  return v_version;
end;
$$;

revoke all on function public.change_workspace_configuration(boolean, boolean, integer, text) from public, anon, authenticated;
revoke all on function public.restore_workspace_configuration(bigint, text) from public, anon, authenticated;
grant execute on function public.change_workspace_configuration(boolean, boolean, integer, text) to authenticated;
grant execute on function public.restore_workspace_configuration(bigint, text) to authenticated;

-- This restrictive insert policy applies in addition to the existing create
-- policy, so maintenance and record-size settings cannot be bypassed by a UI.
drop policy if exists "enforce workspace entry configuration" on public.inputs;
create policy "enforce workspace entry configuration"
  on public.inputs as restrictive for insert to authenticated
  with check (
    char_length(content) <= (
      select c.max_record_length from public.workspace_configuration as c where c.singleton = true
    )
    and (
      not coalesce((select c.maintenance_mode from public.workspace_configuration as c where c.singleton = true), false)
      or (select public.current_app_role()) in ('admin', 'administrator')
    )
  );
