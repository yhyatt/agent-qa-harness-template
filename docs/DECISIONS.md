# Decisions

ADR-style log of design choices. Each entry: what was decided, what alternatives were considered, what the trade-off is, and what would cause us to revisit.

## ADR-001: Playwright over Cypress

**Decided:** Playwright as the browser-automation layer.

**Alternatives:** Cypress, Selenium, Puppeteer.

**Rationale:**

- Multi-context support. Playwright's `BrowserContext` model lets one Node process drive multiple isolated browser sessions in parallel. Cypress runs tests sequentially against a single browser; it cannot natively model "host plus three players" inside one test. Pattern A coordination needs multi-context.
- API surface. Playwright's `expect(locator).toBeVisible()` style is web-first (polling assertions with timeouts). Cypress's command chain has its own idioms that fight with structured-finding accumulation.
- Cross-browser. Playwright drives Chromium, Firefox, and WebKit from the same API. Cypress is Chromium-mostly.
- Mobile emulation. Playwright's `devices['iPhone 13']` is straightforward; Cypress has it but the ergonomics are worse.

**Trade-off:**

- Cypress has a richer interactive dev UI. Playwright's UI mode is good but not better.
- Cypress is more familiar to most JS frontend engineers. Playwright is gaining but starts from less brand recognition.

**Revisit if:** the harness ever needs to be authored by people who already know Cypress well and the multi-context need disappears.

## ADR-002: Cross-provider second opinions in the dispatch matrix

**Decided:** the dispatch matrix must include at least one non-Anthropic model. With provider-prefixed OpenRouter ids, the check reads "at least one model whose id does not start with `anthropic/`".

**Alternatives:** single-family dispatch (Anthropic-only or Gemini-only), no enforcement.

**Rationale:**

- Provider-family blind spots are real. Anthropic models share training data; a copy mistake that Sonnet generated does not get flagged by Sonnet on review. The same applies in the other direction: a Gemini-generated mistake passes Gemini's review.
- Cross-provider opinions are the load-bearing part of the dedup story.

**Trade-off:**

- Some signal is sacrificed when a model family the user does not trust is forced into the matrix. The escape hatch is `QA_ALLOW_SINGLE_FAMILY=1` for explicit testing.

**Revisit if:** an empirical study shows single-family dispatch surfaces the same set of bugs as cross-family.

**Note:** ADR-002 originally also prescribed Anthropic-direct dispatch via `@anthropic-ai/sdk` alongside OpenRouter for everything else. That part was superseded by ADR-012; OpenRouter is now the single dispatch path.

## ADR-003: JSON-per-step output schema

**Decided:** every journey step emits a JSON object conforming to the schema in `PHILOSOPHY.md`. Markdown reports are renderings of the JSON, not sources.

**Alternatives:** prose-first agent reports, hybrid (prose with JSON sidecar), unstructured.

**Rationale:**

- Deterministic dedup needs structured input.
- Run-over-run diff needs structured input.
- Programmatic gating (CI fails on any HIGH finding) needs structured input.
- Multi-model comparison needs uniform schema.

**Trade-off:**

- Agents are slightly less expressive when forced into a schema. Free-form judgment in the `judgment` field gets some of that back.
- Schema changes are breaking. Adding a field is easy; renaming or removing is not.

**Revisit if:** the schema constraints prove too restrictive for a class of finding the harness needs to surface.

## ADR-004: Pattern A as default, Pattern B reserved

**Decided:** journeys default to Pattern A (single coordinator, multiple contexts). Pattern B (parallel agents per role) is reserved for journeys where cross-device timing is the thing being tested.

**Alternatives:** Pattern B as default, hybrid.

**Rationale:**

- Pattern A is dramatically simpler to author, debug, and dedup.
- Pattern A handles the vast majority of multi-role journeys (any flow where logical sequencing dominates).
- Pattern B has higher coordination overhead and produces multi-source findings that dedup must merge.
- Reserving Pattern B for the cases that need it (genuine simultaneity) keeps the default cheap and clear.

**Trade-off:**

