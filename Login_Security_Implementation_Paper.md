# Secure User Login and Role-Based Access System
## Implementation Paper | 11 October 2026

### Purpose
This paper specifies a web and mobile login system for staff who enter organizational records. **Identification** gives each person a unique email-based account. **Authentication** proves the account holder's identity with a password or Google sign-in, followed by a time-based one-time password (TOTP). **Authorization** limits each authenticated person to actions assigned to their role. Every protected operation must be enforced by the database or a trusted server, not by hiding a button in the interface.

### Platform and architecture
Use **Next.js (React)** for the web front end and deploy it on **Vercel**. Build the mobile client with **Expo / React Native**. Use **Supabase Auth** for accounts, password sign-in, Google OAuth, sessions, and TOTP MFA; use **Supabase Postgres** as the online source of truth. Supabase Row Level Security (RLS) policies check both the user's role and MFA assurance level on every data request. A Supabase Edge Function performs privileged user invitations and deactivation. The Vercel site and mobile app use only the Supabase URL and publishable key; the Supabase secret/service-role key stays in the Edge Function's protected environment.

For local development, run the Next.js development server on the workstation. In the Expo app, use on-device SQLite with **SQLCipher** for a small encrypted queue of unsent entries. This supports offline data capture, not a new offline login: first sign-in and online authorization require a network connection. Pending records are re-authorized by Supabase when synchronized; do not allow offline account administration or display sensitive server records from a stale cache. SQLCipher requires a native Expo development build, not Expo Go. The user's local encryption key belongs in platform secure storage.

### Identification, authentication, and password handling
Allow self-registration with email/password or Google, but assign every new identity only the least-privileged `inputer` role through a database trigger. Users cannot select or elevate their role; administrators can grant additional roles through a checked server function. Require verified email before normal production use. Use the stable Supabase user ID as the database owner. On password sign-in, Supabase Auth manages password hashing with bcrypt and a unique random salt. The application never stores a plaintext or recoverable password and must not hash it in the browser. A separate pepper cannot be added to Supabase-managed password hashes through the supported client flow; do not invent a second password system. If organizational policy strictly requires a pepper, choose a self-managed identity service designed for it instead of wrapping or bypassing Supabase Auth.

Require a verified TOTP factor before granting access to any role. After password or Google OAuth sign-in, users without a verified factor enroll by scanning a Supabase-generated QR code; returning users complete a TOTP challenge. Only an **AAL2** session may access application tables or privileged actions. Google is an alternative first sign-in method, not a replacement for the second factor. A secure recovery and factor-reset process must verify identity and revoke old sessions.

### Roles and least-privilege permissions
The role is stored in a protected `user_roles` table. Users cannot change their own role. RLS is enabled on every application table and defaults to denying access.

| Role | Allowed actions |
|---|---|
| Inputer | Create and read own entries; edit own drafts. No user administration. |
| Manager | Inputer actions; invite new inputers by verified email. Cannot deactivate users or grant elevated roles. |
| Admin | Review audit history and deactivate inputer accounts. Cannot deactivate managers or administrators. |
| Administrator | Full account and role administration, policy configuration, and audit review. Limit assignment and require MFA. |

The manager invitation and admin deactivation actions run through an Edge Function. It validates the caller's signed-in identity, AAL2 claim, and current database role before using its secret key. Deactivation is preferred to permanent deletion so records retain their owner and audit history. Log the actor, target, action, time, and outcome without passwords, TOTP codes, or tokens.

**Page 1 of 2**

\newpage

**Page 2 of 2**

### Database, local server, and secure connections
Supabase Postgres is the authoritative online database. Browser and mobile clients connect through Supabase's HTTPS APIs using a publishable key; Postgres RLS evaluates the caller's signed JWT and restricts rows. Do not put a database password or secret/service-role key in a browser bundle, mobile package, or public repository. Keep the Edge Function secret only in Supabase's protected function environment. Vercel environment settings hold only public client configuration unless a separately reviewed server-only integration is introduced. Enable MFA enforcement in the policies as well as in the sign-in screen so a UI defect cannot bypass the second factor.

The development server is local; production web traffic is served by Vercel over HTTPS. Supabase manages the API-to-database connection. If a trusted server later connects directly to Postgres, use TLS with certificate validation and a least-privileged database role. Keep production and preview project credentials separate, restrict OAuth redirect URLs to known domains and the Expo app scheme, and rotate any secret that is exposed.

### Automated backups and recovery
On eligible Supabase plans, daily database backups are available in **Database → Backups**; retention depends on the plan. Free-tier projects should export regularly with the Supabase CLI and keep encrypted copies off-site, never in a public repository. For a smaller recovery window, evaluate the paid Point-in-Time Recovery add-on and its compute and retention costs. Database backups do not include uploaded Storage objects, so back those up separately. Assign an owner to check backup status and periodically rehearse restoration in a separate project. This application repository does not itself configure the hosted project's backup schedule.

### Balancing access and security
Keep routine entry to a few steps: email or Google sign-in, one TOTP check, then a focused entry screen. Remember the signed-in session securely on the device, but require fresh authentication for account deactivation, role changes, and MFA reset. Use accessible code entry, short-lived challenges, rate limits, clear recovery instructions, and generic sign-in errors. Offline mode stores only pending entries in encrypted local SQLite; show which entries are waiting to sync and report authorization failures clearly. Never treat offline data as accepted until the server confirms it.

### Implementation and release sequence
1. Create a Supabase project; apply the SQL migrations; self-register the initial account, complete TOTP enrollment, then promote that account through a controlled bootstrap SQL update.
2. Configure Google OAuth in Google Cloud and Supabase. Register Vercel production/preview URLs and the Expo deep-link redirect in the Supabase allow-list.
3. Run the web app locally with the Supabase URL and publishable key. Configure the Supabase Edge Function secret and allowed web origin; deploy the function.
4. Deploy the `web` directory to Vercel. Build the Expo development client with SQLCipher enabled; test Google redirect, TOTP enrollment/challenge, and encrypted offline queue on real iOS and Android builds.
5. In Supabase **Database → Backups**, confirm the project's backup coverage and retention; configure an encrypted off-site export or PITR where the recovery target requires it. Back up Storage objects separately and rehearse a restore. Before production, verify denied as well as allowed role cases, AAL1 rejection, invited-account onboarding, deactivation, recovery, sync conflicts, and secret separation. Review Supabase RLS and deployment settings.

### References
[Supabase password security](https://supabase.com/docs/guides/auth/password-security) — bcrypt and per-password salt.
[Supabase MFA](https://supabase.com/docs/guides/auth/auth-mfa) — TOTP and AAL2 enforcement.
[Supabase role-based access control](https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac) — role claims and RLS.
[Supabase with Expo social auth](https://supabase.com/docs/guides/auth/quickstarts/with-expo-react-native-social-auth) — Google OAuth on mobile.
[Expo SQLite / SQLCipher](https://docs.expo.dev/versions/latest/sdk/sqlite/) — encrypted on-device data.
[Vercel environment variables](https://vercel.com/docs/environment-variables) — deployment configuration.
[Supabase database backups](https://supabase.com/docs/guides/platform/backups) — plan-dependent daily backups, PITR, and restore guidance.

**Implementation proposal — authorize the initial administrator, Google OAuth application, Supabase project, and Vercel deployment owner before production release.**
