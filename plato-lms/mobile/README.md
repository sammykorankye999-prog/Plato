# Plato web and mobile client (Expo)

This Expo project provides separate web, Android, and iOS interfaces. It calls the Flask JSON API rather than displaying the server-rendered website in a WebView. The AWS backend remains responsible for authentication, two-factor verification, roles, data access, and database operations.

## Configure the API address

Copy `.env.example` to `.env` in this folder. Set `EXPO_PUBLIC_PLATO_API_URL` to the HTTPS origin of the deployed AWS backend, without `/api/v1` (for example `https://plato-api.example.com`). This is a public address, not a secret. Restart Expo after changing it.

For local development, use `http://10.0.2.2:5000` from an Android emulator. A physical phone needs the computer's private Wi-Fi IP and both devices on the same network.

## Run mobile

```powershell
npm.cmd install
npm.cmd start
```

Scan the Expo QR code with Expo Go. Android native builds require Android Studio and its Android SDK.

## Build the separate web client

```powershell
npm.cmd install
npx.cmd expo export --platform web
```

The static web client is written to `dist/`. Deploy that directory separately (for example with AWS Amplify Hosting). Set the AWS backend's `WEB_APP_ORIGINS` variable to the exact deployed web origin, such as `https://plato.example.com`, for browser CORS. Mobile app requests do not require browser CORS.

The client supports account registration, password sign-in, first-time TOTP QR enrollment, MFA verification, course lists and lessons, student enrollment/progress, instructor course creation, and administrator user/configuration controls. The access token is held in app memory and users sign in again after closing/restarting the app.

See [the API reference](../API.md) and [the backend deployment guide](../BACKEND_DEPLOYMENT.md).
