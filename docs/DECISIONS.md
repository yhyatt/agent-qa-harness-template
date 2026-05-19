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

## ADR-002: Mixed Anthropic plus OpenRouter dispatch

**Decided:** dispatch journeys across at least one Anthropic tier (Sonnet baseline) plus at least one OpenRouter cross-provider model.

**Alternatives:** Anthropic-only, OpenRouter-only, custom multi-provider integration.

**Rationale:**

- Provider-family blind spots are real. Anthropic models share training data; a copy mistake that Sonnet generated does not get flagged by Sonnet on review. The same applies in the other direction: a Gemini-generated mistake passes Gemini's review.
- OpenRouter abstracts the provider integration. One API key, one HTTP endpoint, dynamic model routing. Building a custom multi-provider layer is engineering debt that buys nothing.
- Anthropic direct (not via OpenRouter) for Anthropic models because the direct integration is more reliable, has lower latency, and supports more SDK features (caching, batch).

**Trade-off:**

- Two API keys to manage instead of one.
- OpenRouter adds a small markup vs going direct to each provider.
- If OpenRouter has an outage, the cross-provider dispatch path is down even when individual providers are fine.

**Revisit if:** OpenRouter ever degrades materially or a provider we use heavily (Gemini, GPT) becomes worth direct integration.

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
