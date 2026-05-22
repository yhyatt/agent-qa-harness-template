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