- Pattern A cannot reproduce true cross-device races. Those tests must be flagged for Pattern B explicitly.
- A journey written in A might pass when the same bug would surface under B. Migration is manual.

**Revisit if:** Pattern B becomes much easier to author (better framework support, an LLM-orchestration library that simplifies the scratch-file coordination).

## ADR-005: No auto-issue-creation in v1

**Decided:** v1 emits markdown reports. Humans triage and create GitHub issues when warranted. Auto-issue-creation is deferred to v1.1 or later.

**Alternatives:** auto-create issues for every HIGH severity finding, auto-create on disagreement, custom routing.

**Rationale:**

- Signal-to-noise is unproven. The first month of runs is going to produce some fraction of false positives. Auto-creating issues for false positives erodes the team's trust in the harness fast.
- Triage friction is low. A markdown report with structured findings is easy for a human to skim and act on.
- Once the false-positive rate is measured, the auto-issue threshold can be set intelligently (e.g. "auto-create if HIGH and the finding is unique across models").

**Trade-off:**

- Findings die in `.qa-runs/` if no one reads them.
- The friction is the point: it forces a human to look, which is how false positives get tuned out.

**Revisit if:** after a month of runs, the false-positive rate is under 10% and a clear auto-create policy emerges from the data.

## ADR-006: Shadow staging environment, not production-walking

**Decided:** the harness walks a staging or "shadow" environment, not production. Destructive QA actions (create session, then delete it) do not touch production data.

**Alternatives:** production-walking, ephemeral preview per run.

**Rationale:**

- Destructive actions are normal during QA (clean up after yourself). Production cannot tolerate them.
- Ephemeral preview per run is the ideal but adds significant provisioning overhead (Supabase project create, schema migrate, etc.). Shadow staging is the pragmatic compromise.
- Cost: one extra Supabase or Clerk or D1 project. Free tier usually covers it.

**Trade-off:**

- Staging can drift from production. Bugs that depend on production data shape go undetected.
- Mitigation: occasionally run the harness against production in a read-only mode (no destructive actions) to catch the drift class.

**Revisit if:** ephemeral preview provisioning becomes one command (e.g. Supabase branching, Neon branches becoming standard).

## ADR-007: Reuse host project's Playwright binary

**Decided:** the harness expects `@playwright/test` to be present in the host project's `node_modules/`. The template's `package.json` lists Playwright as a devDependency, but the scaffolder will suggest hoisting to the host project when possible.

**Alternatives:** dedicated Playwright install per harness clone, npx-only invocation.

**Rationale:**

- The Ballpark slice-10 lesson: a fresh `npm install` of Playwright is 19MB of browser binaries per worktree. Multiply by every Claude agent worktree and the disk usage gets ridiculous.
- The host project usually already has Playwright for its own e2e tests. Reusing it avoids duplication.

**Trade-off:**

- Version drift between host and harness. If the host pins Playwright to 1.45 and the harness was written against 1.60, things break.
- Mitigation: the harness's `package.json` specifies `@playwright/test: ^1.60.0` as a peer expectation. The scaffolder checks at setup time.

**Revisit if:** Playwright's binary size shrinks enough that the duplication is not material.

## ADR-008: Markdown reports gitignored by default

**Decided:** `.qa-runs/` is gitignored. Reports are ephemeral.

**Alternatives:** commit reports, commit only the latest, commit a rolling window.

**Rationale:**

- Binary screenshots blow up the repo.
- Diff noise drowns real code diff.
- Run-over-run diff is best done with a dedicated tool reading two report directories, not git.

**Trade-off:**

- Historical bisect is harder. You cannot `git checkout` to a six-month-old report.
- Mitigation: explicit archive policy. If a specific run is worth preserving, copy it to `docs/qa-runs-archive/<date>-<topic>.md`.

**Revisit if:** team decides historical preservation outweighs repo bloat.

## ADR-009: No visual regression (pixel diffing) in v1

**Decided:** axe-core covers accessibility. Pixel-level visual regression is a separate problem and out of scope for v1.

**Alternatives:** Percy, Chromatic, Playwright's built-in `toMatchSnapshot`.

**Rationale:**

