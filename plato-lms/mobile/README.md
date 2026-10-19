# Plato LMS mobile app (Expo)

This Expo app wraps the existing responsive Flask LMS in a native Android/iOS WebView. It uses the same server, accounts, roles, courses, learner progress, and TOTP sign-in as the web app, so both clients share one database.

## Set the server address

Copy `.env.example` to `.env` inside this folder and set `EXPO_PUBLIC_PLATO_URL`:

- Deployed server: use its HTTPS address, for example `https://plato.example.com`.
- Android emulator with Flask on your computer: `http://10.0.2.2:5000`.
- Physical phone: use the computer's private Wi-Fi IP, such as `http://192.168.1.20:5000`. The phone and computer must share Wi-Fi, and Flask must listen on `0.0.0.0` for development.

Do not use `localhost` on a physical phone: it points to the phone itself. Deployed servers must use HTTPS. The app keeps app navigation on the configured Plato host and opens external links in the device browser.

## Install and run (PowerShell)

Install Node.js and Android Studio (including Android SDK and an emulator), or use a phone with Expo Go:

```powershell
npm.cmd install
npm.cmd start
```

Scan the Expo QR code with Expo Go. For a locally built Android app, run `npm.cmd run android` after installing the Android SDK. The app shows the existing Flask pages, including password sign-in, MFA, course pages, and role-specific dashboards; all account and learning data stays on the Flask server.
