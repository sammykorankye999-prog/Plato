-- DEMO PROJECT ONLY. Never run this in production.
-- First create/confirm these four users through Supabase Auth in a disposable
-- development project. This script sets roles and adds sample records; it does
-- not create passwords or Auth accounts.
do $$
declare
  inputer_id uuid;
  manager_id uuid;
  admin_id uuid;
  administrator_id uuid;
begin
  -- Replace these four example values with confirmed test account emails.
  select id into inputer_id from auth.users where lower(email) = 'inputer-demo@your-domain.example';
  select id into manager_id from auth.users where lower(email) = 'manager-demo@your-domain.example';
  select id into admin_id from auth.users where lower(email) = 'admin-demo@your-domain.example';
  select id into administrator_id from auth.users where lower(email) = 'administrator-demo@your-domain.example';

  if inputer_id is null or manager_id is null or admin_id is null or administrator_id is null then
    raise exception 'Replace the four sample emails in this file, then create and confirm those Auth users before running it';
  end if;

  insert into public.user_roles(user_id, email, role, active)
  select demo.user_id, lower(auth_user.email), demo.role, true
  from (values
    (inputer_id, 'inputer'::public.app_role),
    (manager_id, 'manager'::public.app_role),
    (admin_id, 'admin'::public.app_role),
    (administrator_id, 'administrator'::public.app_role)
  ) as demo(user_id, role)
  join auth.users as auth_user on auth_user.id = demo.user_id
  on conflict (user_id) do update
    set email = excluded.email, role = excluded.role, active = true;

  insert into public.inputs(owner_id, content, status)
  select demo.owner_id, demo.content, demo.status
  from (values
    (inputer_id, 'Demo record 1: quarterly inventory count completed.', 'submitted'::public.input_status),
    (inputer_id, 'Demo record 2: three items need a follow-up check.', 'draft'::public.input_status),
    (manager_id, 'Demo record 3: team review scheduled for Friday.', 'submitted'::public.input_status),
    (admin_id, 'Demo record 4: access review completed.', 'submitted'::public.input_status),
    (administrator_id, 'Demo record 5: workspace configuration reviewed.', 'draft'::public.input_status)
  ) as demo(owner_id, content, status)
  where not exists (
    select 1 from public.inputs existing
    where existing.owner_id = demo.owner_id and existing.content = demo.content
  );
end;
$$;