- Visual regression at pixel level produces enormous false-positive volume from anti-aliasing, font rendering, animation frames.
- Maintaining a baseline image set is significant ongoing work.
- The bug classes we care about (broken redirects, console errors, contrast, missing strings) are not pixel-level.

**Trade-off:**

- A purely visual bug (badge moved 10px in the wrong direction) goes undetected.
- These are rare and usually caught by humans on next manual walk.

**Revisit if:** a real bug ships that pixel-diffing would have caught and screenshot review by humans did not.

## ADR-010: Hebrew is Ballpark-specific, template is locale-general

**Decided:** the template's stub journeys use English placeholders. The `locale-snapshot` helper is locale-agnostic. Hebrew RTL details belong in `examples/nextjs-supabase/` (Ballpark's worked example) only.

**Alternatives:** keep Hebrew as the default (since the first wet-run validator is Hebrew), make every locale a first-class config.

**Rationale:**

- The template is meant for multiple consuming projects. Hebrew is one project's locale.
- RTL handling is a Tailwind logical-properties concern, not a harness concern. The harness captures rendered text; it does not need to know LTR vs RTL.
- The locale-snapshot helper works the same for any locale; it captures whatever text is on the page.

**Trade-off:**

- The Ballpark example carries the RTL specifics. Future projects with RTL needs reference that example.

**Revisit if:** a non-Latin locale surfaces a harness limitation that requires special handling.

## ADR-011: Hybrid template-repo plus Claude skill

**Decided:** the artifact is both a `gh repo create --template` source and a Claude skill. The skill wraps the template-clone-plus-scaffold workflow.

**Alternatives:** template repo only, Claude skill only, npm package.

**Rationale:**

- `gh repo create --template` is the natural GitHub way to clone a starter. Discoverable, idiomatic.
- The Claude skill makes "set up the QA harness in this project" a one-shot invocation from any Claude Code session, without the user remembering the template URL.
- npm package would only ship the scripts; the journey-spec scaffolding is files-and-structure, not a library.

**Trade-off:**

- Two distribution mechanisms to maintain (template repo plus skill).
- The skill is thin: it shells out to gh and the scaffolder. Low maintenance.

**Revisit if:** GitHub's template feature changes meaningfully, or Claude skills become a different shape.

## ADR-012: OpenRouter is the single dispatch path

**Decided:** all real models (Anthropic, Google, OpenAI, anyone else) dispatch through OpenRouter chat-completions on one HTTP code path. The only key the harness consumes is `OPENROUTER_API_KEY`. Model ids use the provider-prefixed OpenRouter form: `anthropic/claude-sonnet-4-6`, `google/gemini-3.5-flash`, `openai/gpt-5`. The mock provider stays for offline tests.

**Alternatives:** keep the prior Anthropic-direct path alongside OpenRouter (the ADR-002 v1 shape), build a custom provider abstraction per family.

**Rationale:**

- Single key, single billing surface, single auth model. Easier ops, easier scaffold.
- One code path means one set of bugs to fix and one shape to test. The prior two-path layout doubled the maintenance footprint without buying anything the harness uses.
- OpenRouter routes to underlying providers anyway. Going direct to Anthropic only buys lower latency at the cost of an extra dependency, an extra key, and a parallel branch in the dispatcher.

**Trade-off:**

- Dependence on OpenRouter uptime. If OpenRouter is down, the harness is down even for Anthropic models. Accepted because cross-provider dispatch (ADR-002) is the whole point of the harness; if OpenRouter is down we cannot honor that policy anyway.
- Lose access to provider-direct SDK features (Anthropic prompt caching, batch). Reintroduce them only if a real run shows the missing feature would have changed outcomes.

**Supersedes:** the Anthropic-direct portion of ADR-002 v1. The cross-provider second-opinions policy in ADR-002 stays, restated against provider-prefixed ids.

**Revisit if:** OpenRouter materially degrades, or a provider-direct feature (caching, batch) becomes load-bearing for cost or latency.

## ADR-013: axe_violations is nullable

**Decided:** `StepFinding.axe_violations` is now `number | null`. The default in `makeFinding` flips from `0` to `null`. The convention becomes:

