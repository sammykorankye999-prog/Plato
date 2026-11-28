# Deploy the Plato Flask website to Vercel

This deploys the server-rendered Flask website in `plato-lms/` as a Vercel Python application. It is separate from the Expo browser/mobile app in `plato-lms/mobile/`. Vercel supports Flask through its Python runtime; the project keeps its Supabase PostgreSQL database as the persistent data store.

## Create a separate Vercel project

Keep the existing Expo project unchanged. In Vercel, import the same GitHub repository as a **new project** and use these settings:

- **Project name:** `plato-lms-web` (or another available name)
- **Root Directory:** `plato-lms`
- **Framework Preset:** Other (or Flask, if Vercel detects it)
- **Build Command:** leave the override disabled / blank
- **Output Directory:** leave the override disabled / blank
- **Install Command:** leave the override disabled / blank

Vercel detects `app.py` and `requirements.txt` in this root directory. `vercel.json` sets a 60-second function limit for the Flask app.

## Set Vercel environment variables

In the new project, open **Settings → Environment Variables** and add these for **Production**. Copy the existing secret values from the Render backend’s Environment settings; never paste them into chat or commit them to this repository.

| Variable | Value |
| --- | --- |
| `APP_ENV` | `production` |
| `COOKIE_SECURE` | `1` |
| `SECRET_KEY` | Same existing Flask secret from Render |
| `PASSWORD_PEPPER` | Same existing password pepper from Render |
| `TOTP_ENCRYPTION_KEY` | Same existing TOTP encryption key from Render |
| `BACKUP_ENCRYPTION_KEY` | Same existing backup encryption key from Render |
| `DATABASE_URL` | Existing Supabase PostgreSQL connection string from Render |
| `SMTP_HOST` | Existing SMTP provider host, if password recovery email is configured |
| `SMTP_PORT` | Existing SMTP provider port |
| `SMTP_USERNAME` | Existing SMTP username |
| `SMTP_PASSWORD` | Existing SMTP password/API key |
| `SMTP_FROM` | Existing allowed sender address |
| `SMTP_USE_SSL` | `0` for STARTTLS on port 587; `1` for SSL on port 465 |
| `PASSWORD_RESET_URL` | `https://YOUR-VERCEL-DOMAIN/reset-password` |

Do not add `WEB_APP_ORIGINS`; the server-rendered Flask website and its form submissions share the same Vercel origin. Do not add any `EXPO_PUBLIC_*` variables to this Flask project.

After saving the variables, deploy the new project. Use the Vercel URL it assigns, then check `/healthz`; a healthy service returns `{"status":"ok"}`. If startup fails, inspect **Vercel → Project → Logs** for the function error.

## Important notes

- This creates another deployment; it does not move the Render service or automatically change the existing Expo Vercel project.
- Both deployments will connect to the same Supabase database, so they show the same user and course records.
- Changing `SECRET_KEY`, `PASSWORD_PEPPER`, or `TOTP_ENCRYPTION_KEY` from the values already used by Render can invalidate sessions or prevent existing password/MFA data from working. Copy the exact existing values.
- The server-rendered Flask login supports two-factor authentication and password reset pages at `/forgot-password` and `/reset-password`.
