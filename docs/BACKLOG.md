# Backlog

Deferred items, grouped by slice. Items move out of here when a PR ships them.

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

## Slice 5: Ballpark wet run

- **Shadow Supabase project**. Ballpark BACKLOG line 123 already tracks this. Yonatan provisions a separate free-tier `ballpark-qa` Supabase project before the Vercel-preview leg of the wet run.
- **OAuth captcha on populate-auth**. Fresh Chromium triggers Google captcha. v1.1 patch: optional `chromium.launchPersistentContext('.qa-runs/userDataDir/')` when `QA_AUTH_PERSIST=1`. For the first wet run, accept the manual-captcha cost.

## v1.1 and beyond

- **Auto-issue creation threshold**. ADR-005 defers this. Open question: what threshold (HIGH-only, unanimous-only, two-models-agree) makes sense once signal-to-noise is measured. Cannot decide without real run data.
- **Dispatcher as separate npm package**. If the dispatcher implementation in `scripts/` grows large enough to be a real library, split it out to `@yhyatt/agent-qa-dispatch`. Defer until v1 implementation lands and we know the actual size.
- **CI auth fixture handling**. Today the CI workflow only runs J4 (no auth needed). Auth-gated journeys need a way to consume a CI-friendly auth fixture. Pattern: `secrets.QA_AUTH_FIXTURE` as base64-encoded JSON, decoded at job start, written to `tests/e2e/fixtures/host-auth.json`. Not yet wired.
- **Journey IDs across forks**. If two consuming projects diverge their journey catalogs, the dedup tooling may need to track repo origin. Open question.
- **WebKit and Firefox in the default matrix**. Playwright config currently includes Chromium and iPhone-13 (WebKit-Mobile). Adding Firefox doubles run time. Deferred decision.
- **Persistent userDataDir for `populate-auth.ts`** (see Slice 5 above; promoted to v1.1).
- **`docs/JOURNEY-CATALOG-GUIDE.md` examples** drawn from the Ballpark wet run. Currently abstract.
