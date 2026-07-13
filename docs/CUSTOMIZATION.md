# Customization Guide

How to adapt the template for a specific stack. Two concrete worked examples below: Next.js plus Supabase (Ballpark's stack, the first wet-run validator) and Next.js plus Clerk (the most common Vercel-ecosystem default).

The interactive `scripts/scaffold.sh` will eventually do most of these substitutions automatically. Today it is a stub; the patches below are the manual recipe.

The scaffolder runs after you have chosen a consumption pattern. See `docs/CONSUMPTION-PATTERNS.md` for the three supported patterns and how to pick.

## What the scaffolder needs to know

When you run `scripts/scaffold.sh` (or do the substitutions by hand), it asks:

1. **Framework.** Next.js, SvelteKit, Astro, Nuxt.
2. **Auth provider.** Supabase, Clerk, Auth0.
3. **Database.** Postgres (Neon or Supabase), Cloudflare D1, MongoDB.
4. **Host.** Vercel, Cloudflare Workers.
5. **Locale primary.** ISO code (`en-US`, `he-IL`, `de-DE`).
6. **App URL placeholder.** Used as `TEST_TARGET_URL` default.

The answers drive three things:

- The auth fixture capture flow (different providers have different OAuth handshakes)
- The DB-state capture helper (different drivers, different connection strings)
- The locale config in `playwright.config.ts`

## Adapter file pattern

Each adapter lives in `tests/e2e/adapters/<stack>.ts` and exports a uniform interface:

```ts
export interface StackAdapter {
  // Used by populate-auth.ts
  captureAuthState(opts: {
    url: string;
    statePath: string;
    role: 'host' | 'admin' | 'user';
  }): Promise<void>;

  // Used by helpers.ts in DB-state capture steps
  captureDbState(opts: {
    sessionId: string;
    tables: string[];
  }): Promise<Record<string, unknown[]>>;

  // Used by the scaffolder for env var docs
  requiredEnvVars: string[];
}
```

The journey spec never imports an adapter directly. The helpers module does. This way the journey catalog stays stack-agnostic and only the helpers know about Supabase RPC versus Clerk JWT versus D1 prepared statements.

## Example 1: Next.js plus Supabase (Ballpark's stack)

**Auth fixture capture:**

```ts
// tests/e2e/adapters/next-supabase.ts
import { chromium } from '@playwright/test';

export const nextSupabase: StackAdapter = {
  async captureAuthState({ url, statePath, role }) {
    const browser = await chromium.launch({ headless: false });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      // CUSTOMIZATION: set the locale used by your app's i18n config
      locale: 'he-IL',
    });
    const page = await ctx.newPage();
    // CUSTOMIZATION: this is the auth entry point for Supabase OAuth flow
    await page.goto(`${url}/auth/login`);
    console.log(`Sign in as ${role}. Press Enter when at the dashboard.`);
    await new Promise((res) => process.stdin.once('data', res));
    await ctx.storageState({ path: statePath });
    await browser.close();
  },

  async captureDbState({ sessionId, tables }) {
    // CUSTOMIZATION: import the supabase admin client from the consuming app
    // and read the requested tables filtered by session_id
    throw new Error('Implement against the consuming app supabase client');
  },

  requiredEnvVars: [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY',
  ],
};
```

**DB state capture pattern:**

For Postgres-on-Supabase, the natural approach is to expose a `qa_capture_state(session_id uuid)` RPC function that returns the per-table rows you want to assert against, JSON-encoded. The harness calls the RPC; the SQL function decides what to expose. This keeps the harness from needing direct DB credentials.

**RLS consideration:** if the harness runs against staging with the publishable key only, the QA fixture user must have RLS policies allowing reads on the tables it inspects. Easier path: route DB-state capture through the host's authenticated session (the storageState already covers it).

**Shadow project provisioning:**

```bash
# create a separate Supabase project for QA runs
# this is a one-time setup, not part of every run
supabase projects create my-app-qa --org-id <org>
supabase db push --project-ref <new-project-ref>
# point TEST_TARGET_URL at the staging deploy of the consuming app,
# configured to use the QA Supabase project
```

The shadow project lets destructive QA runs (delete sessions, clear state) not pollute dev or prod data.

## Example 2: Next.js plus Clerk

**Auth fixture capture:**

Clerk's hosted UI changes URL paths frequently. The capture script should not hard-code the sign-in URL; instead, navigate to a protected route and let Clerk redirect to its own UI.

```ts
// tests/e2e/adapters/next-clerk.ts
import { chromium } from '@playwright/test';

export const nextClerk: StackAdapter = {
  async captureAuthState({ url, statePath, role }) {
    const browser = await chromium.launch({ headless: false });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    // CUSTOMIZATION: a protected route forces Clerk's sign-in redirect
    await page.goto(`${url}/dashboard`);
    console.log(`Sign in as ${role}. Press Enter when at /dashboard.`);
    await new Promise((res) => process.stdin.once('data', res));
    await ctx.storageState({ path: statePath });
    await browser.close();
  },

  async captureDbState({ sessionId, tables }) {
    // CUSTOMIZATION: Clerk does not provide a DB; the app's own DB
    // (Postgres, Mongo, etc) is independent. Adapt to the DB layer.
    throw new Error('Implement against the consuming app DB client');
  },

  requiredEnvVars: [
    'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    'CLERK_SECRET_KEY',
  ],
};
```

**Clerk JWT considerations:**

Clerk session tokens are short-lived (60s by default). The `storageState` file captures the session cookie which Clerk uses to mint fresh JWTs. The fixture is good for ~7 days; after that, recapture.

The harness will produce a clear error when a fixture has expired (network 401s on the first authed request). Treat it as a known recurring task. Cron the recapture if you have a stable QA account credential.

## Other framework substitutions

### SvelteKit

- The journey spec is identical; Playwright does not care about framework.
- The auth fixture capture is auth-provider-specific, not framework-specific.
- `playwright.config.ts` does not change except for the `webServer` block, if you use it to start a local dev server.

### Astro and Nuxt

- Same. Playwright drives the rendered DOM, which is framework-agnostic.
- Watch for hydration-timing differences: Astro's island architecture means some interactive elements appear later than their HTML. Pattern A's `expect(...).toBeVisible()` handles this; manual `waitForTimeout` does not.

## Locale customization

```ts
// playwright.config.ts (edit this when scaffolding)
projects: [
  {
    name: 'chromium-desktop',
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1280, height: 900 },
      // CUSTOMIZATION: set to your app's primary locale
      locale: 'en-US', // or 'he-IL', 'de-DE', 'ja-JP'
    },
  },
  // ...
]
```

The `locale-snapshot` helper does not need locale-specific logic. It captures all user-visible text on the page; the locale is implicit in what comes back.

## DB driver substitutions

### Postgres (Neon or Supabase)

```ts
import postgres from 'postgres';
const sql = postgres(process.env.QA_DATABASE_URL!);
const rows = await sql`select * from sessions where id = ${sessionId}`;
```

### Cloudflare D1

The D1 binding is a Workers runtime concern; from a Node script you need the D1 HTTP API.

```ts
const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
  body: JSON.stringify({ sql: 'select * from sessions where id = ?', params: [sessionId] }),
});
```

### MongoDB

```ts
import { MongoClient } from 'mongodb';
const client = await MongoClient.connect(process.env.MONGO_URL!);
const session = await client.db().collection('sessions').findOne({ _id: sessionId });
```

## Hosting substitutions

### Vercel

- `TEST_TARGET_URL` points at the production or preview URL
- CI in `.github/workflows/ci.yml` can use Vercel CLI to fetch the latest preview URL for the PR and target it

### Cloudflare Workers

- `TEST_TARGET_URL` points at the `*.workers.dev` URL or the custom domain
- CI uses `wrangler deploy --dry-run` to validate before triggering the harness

## Migration: from a custom harness to this template

If you already have Playwright tests, the migration is:

1. Move existing `.spec.ts` files into `tests/e2e/journeys/`
2. Refactor each test to push findings into the shared `findings[]` accumulator
3. Replace `expect()` assertions with the harness pattern: capture the failure as a finding, then `expect(status).not.toBe('fail')` at the end
4. Add the journey to the `J<N>` numbering scheme
5. Wire the capture helpers (`screenshot`, `attachListeners`, `runAxe`). Report writing is handled by the harness: each project's `test.afterAll` calls `writeProjectSidecar`, and the Playwright `globalTeardown` calls `aggregateRunReport` to merge every project's sidecar into the combined report.

Most tests port over in under an hour each.

## Capturing the auth fixture

`scripts/populate-auth.ts` supports three modes for capturing `tests/e2e/fixtures/host-auth.json`:

| Mode | When to use | Trigger |
|---|---|---|
| Ephemeral | Email/password, magic-link, or any auth that does not trigger anti-bot detection. | `npm run populate-auth` (default) |
| Persistent | Auth flows that benefit from a returning-user profile (cookies, localStorage carrying across runs). | `QA_AUTH_PERSIST=1 npm run populate-auth` |
| CDP attach (recommended for OAuth) | Google, Microsoft, GitHub, or any OAuth provider that flags Playwright's bundled Chromium as automated. The Playwright Chromium triggers Google bot detection silently; the fix is to use your real Chrome browser. | (see below) |

### CDP attach mode

1. Start your normal Chrome with remote debugging:

   ```bash
   # Linux / WSL
   google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/qa-chrome-profile &
   # macOS
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/qa-chrome-profile &
   ```

   The `--user-data-dir` flag is required on Chrome 136 and later (it's ignored on the default profile). The /tmp path also isolates QA cookies from your normal browsing profile.

2. In that Chrome, sign into your app normally.

3. From the QA repo:

   ```bash
   QA_AUTH_CDP=1 TEST_TARGET_URL=https://my-app.com npm run populate-auth
   ```

   populate-auth attaches via CDP, finds the BrowserContext on your target URL, captures storageState, and exits. Chrome stays open.

4. Verify the fixture is real: `wc -c tests/e2e/fixtures/host-auth.json` should be > 1KB.

### WSL2 + CDP auth capture

Persistent-mode bundled Chromium under WSLg has known input forwarding issues: the window paints but mouse clicks and sometimes keystrokes do not reach the browser. OAuth flows that require clicking through a Google or Microsoft consent screen are the common failure mode. CDP attach is the reliable path on WSL2 because Playwright only reads storageState from your native Windows Chrome; it does not drive any input.

The catch is networking. Chrome on Windows binds to `127.0.0.1` by default, and WSL cannot reach Windows loopback over the default bridge. Chrome must bind to all interfaces:

Run this from a Windows shell (cmd.exe or PowerShell), not from WSL. cmd.exe and PowerShell do not accept POSIX `\` line continuations, so the command is kept on a single line.

```
chrome.exe --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --user-data-dir=C:\Temp\qa-chrome-profile
```

Then find the WSL-to-Windows gateway IP from inside WSL:

```bash
ip route | grep default
# default via 172.20.16.1 dev eth0 ...
#            ^^^^^^^^^^^^ this address is your gateway
```

And run populate-auth pointing at that IP:

```bash
QA_AUTH_CDP=1 QA_AUTH_CDP_URL=http://172.20.16.1:9222 \
  TEST_TARGET_URL=https://my-app.com npm run populate-auth
```

On Chrome 136 and later the `--user-data-dir` flag is mandatory even on the default profile; without it `--remote-debugging-port` is silently ignored.

If `chromium.connectOverCDP` still fails, check the Windows firewall: opening port 9222 to the WSL subnet may need an inbound rule. Test connectivity from WSL first with `curl http://<gateway-ip>:9222/json/version`; a healthy Chrome answers with a JSON blob.

## Splitting CI by auth-gated vs no-auth journeys

The template ships two npm scripts that filter journeys by an `@auth` title tag:

```json
"test:e2e:no-auth": "playwright test --grep-invert @auth",
"test:e2e:auth":    "playwright test --grep @auth --pass-with-no-tests"
```

Convention: any `test.describe(...)` for a journey that requires a populated auth fixture gets ` @auth` suffixed to its title.

```ts
test.describe('J1: primary-user happy path @auth', () => {
  // ...
});
```

The default PR CI gate should run `test:e2e:no-auth`, which needs no fixture and never blocks on session expiry. A separate nightly job runs `test:e2e:auth` against a fresh `host-auth.json`. Splitting this way means PR runs stay green when the fixture happens to be stale, and the nightly catches actual auth-gated regressions.

`--pass-with-no-tests` keeps `test:e2e:auth` from failing before any consumer journey is tagged with `@auth`. Remove it once at least one journey carries the tag if you want a missing match to fail the run.

## Target-app deployment identity (`/__build` convention)

The harness records the deployment the journey actually hit so report consumers can pin a finding to a specific deployed build. Two independent capture paths populate the `target_deployment` field in the JSON sidecar:

1. Runtime header capture (zero configuration on Vercel). The Playwright response listener reads `x-vercel-id` and `x-vercel-deployment-url` off the main-frame document navigation response. The filter (`request.isNavigationRequest()` plus mainFrame plus `resourceType === 'document'`) makes sure a subresource or a cross-origin script cannot mis-attribute the deployment. Both headers are set automatically by Vercel; non-Vercel hosts simply leave them null.
2. Optional `/__build` endpoint (consumer-side opt-in). If the target app exposes `GET /__build` returning JSON of the shape `{ "commit": string, "deployedAt": string }`, the harness fetches it once at report time and surfaces the values as `build_commit` and `deployed_at`. The parser resolves each field independently, so a valid `commit` survives a malformed `deployedAt` and vice versa. The fetch URL respects the target's base path (`https://host/app/__build`, not `https://host/__build` when the target is hosted under a subpath).

On Vercel, the consuming app reads its own build identity from these envs:

- `VERCEL_GIT_COMMIT_SHA` for the commit.
- `VERCEL_DEPLOYMENT_TARGET_URL` for the deployment URL (already covered by the x-vercel header above).
- The deployment timestamp is typically derived from `VERCEL_DEPLOYMENT_ID` lookup or stored at build time; expose it as ISO 8601.

If the endpoint is absent, returns non-2xx, returns non-JSON, or times out (3-second deadline), `build_commit` and `deployed_at` come back as null. When the endpoint responds but one field is missing or malformed, only that one resolves to null. The harness never fails a QA run on this path; it is identity capture, not gating.

The resulting report header reads:

```
Target: https://app.example.com
Target deployment: abc1234, Vercel iad1::xyz, deployed 2026-05-22T11:30:00.000Z, captured 2026-05-22T11:31:14.027Z
Harness SHA: f270b74
```

Three distinct identities, no naming ambiguity. See `examples/nextjs-supabase/README.md` for a Next.js App Router handler snippet.
