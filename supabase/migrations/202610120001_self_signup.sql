-- Default new Auth identities to the least-privileged application role.
-- Safe to apply after the original login_roles migration or on a fresh project.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null then
    raise exception 'An email address is required for an application account';
  end if;

  insert into public.user_roles(user_id, email, role)
  values (new.id, lower(new.email), 'inputer')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_assign_default_role on auth.users;
create trigger on_auth_user_created_assign_default_role
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Existing Auth users without a role receive only the limited inputer role.
insert into public.user_roles(user_id, email, role)
select id, lower(email), 'inputer'
from auth.users
where email is not null
on conflict (user_id) do nothing;
