# Secure Workspace

Secure Workspace is a role-based records app. The cloud project uses Next.js/Vercel, Supabase Auth/Postgres, and Expo/React Native. The root `server.mjs` and `start.mjs` are an older local SQLite prototype and do not connect to Supabase.

The implementation paper is in [Markdown](Login_Security_Implementation_Paper.md) and [print-formatted HTML](Login_Security_Implementation_Paper.html). Regenerate the HTML after editing with `node render-paper.mjs`. OAuth, email confirmation, and TOTP enrollment steps are in [GETTING_STARTED_OAUTH_MFA.md](GETTING_STARTED_OAUTH_MFA.md).

## What is implemented

- Web app in `web/`, deployed through Vercel with project root `web/`. It works in desktop browsers and has an installable PWA shell. Its service worker is network-only and does not cache authenticated screens or records.
- Mobile app in `mobile/`, built with Expo and React Native. It uses Google OAuth, TOTP MFA, and an encrypted SQLCipher queue for unsent records.
- Supabase Auth handles email/password and Google identity, sessions, password recovery, and TOTP. SQL RLS requires an AAL2 session before protected data access.
- New accounts receive the least-privileged `inputer` role. Users cannot grant themselves roles.
- Four roles exist: `inputer`, `manager`, `admin`, and `administrator`. Inputers manage their own records. Managers and admins can invite inputers. Admins can review team records, the user directory, audit and backup history, deactivate inputers, and change or restore versioned settings. Administrators can also assign roles and manage the workspace.
- Web and mobile have role-specific dashboard views. Team records can be paged. Database policies and the `manage-users` Edge Function enforce privileges; hiding a UI control is not the security boundary.
- `audit_events` records invitations, deactivations, role changes, and configuration changes/restores. The new `backup_runs` table records backup status and artifact metadata.
- Workspace configuration history covers maintenance mode, offline queue availability, and maximum record length. An admin can restore a version without changing `inputs`. This does not restore Vercel environment variables or Supabase provider configuration.

### Password salt and pepper

Real accounts stay in Supabase Auth, which stores password hashes using bcrypt and a per-password random salt. This project does not add a custom pepper to Supabase authentication; that login flow does not support an application pepper.

For an isolated class demonstration, `examples/salt-pepper-demo.mjs` uses a unique random salt per record, HMAC-SHA-256 keyed by a pepper, and scrypt as the slow password hashing step. The output record contains the salt and hash, never the pepper. Do not use the demo to create or authenticate real accounts or to create a second password database. In production, keep any pepper in a server-side secret manager, never in a client or database.

Run the demonstration in PowerShell with demo-only values:

```powershell
$pepperBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($pepperBytes)
$env:PASSWORD_PEPPER = [BitConverter]::ToString($pepperBytes).Replace('-', '')
$env:DEMO_PASSWORD = Read-Host 'Demo password (12 or more characters; do not use a real password)'
node examples/salt-pepper-demo.mjs
Remove-Item Env:PASSWORD_PEPPER, Env:DEMO_PASSWORD
```

## Apply Supabase migrations

In Supabase SQL Editor, apply the SQL files in this order:

1. `supabase/migrations/202610110001_login_roles.sql`
2. `supabase/migrations/202610120001_self_signup.sql`
3. `supabase/migrations/202610160001_backup_audit.sql`
4. `supabase/migrations/202610160002_workspace_configuration.sql`
5. `supabase/migrations/202610170001_admin_workspace_settings.sql`

Enable email signup, email confirmation, and TOTP MFA in Supabase Auth. Create your first user, confirm its email, and enroll an authenticator. In Authentication > Users, copy the user's UUID, then promote that account in SQL Editor:

```sql
update public.user_roles
set role = 'administrator'
where user_id = 'AUTH-USER-UUID-HERE';
```

Replace the placeholder with the exact UUID. Do not give browser/mobile clients write access to `user_roles`.

### Load a four-role demonstration dataset

Use a disposable Supabase development project only. Create and email-confirm four test Auth accounts. Edit the four example email values at the top of `supabase/seed-demo.sql` to match those accounts, then run it in SQL Editor. It assigns the four roles and creates five example `public.inputs` rows. It does not create or store passwords. It skips matching records if you run it again. Do not run the demo seed in production.