- `null`: axe was not run on this step
- `0`: scanned, no violations
- positive integer: scanned, that many violations
- `-1`: scan failed mid-run (axe library threw)

**Alternatives:** keep the `0 vs -1` two-state encoding, introduce a parallel `axe_attempted: boolean` field, move to a richer object shape.

**Rationale:**

- The previous `0 vs -1` encoding could not distinguish "scan not attempted" from "scan ran and clean". Most journey steps do not run axe (it is expensive and only meaningful at page-level boundaries). Conflating "skipped" with "clean" hid which routes actually had axe coverage.
- Per HARNESS-FEEDBACK item 10, this masks coverage gaps in reports: a step that never called `runAxe()` looked identical to one that did and saw no issues.
- A nullable column is the minimal schema widening that preserves all four states.

**Trade-off:**

- Existing findings.json files written before this slice deserialize fine. The number is a valid `number | null` value; older runs render as "0 violations" the same way they always did.
- Consumers must handle null. The dispatcher prompt renderer prints "not scanned", the markdown report prints "not scanned", the mock-c provider uses `(axe_violations ?? 0) > 0` to keep its existing semantics. Any new consumer must add the null branch.
- Schema lock (ADR-003) is widened, not narrowed. No migration step.

**Revisit if:** a future slice moves `axe_violations` into a richer object shape with timestamp, ruleset version, or per-violation severity. The null state would carry over as "absent object".

## ADR-014: Per-model dispatch configs for parse-rate

**Decided:** the dispatcher sends a different request payload per model, picked from a 144-cell empirical run (`.research-parse-rate/`, 2026-05-21). Configs live in `scripts/dispatch/configs.ts` as `MODEL_CONFIGS`, guarded by `tests/unit/dispatch-configs.test.ts`. Shipped in PR #10 (`81a8c25`).

| Model | Variant | Baseline parse-rate | Production parse-rate |
|---|---|---|---|
| `anthropic/claude-sonnet-4-6` | baseline (no `response_format`, no `extra_body`) | 100% | 100% |
| `google/gemini-3.5-flash` | json-schema (cleaned prompt + strict + `provider.require_parameters`) | 75% | 100% |
| `openai/gpt-5` | combined-best (cleaned + strict + `reasoning.effort: minimal`) | 37.5% | 100% |

**Alternatives:** one shared payload shape; aggressive client-side repair of malformed JSON; a single "JSON mode" toggle.

**Rationale:**

