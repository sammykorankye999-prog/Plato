# Deploy the web frontend separately from the AWS API

The Expo project in `mobile/` builds the web frontend and native Android/iOS clients. The Flask app and PostgreSQL database belong on AWS. For Vercel, import the GitHub repository and set **Root Directory** to `plato-lms/mobile` so Vercel builds the Expo frontend, not Flask.

In Vercel **Settings → Build and Deployment**, use:

- Framework preset: **Other** (or Expo, if Vercel detects it)
- Build command: `npx expo export --platform web`
- Output directory: `dist`
- Install command: `npm install`

Under **Settings → Environment Variables**, add `EXPO_PUBLIC_PLATO_API_URL` with the AWS HTTPS service origin, for example `https://your-aws-service.example.com`. It is a public URL; do not put backend secrets here. Redeploy after setting it.

After the Vercel domain is assigned, add that exact origin to `WEB_APP_ORIGINS` in the AWS backend configuration, for example `https://plato-web.vercel.app`, then redeploy the backend. This allows browser requests to the API. Do not use `*` for allowed origins.

For Android/iOS, set the same `EXPO_PUBLIC_PLATO_API_URL` in `mobile/.env` when building the Expo app. The phone app calls AWS directly and does not use the Vercel web hosting URL.

If Vercel reports a Flask import or `SECRET_KEY` error, its **Root Directory** is probably set to `plato-lms` instead of `plato-lms/mobile`; correct it and redeploy.
