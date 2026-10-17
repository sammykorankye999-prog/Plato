-- The lecturer's admin role may manage workspace settings. The separate
-- administrator role retains role assignment and highest-level oversight.
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
  if v_actor is null or not public.has_aal2() or not coalesce(public.current_app_role() in ('admin', 'administrator'), false) then
    raise exception 'Admin role with verified MFA required' using errcode = '42501';
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
  if v_actor is null or not public.has_aal2() or not coalesce(public.current_app_role() in ('admin', 'administrator'), false) then
    raise exception 'Admin role with verified MFA required' using errcode = '42501';
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

-- The settings restore changes only workspace_configuration and its version
-- history. It deliberately never updates records or identities.