- The baseline numbers are not opinion. Phase C of `.research-parse-rate/` ran 6 models by 6 variants by 8 fixture findings = 288 calls and measured parse success directly. Claude was at 100%, Gemini at 75%, GPT-5 at 37.5%. A shared shape costs roughly 60% of GPT-5 calls.
- The fixes are model-specific. Gemini fails on markdown fences and unquoted property names; the json-schema variant with `provider.require_parameters: true` eliminates both. GPT-5 fails on long-form truncation and empty responses; `reasoning.effort: minimal` plus strict schema fixes both without latency loss. Claude already returns clean JSON and breaks under json-schema (OpenRouter's Anthropic backend rejects strict schema with `http 400 "Provider returned error"`).
- Client-side JSON repair was prototyped in `.research-parse-rate/variants/`. It buys back ~5-10 percentage points and loses ground-truth match because the repair sometimes corrupts the payload. Strict input is cheaper than tolerant parsing.

**Trade-off:**

- The dispatcher carries a per-model config table. Adding a new model means adding a row, ideally backed by a fresh run. The cost is a small lookup; the alternative was a fragile shared payload.
- Model deprecation (Claude 4.6 to 4.7, GPT-5 to 6) requires re-running the research. `run.ts` is the reproducer.
- Codifying that Claude must not receive json-schema couples the harness to one OpenRouter backend quirk. If OpenRouter fixes the underlying Anthropic-backend bug, the Claude row can revert to json-schema and gain a small bump in score consistency. See the `Revisit if` clause.

**Revisit if:** OpenRouter changes Anthropic-backend behavior; a target model is replaced by a new version; the finding schema in `docs/PHILOSOPHY.md` materially changes shape. Do not re-run for routine harness changes; the signal from the 144-cell run is durable.

## ADR-015: Target-deployment identity in the report header

**Decided:** The per-run report header now records three distinct identities (Target URL, Target deployment, Harness SHA) instead of one ambiguous `Build:` row. Three coupled changes ship together:

1. Rename `meta.build` to `meta.harness_sha` in the JSON sidecar; rename the `Build:` row in the markdown header to `Harness SHA:`. No backward-compat reader for the legacy name.
2. Capture `x-vercel-id` and `x-vercel-deployment-url` from the main-frame document navigation response into `meta.target_deployment.vercel_id` and `meta.target_deployment.deployment_url`. The capture is filtered by `request.isNavigationRequest()` plus mainFrame plus `resourceType === 'document'` so a subresource (CDN, third-party script, cross-origin Vercel app) cannot mis-attribute the deployment. The field is optional on the type so older artifacts deserialize cleanly; consumers must use `?? null` defensively.
3. Add an optional `/__build` convention. If the target app exposes `GET /__build` returning `{ commit, deployedAt }`, the harness fetches it at report time and surfaces the result as `target_deployment.build_commit` and `target_deployment.deployed_at`. The parser resolves each field independently: a valid `commit` survives a malformed `deployedAt` and vice versa. Absent endpoint, network errors, non-JSON, and timeouts all resolve to both nulls; the harness never fails a QA run on this path.

**Alternatives:** keep `Build:` and document the disambiguation in prose; capture headers but skip `/__build` and rely on header SHA prefixes; fetch `/__build` from a separate post-run script.

**Rationale:**

- The 2026-05-22 Ballpark wet run exposed a concrete failure: a downstream validator chased the `Build:` short SHA into the consuming repo's git history and confidently matched a superficially similar commit. The QA findings were valid; the chronology claim was wrong because the label was misleading and there was zero target-app identity in the report. Two distinct fields are the minimum to make the ambiguity disappear; three (target URL, headers, build endpoint) make findings reproducible against a specific deployment even months later.
- Runtime header capture is the only correct timing. A separate post-run `curl` can race a redeploy and pin the report to the wrong build. The main-frame document response carries the deployment identity unambiguously.
- The schema is locked per AGENTS.md TL;DR #4, but the rename is template-internal: the touch sites for direct writes (`helpers.ts`, `multi-model-dispatch.ts`, `generate-report.ts`) plus the type pass-through (`scripts/types.ts`) all live in this repo, with no external consumers of the JSON. `dedup-findings.ts` carries the field through structurally via `DispatchedRun.meta = DedupedRun.meta` and needed no direct edit. An in-place rename is cheaper than carrying a dual-name reader forever. The ADR records that decision and the absence of a migration step. The dispatcher fails loud when `meta.harness_sha` is missing on input so a stale older artifact cannot silently render as `Harness SHA: undefined`.
- `/__build` is optional on purpose. It requires consumer cooperation (one route file, one env stamp) and the harness must work fine without it. The Next.js handler in `examples/nextjs-supabase/README.md` is the wet-run-validated stack; other-framework examples wait until a real project validates them, per the AGENTS.md examples rule (no example without wet-run validation).

**Trade-off:**

- The rename breaks any external consumer that read `meta.build`. There are none today; the audit confirmed only the three direct-write sites plus the structural pass-through covered the field. A future external consumer would need to migrate, but no migration step ships in this slice.
- `writeReport` becomes async because the `/__build` fetch is awaited inline. The only caller in `tests/e2e/journeys/journeys.spec.ts` already lives in an async `test.afterAll`, so the ripple is one `await`.
- Module-level state in `helpers.ts` holds the captured headers. One harness process equals one report, so the state is fine in production; an exported `__resetTargetDeployment` exists for in-process tests that need a clean slate.

**Revisit if:** Vercel changes the names or semantics of `x-vercel-id` / `x-vercel-deployment-url`; the `/__build` convention attracts enough adoption to deserve a typed contract beyond the loose `{ commit, deployedAt }` shape; a non-Vercel host (Cloudflare, Fly) ships its own deployment identity headers that should be captured alongside the Vercel pair.

## ADR-016: Per-project report aggregation

**Decided:** The default multi-project `npm run test:e2e` run (`chromium-desktop` + `mobile-iphone-13`) now produces one combined report instead of the last project's output silently overwriting the first. Three coupled changes ship together:

1. Move final report generation out of `test.afterAll` in `journeys.spec.ts` and into a Playwright `globalTeardown` (`tests/e2e/global-teardown.ts`) that runs once, after every project finishes. Each project's `afterAll` now calls `writeProjectSidecar`, which stamps `project` onto its `JourneyResult`s and `StepFinding`s and writes them to a per-project JSON sidecar under a gitignored `.qa-runs/<run>/.partials/` directory. The teardown calls `aggregateRunReport`, which reads every sidecar, concatenates results and findings, and writes the combined `findings.json` and `REPORT.md`. A companion `globalSetup` (`tests/e2e/global-setup.ts`) calls `clearRunOutputs` at run start, which removes the run-stage output set from the run dir: the `.partials/` sidecars and the run-stage `findings.json` and `REPORT.md`. This matters when a rerun reuses the run dir (the default timestamp is minute-granular, and `QA_RUN_DIR` can be pinned) and closes two stale-data cases. First, a narrower `test:e2e:desktop` rerun after a full both-projects run would otherwise merge mobile's stale sidecar and resurrect an excluded project. Second, a rerun that produces zero sidecars (a `--grep` matching nothing, or all journeys skipped) makes `globalTeardown` write nothing, so the prior run's `findings.json` / `REPORT.md` would linger and be served as if current (the dispatcher keys on that `findings.json`). The downstream pipeline artifacts (`findings.dispatched.json`, `findings.deduped.json`, `REPORT.final.md`) are left to the dispatch/dedup/report scripts that own those filenames, and screenshots are left in place: orphaned stale screenshots are harmless since a regenerated report only references the current run's paths. The project list for the combined report is the union of every sidecar's declared project plus any project seen in results or axe surfaces, so a project that ran but produced zero results still gets a section. Project names are sanitized to a traversal-safe path segment before use in sidecar filenames and screenshot directories: safe names pass through verbatim, disallowed characters map to a hyphen, and a dot-only or empty result (which would otherwise escape the run directory under `path.join`) is replaced with the placeholder `_`. Project names come from `playwright.config.ts` (author-controlled slugs), so this is a defensive traversal guard, not a collision-avoidance scheme. The final post-dedup report (`generate-report.ts`, `REPORT.final.md`) surfaces `project` on each finding, on each per-journey summary row, and on each axe a11y summary row, so cross-project findings that share a project-agnostic title, and two projects that scanned the same route, stay distinguishable to the reader. Every compound key that combines a free-form field (the dispatcher's `findingKey`, the dedup `stepKey` and `dedupKey`, the report's journey-summary key) is encoded with `JSON.stringify` of the field array rather than a raw `|` join, so a delimiter character inside a project name or step id cannot shift the field boundaries and collide with a different tuple. This changed the `dedup_key` hash values from earlier runs, which is safe: `dedup_key` is an opaque intra-run grouping id, never compared across runs, and grouping behavior for a given input is unchanged.
2. Namespace screenshots by project: `screenshot()` now takes a `project` argument and writes to `screenshots/<project>/<journey>/<step>.png` instead of `screenshots/<journey>/<step>.png`.
3. Add an optional `project` field to `StepFinding` (and, by extension, `DispatchedFinding` and `DedupedFinding`, which extend it) and to `JourneyResult`, and thread `project` through every place that previously identified a finding by `step_id` alone: the `dedup-findings.ts` dedup key becomes `(journey_id, step_id, severity_bucket, project, normalized_title)`, and the two `step_id`-keyed maps a combined run would otherwise collide (the dispatcher's finding map in `multi-model-dispatch.ts` and the dedup cross-severity map) become keyed on `(project, step_id)`.

**Root cause:** Playwright runs each project as a fresh worker process, which means `journeys.spec.ts`'s module-level `journeyResults` and `axeSurfaces` arrays reset per project. `test.afterAll` wrote the shared report paths (`REPORT.md`, `findings.json`) from whichever project ran last, so the other project's findings never reached disk. Screenshots had the identical bug one layer down: `screenshot()` wrote to a project-agnostic path, so both projects' PNGs landed at the same file and the second write clobbered the first. Both bugs were masked by each other before this slice: since the report was also last-writer, nobody noticed that the screenshot a surviving finding pointed at belonged to the wrong project.

**Alternatives:** have each project write to its own subdirectory and leave two separate reports for a human to read side by side; append to the shared JSON from each project's `afterAll` with a file lock; drop back to `workers: 1` across projects and share one module instance (defeats the point of running two projects, and Playwright does not guarantee project execution order without it).

**Rationale:**

- `globalTeardown` is the only Playwright-native hook that is guaranteed to run exactly once, after every project, in the main process rather than a worker. It is the correct place to merge state that workers cannot share directly.
- Per-project sidecars under `.partials/` keep `writeProjectSidecar` a pure, synchronous-feeling file write: no git lookup, no `/__build` fetch, no markdown rendering. Those move to `aggregateRunReport`, which now runs once instead of once per project, so the `/__build` fetch that used to happen twice (wastefully, and with a last-writer-wins result) now happens once against the merged result set.
- Adding `project` to `dedup-findings.ts`'s dedup key is required once aggregation is real: J1-J3's stub titles are project-agnostic by design (`docs/JOURNEY-CATALOG-GUIDE.md` deliberately does not make journey titles project-specific), so two projects reporting the identically-titled step would otherwise collapse into one during dedup and one project's finding would silently vanish, which is the same class of data loss this slice exists to fix, just moved one stage downstream.
- `StepFinding` is the single source of truth per ADR-003; `scripts/types.ts`'s `DispatchedFinding` and `DedupedFinding` extend it, so adding `project` there covers the type propagation for free. It is not the only code touch site, though: two downstream maps that were keyed on `step_id` alone had to become project-qualified, because a combined run now legitimately holds two findings sharing a `step_id`. The dispatcher's finding map (`multi-model-dispatch.ts`) is keyed on `(project, step_id)` so one project's finding no longer overwrites the other's before fan-out, and the dedup cross-severity map (`dedup-findings.ts`) is keyed on `(project, step_id)` so two same-step findings from different projects are not mislabeled as a cross-severity collision.

**Trade-off:**

- This is an additive, widening schema change: `project` is optional on the type and there is no migration step for older `findings.json` artifacts, the same posture as ADR-013's nullable `axe_violations`. A consumer that ignores the field entirely is unaffected. Two consumers did NOT ignore it and were fixed as part of this slice: any consumer that keyed on `step_id` alone (the dispatcher finding map, the dedup cross-severity map) had to move to a `(project, step_id)` key, because the duplicate `step_id`s a combined run now contains would otherwise drop or mislabel one project's findings.
- Single-project runs and multi-model runs (same project, multiple models) are unaffected: `project` is constant across every finding in both cases, so the dedup key tuple and the project-qualified maps, and therefore the grouping, are unchanged from before this field existed. Only findings from genuinely different projects now separate.
- Degradation mode: a project drops out of the combined report if its sidecar is missing (worker crashed before `test.afterAll` wrote one) or unreadable (`aggregateRunReport` parses each sidecar in its own try/catch, writes a stderr note, and skips the corrupt one). Either way, `aggregateRunReport` merges the sidecars it can read and the remaining projects survive. This is per-project, not all-or-nothing: one bad sidecar drops one project, not the whole run. `writeProjectSidecar` writes atomically (temp file plus rename) so a worker killed mid-write leaves the previous sidecar or none, never a truncated one. Both modes are strictly better than the old behavior, where the crashed project silently overwrote or was overwritten by the surviving one with no signal either way.
- `PARTIALS_DIR` and its contents are gitignored the same way the rest of `.qa-runs/` is; no new top-level ignore rule is needed.

**Revisit if:** Playwright changes `globalTeardown` semantics (e.g. running it per-shard instead of per-invocation) in a way that breaks the once-after-all-projects guarantee; a consuming app adds a third project and wants per-project reports as a first-class output rather than sections of one combined report; the dedup key needs a fourth axis (e.g. locale) for the same reason `project` was added here.

## ADR-017: Per-journey sidecar flush (crash-safety)

**Decided:** persistence moves from a single `test.afterAll` flush to a flush after every journey. `journeys.spec.ts` now calls a local `recordJourney` helper at the end of each journey, which appends the `JourneyResult` to the module-level `journeyResults` accumulator and immediately calls `writeProjectSidecar`, rewriting the same per-`(project, workerIndex)` sidecar with the accumulated-so-far snapshot. `writeProjectSidecar`'s shape, `aggregateRunReport`, and the report schema are all unchanged; only the write cadence moved.

**Motivation:** the test-failure worker-restart case was already handled by ADR-016 (`test.afterAll` fires on the dying worker before it restarts, and each worker's `workerIndex` is unique, so the restarted worker's sidecar cannot clobber the dying one's; `aggregateRunReport` unions both). The residual gap this closes is the one ADR-016's degradation section names explicitly: a HARD crash, a browser OOM or a killed process, where `afterAll` never runs at all. Previously that lost the whole worker's accumulated journeys, every one of them, not just the in-flight one. Now only the in-flight journey (the one that had not finished and called `recordJourney` yet) is lost; every journey that completed before the crash is already on disk.

**Alternatives:**

- True per-journey sidecar FILES, one file per journey instead of one file per `(project, workerIndex)` rewritten in place. Rejected: this changes the sidecar shape, the `aggregateRunReport` reader, and every aggregation test, for the same crash-safety guarantee a same-file rewrite already provides. More blast radius for no extra benefit.
- Keep `afterAll`-only persistence. Rejected: this is the status quo, and it is exactly the gap this ADR closes.

**Trade-off:**

- The sidecar is now rewritten once per journey (N atomic writes per worker instead of 1, where N is the journey count for that project). N is small (the template ships four journeys; a real journey catalog is unlikely to run into the hundreds per project), the write is atomic (temp file plus rename, unchanged from ADR-016), and there is no concurrent reader during the run (`aggregateRunReport` only runs in `globalTeardown`, after every worker has finished), so the added write volume is negligible.
- The module-level `journeyResults` accumulator is retained (recordJourney still pushes into it) but is no longer load-bearing for restart-survival. Disk, the unique-`workerIndex` sidecar filenames, and `aggregateRunReport`'s union already provide that; the accumulator now exists mainly so `writeProjectSidecar` always receives the full accumulated-so-far list rather than one journey at a time.
- The per-journey flush also required making the sidecar replacement genuinely atomic. `writeProjectSidecar` now renames the temp file directly over the destination (a POSIX atomic replace) instead of unlinking the destination first, so a crash during a rewrite can never leave the worker's sidecar absent. The old unlink-then-rename left a narrow window with no sidecar on disk; harmless when the flush ran once in afterAll, but now that it runs after every journey a crash in that window would drop every already-flushed journey. Windows, which cannot rename over an existing file, keeps the unlink-then-rename fallback (the window persists there only, and CI plus the harness's target platforms are POSIX).

Note: one behavioral edge. Under the old afterAll flush, a worker that ran but skipped every journey still wrote an empty sidecar, so a fully-skipped project appeared in the combined report as an empty section. With the per-journey flush, a worker that records no journey writes no sidecar, so a fully-skipped project is simply absent. This is unreachable with the shipped stub journeys (every journey, including its early-return branches, calls recordJourney) and is arguably more honest: a project that executed nothing no longer renders as a clean empty section. It surfaces only if a consumer gates an entire Playwright project out at runtime.

**Revisit if:** journey counts per worker grow large enough that full-snapshot rewrites per journey become a measurable cost (switch to append-style per-journey files at that point); or Playwright changes its worker-restart / `afterAll` semantics in a way that changes what ADR-016 already relies on.
