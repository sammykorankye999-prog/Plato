# Plato HTTPS API

The Flask service is the Render backend. The Expo project builds separate web and Android/iOS clients. They use JSON over HTTPS; no database credentials, pepper, or encryption keys belong in a client.

Base path: `/api/v1`. Set `EXPO_PUBLIC_PLATO_API_URL` to the backend origin (without `/api/v1`). The browser client origin must be included in the backend's comma-separated `WEB_APP_ORIGINS` environment variable, for example `https://plato-web.example.com`. Native mobile requests do not rely on CORS.

## Authentication

1. `POST /auth/register` accepts `{ "username", "email", "password", "role", "invite_code" }`. Public roles are `student` and `instructor`; instructor registration also requires the configured invite code. Admin accounts are created by an existing admin.
2. `POST /auth/login` accepts `{ "username": "username-or-email", "password" }`. It returns either `{ "mfa_required": true, "challenge_token" }` or `{ "mfa_setup_required": true, "challenge_token", "secret", "provisioning_uri", "qr_data" }`.
3. Scan `qr_data` with an authenticator app when enrolling. `POST /auth/verify-totp` with the challenge bearer token and `{ "code": "123456" }` enables first-time setup or verifies the existing factor. A successful response contains a 12-hour `access_token` and public user profile.
4. `POST /auth/request-password-reset` accepts `{ "email" }` and returns the same generic message whether or not the account exists. It emails a single-use link that expires after 30 minutes. `POST /auth/reset-password` accepts `{ "token", "password" }`; the new password must be at least 12 characters. Reset links require the SMTP and `PASSWORD_RESET_URL` settings in Render. Password reset preserves TOTP enrollment.
5. Send `Authorization: Bearer <access_token>` for protected endpoints. `POST /auth/logout` revokes that API session. Access tokens are signed, time-limited, and checked against account status and `auth_version`.

The server-rendered Flask website also provides `GET/POST /forgot-password` and `GET/POST /reset-password` for browser password recovery. The email link must point to the same site’s `/reset-password` page. Both browser forms use CSRF protection; reset tokens are single-use and expire after 30 minutes.

## Routes

| Method | Path | Access |
| --- | --- | --- |
| GET | `/health` | Public liveness check |
| POST | `/auth/register` | Public registration, subject to settings |
| POST | `/auth/login` | Public first factor |
| POST | `/auth/verify-totp` | Short-lived MFA challenge bearer |
| POST | `/auth/request-password-reset` | Public; rate-limited, non-enumerating response |
| POST | `/auth/reset-password` | Public one-time reset token |
| POST | `/auth/logout` | Signed-in user |
| GET | `/me` | Signed-in user profile |
| GET | `/courses` | Signed-in user's courses and available student courses |
| GET | `/courses/{id}` | Signed-in user; lesson text only for enrolled students, course owner, or admin |
| POST | `/courses` | Instructor creates own course |
| POST | `/courses/{id}/enroll` | Student |
| POST | `/courses/{id}/lessons` | Owning instructor |
| POST | `/lessons/{id}/complete` | Enrolled student |
| GET | `/admin/summary` | Admin |
| POST | `/admin/users` | Admin creates a user |
| PATCH | `/admin/users/{id}` | Admin changes role or soft-deletes/restores account |
| POST | `/admin/users/{id}/reset-mfa` | Admin |
| PATCH | `/admin/settings` | Admin changes registration settings |
| POST | `/admin/config-backups` | Admin saves a configuration-only restore point |
| POST | `/admin/config-backups/restore-latest` | Admin restores configuration only |

All writes accept JSON. Errors use `{ "error": "..." }` with a suitable HTTP status. Public responses never include password hashes or stored TOTP secrets.

## Deployments

- Backend: deploy the Flask service on Render and configure its database and private secrets there.
- Web: build the Expo web client with `npx expo export --platform web`; the static `dist/` output is deployed to Vercel from `plato-lms/mobile`.
- Mobile: build the Expo app separately for Android/iOS. Set its public API base URL to the HTTPS service URL.

The legacy server-rendered Flask routes remain available during migration. The new clients use only `/api/v1`.
