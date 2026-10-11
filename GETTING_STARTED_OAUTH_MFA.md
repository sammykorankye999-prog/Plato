# Create an account, Google sign-in, and authenticator setup

New accounts may register with email and password or continue with Google. The database automatically gives each new account the basic `inputer` role. The role cannot be selected during registration. An administrator can grant `manager`, `admin`, or `administrator` access later.

## 1. Enable account registration in Supabase

1. Open your Supabase project dashboard.
2. Go to **Authentication → Sign In / Providers** (the dashboard may label this **Providers**).
3. In the Email provider settings, enable email sign-ups. Keep email confirmation enabled for real use.
4. Go to **Authentication → URL Configuration**. Set the Site URL to your app URL and add these Redirect URLs:
   - Local web: `http://localhost:3000/**`
   - Vercel: `https://YOUR-APP.vercel.app/**`
   - Expo development app: `secureworkspace://auth/callback`
5. In `web/.env.local`, set your project's URL and publishable key. For local use set `NEXT_PUBLIC_APP_URL=http://localhost:3000`.

Apply both SQL files in order if this is a new database: first `supabase/migrations/202610110001_login_roles.sql`, then `supabase/migrations/202610120001_self_signup.sql`. If you already applied the first migration, apply only the second. It creates the default-role trigger and gives any previously unassigned Auth accounts the limited `inputer` role. Never let frontend code update `user_roles` directly.

## 2. Configure Google OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), choose or create a project.
2. Open **Google Auth Platform** and configure the app name, support email, and audience. While in testing mode, add the Google accounts allowed to test.
3. Create an OAuth client with application type **Web application**.
4. In Supabase, open **Authentication → Sign In / Providers → Google**. Copy the **Callback URL** shown there.
5. In the Google OAuth client, add that exact Supabase URL under **Authorized redirect URIs**. It typically looks like `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`.
6. Copy the Google **Client ID** and **Client secret** into the Supabase Google provider settings, then enable the provider. Do not put the Google client secret in this app's `.env` files.
7. In the Google OAuth client's **Authorized JavaScript origins**, add `http://localhost:3000` for local web and `https://YOUR-APP.vercel.app` for production web. Use your real domains.
8. Keep the Supabase redirect allow-list from step 1 up to date. For local web, `NEXT_PUBLIC_APP_URL` must be `http://localhost:3000`; for production, set it to your Vercel URL.
9. Start the web app and choose **Continue with Google**. Google confirms your identity, then redirects through Supabase back to the app. New Google users receive the default `inputer` role from the database trigger.

For Expo, also register the `secureworkspace://auth/callback` redirect in Supabase. Google still redirects first to Supabase's callback; Supabase then returns to the Expo deep link. Build and test the native app separately because its SQLCipher configuration is not included in Expo Go.

## 3. Enroll two-factor authentication with the QR code

1. Sign in with email/password or Google. If email confirmation is enabled, confirm your email first.
2. On first sign-in, the app opens the authenticator setup screen. Supabase creates a unique TOTP factor and displays its QR code.
3. Open an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator, or 1Password. Choose **Add account** or **Scan QR code**, then scan the QR code displayed in the browser.
4. The authenticator will show a rotating six-digit code for this account. Enter that code on the setup page and select **Verify and continue**.
5. Supabase marks the factor verified and raises the session to AAL2. The app can then load records; Postgres RLS independently requires AAL2 for protected data.
6. On later sign-ins, enter the current six-digit code when prompted. Google sign-in is only the first factor; the authenticator check is still required.

Treat the QR code like a secret while it is displayed: anyone who scans it can generate codes for that factor. Do not screenshot it, send it to anyone, or paste it into a chat. If enrollment was exposed or the phone is lost, use an administrator-verified factor reset/recovery procedure before enrolling a replacement.

## 4. Try the account flow locally

From PowerShell in the project root:

```powershell
Copy-Item web/.env.example web/.env.local
# Edit web/.env.local with your Supabase URL and publishable key.
npm.cmd --prefix web install
npm.cmd run web:dev
```

Open `http://localhost:3000`, select **Create account**, and register an email/password, or select **Sign in** and use Google. Complete email confirmation if prompted, then scan the authenticator QR code and enter its six-digit code. Google OAuth will not work until the Google and Supabase provider settings above are complete.

For local registration, keep Supabase's email confirmation setting enabled unless you have configured a trusted email provider. Supabase's default test email service is limited and should not be used for production.
