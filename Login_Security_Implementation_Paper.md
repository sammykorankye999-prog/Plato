# Secure Workspace: Authentication, Authorization, and Recovery
## Implementation paper | 16 October 2026

### Purpose and platform

This system identifies each person with a unique Supabase Auth account, authenticates the account with a password or Google sign-in followed by TOTP two-factor authentication, and authorizes actions by role. The web client is Next.js and Vercel, usable in desktop browsers and installable as a network-only PWA. The mobile client is Expo/React Native. Supabase Auth manages identity and sessions; Supabase Postgres is the authoritative records database. A local development server supports workstation development. Production web traffic uses HTTPS.

Browser and mobile apps use only the Supabase project URL and publishable key. Postgres Row Level Security (RLS) checks the signed-in identity, application role, active status, and MFA assurance level for protected operations. A Supabase Edge Function performs privileged invitations, deactivation, and role assignment after validating the caller. Keep its service-role credential server-side. Never ship database passwords, service-role keys, AWS credentials, or peppers in client bundles or Git.

### Identification, authentication, and password handling

Self-registration supports email/password and Google OAuth. A database trigger assigns new identities the least-privileged `inputer` role; users cannot choose or elevate their roles. Require email confirmation in production. Use the stable Supabase Auth UUID as the owner key for records.

After first-factor authentication, require a verified TOTP factor. New users scan a Supabase-generated QR code with an authenticator application and enter a six-digit code to enroll. Returning users complete a fresh TOTP challenge. The database and privileged functions require AAL2, so a sign-in UI defect cannot bypass MFA. Google is a first-factor option, not the second factor. Password recovery and factor reset must verify account ownership and revoke old sessions.

Supabase Auth stores password hashes with bcrypt and a per-password random salt. This application does not store plaintext passwords or hash real account passwords in the browser. Its supported Supabase sign-in flow does not accept a separate application pepper. The isolated `examples/salt-pepper-demo.mjs` reads `PASSWORD_PEPPER` from the local server environment and demonstrates a random per-record salt, HMAC-SHA-256 keyed by that pepper, and scrypt for slow key derivation. It is educational code only and is not connected to account registration or login. In a production service that requires a pepper, keep it in a server-side secret manager and use an identity platform that officially supports the design; do not create a parallel password database.

### Roles and dashboard access

The protected `user_roles` table currently defines four roles. RLS defaults to denying access and the role cannot be changed by a user through the browser or phone.

| Role | Permissions |
|---|---|
| Inputer | Create and read own records; edit own drafts. |
| Manager | Inputer permissions; invite inputers by verified email. No deactivation or elevated role assignment. |
| Admin | Review team records, user directory, audit and backup history; invite and deactivate inputers; change and restore versioned workspace settings. Cannot deactivate managers or administrators. |
| Administrator | Admin permissions; assign roles and retain highest-level oversight. Require AAL2 for every privileged action. |

Web and mobile show separate dashboard views for the four roles. Admins can page through team records. User directory, configuration history, backup history, and security events are visible according to database policies. Additional roles must be named and assigned explicit permissions before adding them to the database enum or functions. Role checks in the interface support usability; RLS and trusted functions provide enforcement. Deactivation is preferred to permanent deletion so records and audit references remain intact. Record actor, target, action, time, and outcome without passwords, TOTP codes, or session tokens.

For classroom data, `supabase/seed-demo.sql` maps four already-confirmed test Auth accounts to the four roles and adds five sample input rows. It creates no passwords and must only be run in a disposable development project.

**Page 1 of 2**

\newpage

**Page 2 of 2**

### Database, local operation, and secure connections

Supabase Postgres stores online application data. Web and mobile requests use HTTPS APIs; RLS checks the user JWT and AAL2 status. A local Next.js server is for development. The Expo app uses SQLCipher for a queue of unsent records, with its key in platform secure storage. Offline capture is not offline authentication: the server rechecks role and MFA when a queued item syncs. Offline administration and cached browsing of sensitive server records are unavailable. Do not treat a queued item as accepted until Supabase confirms it.

The versioned `workspace_configuration` feature contains only app settings: maintenance mode, offline queue availability, and maximum record length. Admin and administrator roles use AAL2-checked database functions to save or restore a setting version and record an audit event. The restore touches configuration tables only; it does not update `public.inputs`. Vercel environment variables and Supabase OAuth/email-provider settings are external configuration and must be backed up separately.

### Automated backups and recovery

The repository contains a daily GitHub Actions workflow, a CloudFormation template, and a `backup_runs` table. When configured by the account owner, the workflow exports logical database roles/schema/data and uploads SQL files plus checksums to a private, versioned Amazon S3 bucket encrypted with a customer-managed KMS key. GitHub obtains short-lived AWS credentials through OIDC and reads the Supabase database URI from AWS Secrets Manager. Backup metadata records run status and artifact location.

The automation is prepared but inactive until the owner creates an AWS account, enables root MFA, creates the GitHub OIDC provider and database secret, deploys the CloudFormation stack, applies the new SQL migrations, configures GitHub variables, and runs the workflow. Account signup, email/phone verification, and billing must be completed by the owner; see AWS's [account setup](https://docs.aws.amazon.com/IAM/latest/UserGuide/getting-started-account-iam.html) and [root-user security guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html). Follow `aws-backup/README.md`. The S3 archive is a logical export, not a complete Supabase point-in-time image. Supabase-managed Auth/Storage schemas and Storage object files need separate backup procedures. Confirm the recovery plan and test with a disposable staging project before relying on the archive. A full database disaster restore can roll back or replace business records; never use it as a configuration-only rollback.

### Release and review plan

1. Apply migrations in order: `202610110001_login_roles.sql`, `202610120001_self_signup.sql`, `202610160001_backup_audit.sql`, `202610160002_workspace_configuration.sql`, `202610170001_admin_workspace_settings.sql`.
2. Configure Supabase email confirmation, Google OAuth, TOTP MFA, redirect allow-lists, and the production email provider. Create and enroll the initial account, then promote it to administrator through the controlled bootstrap SQL.
3. Deploy the `manage-users` Edge Function with protected secrets and the production origin allow-list. Configure Vercel with only the Supabase URL and publishable key, set the project root to `web`, and deploy the web/PWA client.
4. Build the Expo native client with SQLCipher enabled. Verify Google redirect, TOTP enrollment/challenge, encrypted offline queue, and role-specific screens on Android and iOS development builds.
5. Create the AWS backup resources and GitHub variables. Run the first backup, inspect `backup_runs`, verify checksum files, and rehearse recovery in staging. Export Storage objects separately. Document backup retention and recovery owner.
6. Confirm additional role names and permission rules with the lecturer. Review allowed and denied role actions, AAL1 rejection, onboarding, deactivation, password/factor recovery, offline sync, secrets separation, and config-only restore. Verify config restore does not alter `inputs`; conduct a separate full database recovery exercise in staging.

### References

[Supabase password security](https://supabase.com/docs/guides/auth/password-security) - bcrypt and per-password salts.
[Supabase MFA](https://supabase.com/docs/guides/auth/auth-mfa) - TOTP and AAL2.
[Supabase database backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) - logical dump and restore.
[AWS root account security](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html) - MFA and restricted root use.
[Amazon S3 access control](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-management.html) - Block Public Access, versioning, and encryption.
[AWS Secrets Manager with Lambda](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html) - secret access through IAM.

**Implementation status:** Web/mobile clients, database policies, and backup templates are in the repository. AWS account creation, migrations 3-5, AWS resource deployment, the first backup run, and the restore rehearsal still require owner setup.
