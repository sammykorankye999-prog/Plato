-- Plato LMS seed data: four users with distinct roles and sample records.
-- For a disposable Supabase development project only. Create and email-confirm
-- four test Auth accounts, edit the four example email values below to match,
-- then run this in Supabase SQL Editor. It assigns roles and creates sample
-- LMS records. It skips if run again. It does not create or store passwords.

do $$
declare
  v_inputer uuid;
  v_manager uuid;
  v_admin uuid;
  v_administrator uuid;
begin
  -- Resolve Auth users by email (edit these four addresses to your test accounts).
  select id into v_inputer from auth.users where email = lower('inputer@example.com') limit 1;
  select id into v_manager from auth.users where email = lower('manager@example.com') limit 1;
  select id into v_admin from auth.users where email = lower('admin@example.com') limit 1;
  select id into v_administrator from auth.users where email = lower('administrator@example.com') limit 1;

  if v_inputer is null or v_manager is null or v_admin is null or v_administrator is null then
    raise exception 'All four Auth accounts must exist and be email-confirmed before seeding. Update the emails in this migration.';
  end if;

  insert into public.user_roles(user_id, email, role, active)
  values
    (v_inputer, 'inputer@example.com', 'inputer', true),
    (v_manager, 'manager@example.com', 'manager', true),
    (v_admin, 'admin@example.com', 'admin', true),
    (v_administrator, 'administrator@example.com', 'administrator', true)
  on conflict (user_id) do update set role = excluded.role, active = excluded.active, email = excluded.email;

  insert into public.inputs(owner_id, content, status)
  values
    (v_inputer, 'Introduction to Plato LMS — course outline and learning objectives.', 'submitted'),
    (v_inputer, 'Module 1: Database fundamentals — tables, relationships, and queries.', 'draft'),
    (v_manager, 'Team review notes for Module 1 — approved for publication.', 'submitted'),
    (v_admin, 'Compliance audit of inputer records — all entries within policy.', 'submitted'),
    (v_administrator, 'System configuration checkpoint — roles, MFA, and backup verified.', 'submitted')
  on conflict do nothing;

  insert into public.audit_events(actor_id, event, target_user_id, details)
  values
    (v_administrator, 'plato_seed_loaded', null, jsonb_build_object('users', 4, 'records', 5))
  on conflict do nothing;
end $$;
