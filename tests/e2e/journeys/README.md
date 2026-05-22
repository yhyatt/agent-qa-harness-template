# Journey Catalog

This directory holds the journey specs. Each journey is one `test.describe('JN: <name>', ...)` block in `journeys.spec.ts`. Helpers are in `helpers.ts`. Locale-snapshot logic is in `locale-snapshot.ts`.

See `../../../docs/JOURNEY-CATALOG-GUIDE.md` for how to design the catalog. See `../../../docs/PHILOSOPHY.md` for the per-step JSON schema each step emits.

## Running

```bash
# All journeys, both projects
npm run test:e2e

# Single journey
npm run test:e2e -- --grep "J4"

# Desktop only
npm run test:e2e:desktop

# Mobile only
npm run test:e2e:mobile

# Against a different target
TEST_TARGET_URL=https://my-app.vercel.app npm run test:e2e
```

Reports land in `.qa-runs/<timestamp>/`:

- `REPORT.md` - human-readable markdown
- `findings.json` - structured JSON (source of truth, used by the dispatcher)
- `screenshots/<journey>/<step>.png` - per-step screenshots

## Adding a journey

1. Pick the next free `J<N>` ID. Do not reuse retired IDs.
2. Add a `test.describe('J<N>: <short name>', () => { ... })` block in `journeys.spec.ts`.
3. Inside the test, follow the pattern:
   - `attachListeners(page)` at the start
   - `screenshot(page, 'J<N>', '<step-name>')` at each state transition
   - `runAxe(page)` after each significant render and push to `axeSurfaces`
   - `captureLocaleSnapshot(page)` for user-visible text
   - Push every finding with `findings.push(makeFinding({ ... }))`
   - Push a `JourneyResult` to `journeyResults` at the end
   - `expect(status, '<journey> failed').not.toBe('fail')` propagates the exit code
4. Update this README's journey table.

## Journey table (per-project mapping)

| ID | Name                            | Roles                | Auth required | Projects             |
|----|---------------------------------|----------------------|---------------|----------------------|
| J1 | primary-user happy path         | primary user         | host-auth     | TBD                  |
| J2 | secondary-user join             | guest or secondary   | none          | TBD                  |
| J3 | primary-user secondary flow     | primary user         | host-auth     | TBD                  |
| J4 | static surface walk             | none                 | none          | both                 |

Update the Projects column for your app once journey gating is decided.

## Populating the auth fixture

Run the one-time capture script:

```bash
npm run populate-auth
```

This opens a headed browser. Sign in as the primary user. When you reach the authed entry page, press Enter in the terminal. The script writes `tests/e2e/fixtures/host-auth.json`.

The fixture contains a live session cookie. It is gitignored. Never commit it.

Sessions expire (provider-specific; Clerk JWT cookies live ~7 days, Supabase ~30 days). When the fixture expires, the auth-gated journeys will report `auth-blocked` again. Re-run `npm run populate-auth`.

## auth tagging

Tag every auth-gated `test.describe` by suffixing its title with ` @auth`. Playwright's grep filters operate on the title, so this lets CI split runs cleanly:

```ts
test.describe('J1: primary-user happy path @auth', () => {
  // ...
});
```

`npm run test:e2e:no-auth` runs every journey except `@auth`-tagged ones (the default for PR CI, no fixture required). `npm run test:e2e:auth` runs only the `@auth`-tagged ones (the nightly job that depends on `host-auth.json`). No-auth describes stay untagged.

