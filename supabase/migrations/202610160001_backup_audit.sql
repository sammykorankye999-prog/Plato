-- Backup-run inventory. AWS automation writes through its restricted
-- server-side identity; browser/mobile roles receive no access.
create table if not exists public.backup_runs (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('supabase', 'aws_s3', 'manual')),
  backup_kind text not null check (backup_kind in ('database', 'storage', 'configuration')),
  status text not null check (status in ('started', 'succeeded', 'failed', 'restore_tested')),
  artifact_key text,
  checksum_sha256 text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  details jsonb not null default '{}'::jsonb,
  check (completed_at is null or completed_at >= started_at)
);

create index if not exists backup_runs_started_idx
  on public.backup_runs(started_at desc);

alter table public.backup_runs enable row level security;
revoke all on public.backup_runs from anon, authenticated;
grant select on public.backup_runs to authenticated;
drop policy if exists "require aal2 for backup history" on public.backup_runs;
create policy "require aal2 for backup history"
  on public.backup_runs as restrictive for select to authenticated
  using ((select public.has_aal2()));
drop policy if exists "admins read backup history" on public.backup_runs;
create policy "admins read backup history"
  on public.backup_runs for select to authenticated
  using ((select public.current_app_role()) in ('admin', 'administrator'));
-- Clients can only read the history under the role/MFA policies above.
-- A trusted automation using the Supabase service credential writes run
-- metadata; keep that credential in AWS Secrets Manager, never in clients.
