# Secure Login and Role-Based Access

This workspace contains a cloud-backed web/mobile implementation plus a separate single-computer Node prototype. The Supabase/Vercel/Expo implementation is under `web/`, `supabase/`, and `mobile/`. The root `server.mjs` is a local SQLite prototype and does not connect to Supabase.

The two-page implementation paper is available as [Markdown](Login_Security_Implementation_Paper.md) and [print-formatted HTML](Login_Security_Implementation_Paper.html). Regenerate the HTML after editing the paper with `node render-paper.mjs`. See [OAuth and MFA setup](GETTING_STARTED_OAUTH_MFA.md) for signup, Google provider, and QR-code instructions.

## Cloud implementation

- **Web:** Next.js, with Vercel project root set to `web/`.
- **Mobile:** Expo / React Native in `mobile/`, using Supabase OAuth for Google sign-in.
- **Identity and MFA:** Supabase Auth password or Google sign-in, then required TOTP MFA. Database access is restricted to AAL2 sessions.
- **Self-registration:** Email/password and Google registration are available. A database trigger assigns each new identity the basic `inputer` role; users cannot select or elevate their own role.
- **Database:** Supabase Postgres with RLS. `supabase/migrations/202610110001_login_roles.sql` defines roles, records, and access policies.
- **Privileged account actions:** `supabase/functions/manage-users/` invites inputers, deactivates inputers, and assigns roles only after server-side identity, MFA, and role checks.
- **Offline mobile entry:** Expo SQLite configured for SQLCipher stores only pending inputs. Supabase remains authoritative; it checks the user's active role and MFA when a queued record syncs.

Supabase Auth manages password hashes using bcrypt and per-password random salts. This application does not store passwords or implement a custom pepper. Supabase-managed passwords cannot safely accept an application pepper through its supported login flow. A strict pepper requirement would require a separately managed identity system.

## Configure Supabase

1. Create a Supabase project and save its project URL and **publishable key**.
2. In the Supabase SQL editor, apply `supabase/migrations/202610110001_login_roles.sql`.
3. In Auth settings, enable email sign-ups and TOTP MFA. Keep email confirmation enabled and configure a real email provider before production. The trigger in `202610120001_self_signup.sql` gives each new Auth user the least-privileged `inputer` role; administrators can elevate roles. TOTP AAL2 is required in SQL policies, so UI-only bypasses cannot read or change records.
4. Create your first account in the web app, confirm the email, and enroll TOTP. Copy that Auth user's UUID from **Authentication → Users**, then promote this one account in SQL Editor:

   ```sql
   update public.user_roles
   set role = 'administrator'
   where user_id = 'AUTH-USER-UUID-HERE';
   ```

   Replace the UUID with your Auth user's ID. After the first admin is enrolled, use the checked management function to add users; do not grant browser clients write access to `user_roles`.

5. Configure Google OAuth in Google Cloud. Set Supabase's Auth > Google provider with the Google Web Client ID and secret. Add Supabase's Google callback URL to Google Cloud. In Supabase Auth URL configuration, allow the deployed Vercel web URL and `secureworkspace://auth/callback` for mobile. Use the exact production and preview redirects you need.
6. Deploy the Edge Function with Supabase CLI. Link the project, set its protected secrets, then deploy:

   ```powershell
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase secrets set WEB_ORIGIN=https://YOUR_APP.vercel.app APP_ORIGINS=https://YOUR_APP.vercel.app
   npx supabase functions deploy manage-users
   ```

   Add approved preview origins to `APP_ORIGINS` as a comma-separated allow-list. Supabase injects the API key variables into the Edge Function. Never put a secret/service-role key into Vercel's public environment or the mobile app.

See [Getting started: self-registration, Google OAuth, and TOTP QR enrollment](GETTING_STARTED_OAUTH_MFA.md) for the dashboard clicks, Google callback setup, and the user enrollment walkthrough.

## Run the web app locally

The Supabase cloud app requires your own Supabase project. In PowerShell, from the project root:

```powershell
Copy-Item web/.env.example web/.env.local
```

Edit `web/.env.local` with the Supabase project URL, publishable key, and local app URL, then:

```powershell
npm --prefix web install
npm run web:dev
```

Open `http://localhost:3000`. In Supabase Auth URL configuration allow `http://localhost:3000` during development. The web page supports password sign-in, Google OAuth, required TOTP enrollment/challenge, record entry, and manager invitations. Admins can deactivate inputers and administrators can assign roles through the server function. The database role directory is intentionally not exposed to browser clients.

To start the earlier single-computer SQLite prototype instead, run `npm run run-local` from this project root and follow its terminal prompts. It is separate from the Supabase account system.

## Deploy the web app to Vercel

Import the repository into Vercel and set **Root Directory** to `web`. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` for Preview and Production, then deploy. These are publishable client values; RLS provides the data boundary. Add the final Vercel domain to Supabase Auth redirects and the Edge Function `APP_ORIGINS` allow-list.

## Run/build the Expo app

From PowerShell:

```powershell
Copy-Item mobile/.env.example mobile/.env
npm --prefix mobile install
npx expo prebuild
npx expo run:android
```

Set the two `EXPO_PUBLIC_` values in `mobile/.env` before starting. Run Expo commands from the `mobile` directory. For iOS, build on macOS with `npx expo run:ios`. Change the example bundle/package identifiers in `app.json` before release. Because SQLCipher is enabled by app configuration, use a native development build; Expo Go does not include SQLCipher. Google sign-in returns to the `secureworkspace://auth/callback` app link.

## Offline behavior and security limits

Cloud authentication needs a connection. Once signed in, the mobile app can queue new records locally in SQLCipher; the server accepts them only after reconnecting and rechecking MFA and role policies. Offline account management and remote record browsing are unavailable. A user disabled while offline may still make local queue entries, but cannot sync them.

This scaffold has no account recovery UX, no email-change flow, and only starter audit retention. Before production, configure a real email provider, review OAuth redirect allow-lists, validate RLS and Edge Function behavior, add recovery and factor-reset procedures, define retention/backups, and conduct a security review. Do not deploy with placeholder project values.

## Earlier local prototype

The root `server.mjs` / `start.mjs` remain for the original local-only experiment and use a separate SQLite database and accounts. They are not connected to Supabase and must not be treated as synchronized with the cloud project.