Configure the Google provider in Google Cloud and Supabase. Allow the deployed Vercel callback/redirect and `secureworkspace://auth/callback` in Supabase Auth URL configuration. Deploy the privileged Edge Function:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase secrets set WEB_ORIGIN=https://YOUR_APP.vercel.app APP_ORIGINS=https://YOUR_APP.vercel.app
npx supabase functions deploy manage-users
```

Keep the service-role secret in Supabase's protected function environment. Never put it in Vercel public variables, browser code, mobile packages, or Git.

## Run and deploy the web app

In PowerShell from the repository root:

```powershell
Copy-Item web/.env.example web/.env.local
npm.cmd --prefix web install
npm.cmd run web:dev
```

Put the Supabase project URL and publishable key in `web/.env.local`. Open `http://localhost:3000` and allow that URL in Supabase Auth redirects during development. The app uses its current origin for confirmation, Google sign-in, and password recovery redirects.

For Vercel, import the GitHub repository and set **Root Directory** to `web`. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` for Preview and Production. Add the deployed Vercel domain to Supabase Auth redirects and the Edge Function origin allow-list. These two `NEXT_PUBLIC_` values are publishable; never use the prefix for a secret.

## Run the Expo app

Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `mobile/.env`, then run from PowerShell:

```powershell
npm.cmd --prefix mobile install
npm.cmd --prefix mobile start
```

For a native development build, use `npx expo prebuild` and `npx expo run:android`; iOS builds require macOS. SQLCipher is enabled, so Expo Go is not suitable. Change the example app identifiers in `mobile/app.json` before release.

Cloud sign-in and authorization require a network connection. Offline mobile mode only queues new records locally; Supabase re-checks MFA and active roles when records sync. A disabled user cannot sync. Offline mode is not offline authentication.

## Automated off-site backups on AWS

The repo now contains a daily GitHub Actions workflow at `.github/workflows/supabase-offsite-backup.yml`, an AWS CloudFormation template at `aws-backup/github-oidc-stack.yaml`, and a setup guide at [aws-backup/README.md](aws-backup/README.md). The planned storage is a private, versioned S3 bucket encrypted with a customer-managed KMS key. GitHub uses OIDC short-lived credentials and reads the database URI from Secrets Manager; no long-lived AWS key is required in GitHub.

The AWS part is not active until you create the AWS account, enable MFA for its root identity, create the OIDC provider and database secret, deploy the stack, configure GitHub repository variables, and run the workflow. AWS requires the account owner to complete signup, email/phone verification, and billing details. Follow AWS's [account setup guide](https://docs.aws.amazon.com/IAM/latest/UserGuide/getting-started-account-iam.html), then turn on root MFA and create a separate administrative identity; do not create root access keys or use root for routine work. Apply migrations 3–5 above first. The workflow runs daily at 02:00 UTC, stores SQL logical dumps and a checksum manifest in S3, and writes a row to `public.backup_runs`. The template uses a 90-day object retention period; verify it meets your requirements.

This off-site logical archive is not a complete Supabase project snapshot. Auth/Storage managed schemas and Storage object files have separate backup procedures. Restore the archive only under a recovery plan and into a staging project first. Database recovery may roll back or replace user records.

Configuration-only restore is different: it restores only the versioned in-app settings described above and leaves `public.inputs` unchanged. Vercel environment variables and Supabase OAuth/email provider settings must be backed up and restored separately.

## Remaining lecturer decisions and production work

- Only the four named roles are implemented. Confirm any additional role names and permissions with your lecturer before adding access rules.
- A native Windows/macOS binary is not included; the installable desktop PWA and responsive web app are the desktop experience.
- Create the AWS account and finish the owner-only setup. No AWS stack or successful backup run exists until then.
- Test restore, role denials, MFA recovery, email delivery limits, and Expo builds in staging before production use.
- Configure production email delivery, backup Storage objects separately, set retention, and review OAuth allow-lists and RLS.

The root local SQLite prototype is separate from the cloud app. Do not treat its user accounts or database as synchronized with Supabase.
