# Deploy the Plato website on Vercel

The Plato browser app is the Expo web client in `plato-lms/mobile/`. This deploys its web build to Vercel; the same Expo project can still build Android and iOS apps separately. The Flask API and database remain on Render.

## 1. Confirm the Render API is ready

Open the Render service URL followed by `/healthz`, for example `https://YOUR-SERVICE.onrender.com/healthz`. Continue when it returns `{"status":"ok"}`. Copy the base service URL without `/healthz` or a trailing slash. If it is not healthy yet, fix the Render deployment first; the website cannot sign in until the API works.

## 2. Import the website into Vercel

In Vercel, choose **Add New → Project**, import `sammykorankye999-prog/Plato`, and configure the project:

- **Root Directory:** `plato-lms/mobile`
- **Framework Preset:** Other
- **Install Command:** `npm install`
- **Build Command:** `npx expo export --platform web`
- **Output Directory:** `dist`

Under **Environment Variables**, add this for **Production** (and Preview if you will use preview deployments):

| Name | Value |
| --- | --- |
| `EXPO_PUBLIC_PLATO_API_URL` | Your Render service base URL, e.g. `https://YOUR-SERVICE.onrender.com` |

This URL is public and belongs in the browser app. Do not add database passwords, pepper, encryption keys, or other backend secrets to Vercel. Click **Deploy**. When it finishes, open the Vercel domain and check that the page loads.

## 3. Allow the Vercel website to call the API

In the Render dashboard, open the Flask API service → **Environment**. Set `WEB_APP_ORIGINS` to the exact Vercel website origin, such as `https://plato-lms.vercel.app` (no path and no trailing slash). Save the change and redeploy/restart the Render service. If you use a custom domain, include that exact origin too, separated by commas.

## 4. Verify

Open the Vercel site, sign in or create an account, and confirm the API-backed pages load. In browser developer tools, requests should go to the Render service URL. If the page loads but API calls fail, check that `EXPO_PUBLIC_PLATO_API_URL` is correct and that `WEB_APP_ORIGINS` exactly matches the browser's address bar.

The web frontend is static. Authentication, roles, MFA, and database access remain in the Render API; never put server secrets in `EXPO_PUBLIC_*` variables. The Expo phone app uses the same API URL when it is built, but is deployed separately through Expo's mobile build process.

## Password recovery email setup

The server-rendered Render website now includes `/forgot-password` and `/reset-password` pages. Configure your SMTP provider values as private environment variables in Render: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, and `SMTP_FROM`. Also set `SMTP_USE_SSL=1` for implicit TLS providers (commonly port 465); for STARTTLS providers (commonly port 587), set `SMTP_USE_SSL=0`. Set `PASSWORD_RESET_URL` to `https://YOUR-RENDER-SERVICE.onrender.com/reset-password` (for this deployment, `https://plato-1-2lnp.onrender.com/reset-password`). Never put SMTP credentials in Vercel or in an `EXPO_PUBLIC_*` variable. Save the settings and wait for Render to restart.
