# Auth fixtures

This directory holds Playwright `storageState` JSON files. Each file is a captured browser session for one role (host, admin, user).

## Files (gitignored)

- `host-auth.json` - primary user (host) session, used by J1 and J3
- `admin-auth.json` - optional admin role, used by future journeys
- `user-auth.json` - optional secondary authed role

All `*.json` files in this directory are gitignored. They contain live session cookies. Treat them as secrets equivalent to `.env.local`.

## Capturing a fixture

```bash
# default: captures host-auth.json
npm run populate-auth

# capture a different role
ROLE=admin QA_AUTH_FIXTURE_PATH=tests/e2e/fixtures/admin-auth.json npm run populate-auth
```

The script opens a headed Chromium browser at the target URL. Sign in. Press Enter in the terminal. The script writes the storageState to the configured path.

## Lifetime

Session cookies expire on the provider's schedule:

- Clerk: ~7 days
- Supabase: ~30 days (configurable)
- Auth0: provider-dependent

When the fixture expires, auth-gated journeys report `auth-blocked` instead of failing. Recapture with `npm run populate-auth`.
