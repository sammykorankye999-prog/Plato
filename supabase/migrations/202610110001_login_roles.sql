-- Supabase Postgres schema for the web and Expo clients.
-- Apply with Supabase CLI (`supabase db push`) or the Dashboard SQL Editor.

create type public.app_role as enum ('inputer', 'manager', 'admin', 'administrator');
create type public.input_status as enum ('draft', 'submitted');

create table public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role public.app_role not null default 'inputer',
  active boolean not null default true,
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Assign new Auth identities the least-privileged application role by default.
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email is null then raise exception 'An email address is required for an application account'; end if;
  insert into public.user_roles(user_id,email,role) values(new.id,lower(new.email),'inputer');
  return new;
end;
$$;
revoke all on function public.handle_new_auth_user() from public, anon, authenticated;
create trigger on_auth_user_created_assign_default_role after insert on auth.users
for each row execute function public.handle_new_auth_user();

-- Every self-registered or OAuth identity starts with the least-privileged role.
-- Clients cannot write this table; elevation stays in the checked admin function.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_roles(user_id, email, role)
  values (new.id, lower(new.email), 'inputer');
  return new;
end;
$$;

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

create trigger on_auth_user_created_assign_default_role
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create table public.inputs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  content text not null check (char_length(content) between 1 and 4000),
  status public.input_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  event text not null,
  target_user_id uuid references auth.users(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index inputs_owner_created_idx on public.inputs(owner_id, created_at desc);
create index audit_events_created_idx on public.audit_events(created_at desc);

-- These SECURITY DEFINER helpers read role metadata without exposing role writes
-- to clients. Keep their search path empty and fully qualify all objects.
create or replace function public.current_app_role()
returns public.app_role
language sql stable security definer
set search_path = ''
as $$
  select ur.role
  from public.user_roles as ur
  where ur.user_id = (select auth.uid()) and ur.active = true
$$;

create or replace function public.has_aal2()
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal') = 'aal2', false)
$$;

revoke all on function public.current_app_role() from public, anon;
revoke all on function public.has_aal2() from public, anon;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.has_aal2() to authenticated;

alter table public.user_roles enable row level security;
alter table public.inputs enable row level security;
alter table public.audit_events enable row level security;

revoke all on public.user_roles, public.inputs, public.audit_events from anon;
grant select on public.user_roles to authenticated;
grant select, insert, update on public.inputs to authenticated;
grant select on public.audit_events to authenticated;

-- Every authenticated client must complete TOTP MFA before it can read role
-- assignments or business data. Restrictive policies apply even if a later
-- permissive policy is added by mistake.
create policy "require aal2 for role directory"
  on public.user_roles as restrictive for select to authenticated
  using ((select public.has_aal2()));

create policy "read own role or user directory"
  on public.user_roles for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.current_app_role()) in ('manager', 'admin', 'administrator')
  );

-- No client INSERT/UPDATE/DELETE policy exists for roles. Only the checked
-- manage-users Edge Function, using its server-only secret key, may change them.

create policy "require aal2 for inputs"
  on public.inputs as restrictive for all to authenticated
  using ((select public.has_aal2()) and (select public.current_app_role()) is not null)
  with check ((select public.has_aal2()) and (select public.current_app_role()) is not null);

create policy "read own or team inputs"
  on public.inputs for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (select public.current_app_role()) in ('manager', 'admin', 'administrator')
  );

create policy "create own inputs"
  on public.inputs for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (select public.current_app_role()) in ('inputer', 'manager', 'admin', 'administrator')
  );

create policy "edit own drafts"
  on public.inputs for update to authenticated
  using (owner_id = (select auth.uid()) and status = 'draft')
  with check (owner_id = (select auth.uid()) and status = 'draft');

-- Record deletion is deliberately unavailable in this first release.
create policy "require aal2 for audit events"
  on public.audit_events as restrictive for select to authenticated
  using ((select public.has_aal2()));

create policy "admins read audit events"
  on public.audit_events for select to authenticated
  using ((select public.current_app_role()) in ('admin', 'administrator'));

-- Bootstrap a first administrator only after creating/inviting their Auth user:
-- insert into public.user_roles(user_id, role)
-- values ('AUTH-USER-UUID-HERE', 'administrator');

