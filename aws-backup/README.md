# Plato AWS off-site backup setup

The stack and workflow are prepared but not deployed. The AWS account owner must complete these steps in their own account.

## Before running the workflow

1. Enable MFA for the AWS root user. Create and use an IAM administrative identity for account setup.
2. Create the GitHub Actions OIDC identity provider in IAM if it does not already exist. Its URL is `https://token.actions.githubusercontent.com`, and its audience is `sts.amazonaws.com`.
3. In AWS Secrets Manager, create a JSON secret with one key, `database_url`. Set its value to the Supabase Postgres connection URI from **Supabase Dashboard → Connect → Session pooler**. Use the project database password and URL-encode reserved characters. Never commit or paste the URI.
4. In CloudFormation, create a stack from `github-oidc-stack.yaml`. Supply the IAM OIDC provider ARN, the GitHub repository `sammykorankye999-prog/Secure-Workspace`, and the database secret ARN. The stack creates a private S3 bucket with Block Public Access, versioning, KMS encryption, and a 90-day lifecycle, plus a role scoped to the repository's `main` branch.
5. In GitHub **Settings → Secrets and variables → Actions → Variables**, set the values from the stack outputs: `AWS_BACKUP_ROLE_ARN`, `AWS_REGION`, `AWS_BACKUP_BUCKET`, `AWS_BACKUP_KMS_KEY_ARN`, and `AWS_SUPABASE_DATABASE_SECRET_ARN`.
6. Apply migrations `202610160001_backup_audit.sql`, `202610160002_workspace_configuration.sql`, and `202610170001_admin_workspace_settings.sql` in Supabase after the original role migrations. Then run **Actions → Supabase off-site backup → Run workflow** once.

The workflow uses GitHub's short-lived OIDC credentials to retrieve the database URI from Secrets Manager. It writes `roles.sql`, `schema.sql`, `data.sql`, `SHA256SUMS`, and `manifest.json` under a unique S3 key, then records the run in `public.backup_runs`. Failed runs are recorded when the database connection is available.

## What the archive does and does not contain

This is a logical export of database roles and schemas/data available through Supabase CLI's backup command. It does not back up Supabase-managed Auth/Storage schemas or Storage object files. It is not a complete Supabase point-in-time recovery image. Supabase-managed backups/PITR and Storage exports remain separate protection layers. Treat the S3 archive as sensitive personal and business data.

The archive includes application foreign keys to `auth.users`. A restore target therefore needs compatible Auth identities and the correct application migrations. Confirm the Auth recovery approach and test with a disposable staging project before relying on this archive. Never restore the SQL files over production as a way to roll back settings.

## Recovery types

- **Configuration-only restore:** use the administrator dashboard's version history. It restores only the versioned application settings and writes an audit event; it does not change `public.inputs`.
- **Database recovery:** restore database contents only under a separately approved disaster-recovery procedure. A database restore can roll records back. Supabase's official CLI process restores into a project and applies `roles.sql`, `schema.sql`, and `data.sql` with `psql`; follow the current [Supabase backup and restore guide](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) and use a staging project first.
- **External deployment configuration:** Vercel environment variables and Supabase Google/OAuth/email settings are outside the application configuration snapshots. Preserve and restore those separately through their providers.

## Operations

- Check GitHub Actions run status and `public.backup_runs` regularly.
- Confirm the S3 bucket lifecycle matches the organization's retention requirements before sending real data.
- Rehearse restore and recovery of Supabase Auth and Storage separately.
- Keep an independently controlled AWS recovery identity with permission to read the bucket and decrypt with the KMS key. The scheduled workflow role is intentionally write-oriented and cannot read backups.
- Do not share the database URI, KMS recovery access, GitHub tokens, or AWS credentials in chat or commit them to Git.
