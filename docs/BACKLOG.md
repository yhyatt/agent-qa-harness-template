# Backlog

Deferred items, grouped by slice. Items move out of here when a PR ships them.

## Slice: incremental journey sidecar (crash-safety)

Nothing deferred. Shipped the per-journey sidecar flush and the atomic sidecar replacement (ADR-017); see docs/DECISIONS.md.

## Slice 1: multi-model-dispatch.ts

Nothing deferred. Implementation matches `HANDOFF.md` "Open design questions" #1 (model selection) by shipping a documented default and exposing `QA_MODELS` as the override.

## Slice 2: dedup-findings.ts

Nothing deferred.

## Slice 3: generate-report.ts

Deferred nits from Opus review (2026-05-19):

- Pipe-escape applies to table cells but not to bullet content; if model output contains a single pipe in a bullet line it renders as-is (cosmetic only).
- INFO compact rendering uses a `(<journey>)` parenthetical that could double-up with the per-finding `journey_id` field; minor cosmetic.
- Per-journey severity calculation walks all three finding buckets every time; could be memoized but only matters at 100+ findings.

## Slice 4: scaffold.sh

- v1 ships `next-supabase` and `next-clerk` adapter heredocs only. Other framework or auth combos write a `// TODO: adapter not yet templated` stub with a loud warning. Add adapters as consuming projects demand them.
- **Hostile-locale character validation** (deferred nit from Opus review). Currently no validation on the LOCALE prompt value. Characters like `'`, `"`, `;` could break the sed step despite the `sed_escape` helper (which covers `\`, `&`, `|` only). Add a tight regex guard `^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,4})?$` before any files are written.
- **Order-of-operations: adapter written before sed runs** (deferred nit from Opus review). The scaffolder writes the adapter file before applying sed substitutions to config files. If a sed step fails, the workspace is partially dirty and re-running triggers the overwrite prompt unexpectedly. Fix: write all files at the end, after all sed operations succeed.

## Slice 5: Ballpark wet run

- **Shadow Supabase project**. Ballpark BACKLOG line 123 already tracks this. Yonatan provisions a separate free-tier `ballpark-qa` Supabase project before the Vercel-preview leg of the wet run.
- **OAuth auth capture**: resolved in fix/oauth-cdp-and-shared-run-id. QA_AUTH_PERSIST and QA_AUTH_CDP modes shipped.

## Slice 6: Target-deployment identity in reports

Surfaced by the 2026-05-22 Ballpark wet run: the report's `Build:` row is the consuming repo's `git rev-parse --short HEAD` (set at `tests/e2e/journeys/helpers.ts:282` and rendered at `scripts/generate-report.ts:524`), not the target app's deployed build. A downstream validator chased the SHA prefix into the consuming repo's git history and matched a superficially similar commit, producing a confidently wrong chronology claim while the QA findings themselves were valid.

- **B-HARNESS-7: rename `Build:` to `Harness SHA:`** in the report header and in the `meta.build` field name. Pure relabel. Prevents future readers from confusing it with the target app's identity. 5-minute fix in `generate-report.ts` plus the matching field in `helpers.ts` write site.
- **B-HARNESS-8: capture target-deployment headers at journey runtime**. The first `page.goto` in each journey records `response.headers()['x-vercel-id']`, `['x-vercel-deployment-url']`, and the response timestamp; these flow into `findings.json` as `meta.target_deployment = { vercel_id, deployment_url, captured_at }`. The report renders a separate `Target deployment:` row. Runtime capture is correct because a fresh request at report-gen time can race a redeploy.
- **B-HARNESS-9: optional `/__build` convention**. Document that if the target app exposes `GET /__build` returning `{ commit, deployedAt }` (reading `VERCEL_GIT_COMMIT_SHA` on Vercel), the harness will fetch it at run start and surface the result. Ship a Next.js example handler in `examples/nextjs-supabase/` (and stub adapters for the other frameworks). Wider scope than 7 or 8 because it requires consumer cooperation.

After all three land, a report header reads:

```
Target: https://app.example.com
Target deployment: <short SHA> (Vercel dpl_..., deployed <ISO timestamp>)
Harness SHA: <short SHA>
```

Three distinct identities, no naming ambiguity.

## v1.1 and beyond

- **Auto-issue creation threshold**. ADR-005 defers this. Open question: what threshold (HIGH-only, unanimous-only, two-models-agree) makes sense once signal-to-noise is measured. Cannot decide without real run data.
- **Dispatcher as separate npm package**. If the dispatcher implementation in `scripts/` grows large enough to be a real library, split it out to `@yhyatt/agent-qa-dispatch`. Defer until v1 implementation lands and we know the actual size.
- **CI auth fixture handling**. Today the CI workflow only runs J4 (no auth needed). Auth-gated journeys need a way to consume a CI-friendly auth fixture. Pattern: `secrets.QA_AUTH_FIXTURE` as base64-encoded JSON, decoded at job start, written to `tests/e2e/fixtures/host-auth.json`. Not yet wired.
- **Journey IDs across forks**. If two consuming projects diverge their journey catalogs, the dedup tooling may need to track repo origin. Open question.
- **WebKit and Firefox in the default matrix**. Playwright config currently includes Chromium and iPhone-13 (WebKit-Mobile). Adding Firefox doubles run time. Deferred decision.
- **Persistent userDataDir for `populate-auth.ts`**: shipped in fix/oauth-cdp-and-shared-run-id.
- **Supabase admin-API seed for auth fixtures**. Bypasses any UI auth entirely by directly creating a session via the Supabase admin client. Adapter-level (Supabase only). Would let CI runs avoid the CDP/headed-browser dance entirely. Defer until a consuming project wants it.
- **`docs/JOURNEY-CATALOG-GUIDE.md` examples** drawn from the Ballpark wet run. Currently abstract.
