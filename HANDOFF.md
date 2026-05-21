# Handoff

Next-session pickup notes for the agent (or human) continuing work on this template. Read this first.

## What is done

The structural shell is complete and ready for a fresh Claude Code session to extend.

### Full content (no further work needed unless you disagree with a design choice)

- `README.md` - entry point with quick start, repo layout, doc map
- `AGENTS.md` - binding rules for any Claude in this repo (mirrors Ballpark's structure)
- `docs/PHILOSOPHY.md` - why the patterns exist, framed against real Ballpark audit findings
- `docs/PATTERN-A-VS-B.md` - coordination decision tree with worked examples
- `docs/ANTI-PATTERNS.md` - 13 concrete failure modes and what to do instead
- `docs/COST-MODEL.md` - model-tier dollar estimates, scaling guidance
- `docs/CUSTOMIZATION.md` - per-stack adapter recipes (Next+Supabase, Next+Clerk; framework + DB + host substitutions)
- `docs/DECISIONS.md` - 11 ADR entries covering Playwright, multi-model, JSON schema, Pattern A default, no-auto-issues, shadow staging, etc.
- `docs/JOURNEY-CATALOG-GUIDE.md` - how to enumerate journeys, ID scheme, sizing guidance
- `.claude/skills/agent-qa-harness/SKILL.md` - the Claude skill wrapper
- `tests/e2e/journeys/helpers.ts` - capture utilities generalized from Ballpark W3, with the full per-step JSON schema
- `tests/e2e/journeys/locale-snapshot.ts` - locale-agnostic visible-text snapshot (replaces W3's Hebrew-specific version)
- `tests/e2e/journeys/journeys.spec.ts` - J1-J4 stubs with rich TODO comments showing the exact pattern (`makeFinding`, `screenshot`, `attachListeners`, `runAxe`, `captureLocaleSnapshot`, status propagation via expect)
- `tests/e2e/journeys/README.md` - how to run, how to add a journey, journey table
- `tests/e2e/fixtures/README.md` - auth fixture capture and lifetime
- `LICENSE` - MIT
- `.gitignore` - comprehensive (covers `.qa-runs/`, fixtures, env files, common build outputs)

### Stubs with thorough TODO commentary (next-session priority work in order)

1. **`scripts/multi-model-dispatch.ts`** - complete spec in the comment block. Implementation dispatches all real models through OpenRouter chat-completions on a single fetch path. Models use provider-prefixed ids (e.g. `anthropic/claude-sonnet-4-6`). Spec is ready; code is not. Estimated: half a day for a working v1.

2. **`scripts/dedup-findings.ts`** - full spec in the comment. The hash function is sketched. Edge cases the spec calls out: partial agreement (N-1 of N models flag), normalized title collisions across severity buckets. Estimated: 2-3 hours.

3. **`scripts/generate-report.ts`** - report template is in the comment. Renders `findings.deduped.json` into a markdown grouped by status then severity. Estimated: 2 hours.

4. **`scripts/scaffold.sh`** - interactive scaffolder. Currently prints "not implemented yet" and exits. The spec for the substitutions lives in `docs/CUSTOMIZATION.md`. Implementation tactic: prefer generating new adapter files over sed-substituting template files. Estimated: half a day.

5. **`scripts/populate-auth.ts`** - works in skeleton form (merges the W3 codegen recipe with the orchestrator's headed-script). Provider-specific tweaks (Clerk Captcha bypass, Supabase OAuth callback detection) are deferred to the adapter layer.

### Stub (intentionally near-empty)

- `examples/nextjs-supabase/README.md` - placeholder pointing at Ballpark slice-14 once it lands

### Config

- `playwright.config.ts` - adapted from W3, parametrized `TEST_TARGET_URL`, default locale `en-US` with scaffolder comment
- `vitest.config.ts` - minimal, excludes `tests/e2e/**`
- `package.json` - Playwright + axe-core + tsx + typescript + vitest, scripts wired
- `tsconfig.json` - strict, ES2022, NodeNext
- `.github/workflows/ci.yml` - runs typecheck plus J4 on every PR, uploads `.qa-runs/` artifact

## Open design questions (deliberately not resolved)

1. **OpenRouter model selection.** The cost model lists Gemini 2.5 Pro and GPT-5 as candidates. Which two (or three) should be the default working set? Decision deferred to first Ballpark dispatch run; pick based on which models surface findings the Anthropic tier misses. `DECISIONS.md` ADR-002 sets the policy ("at least one non-Anthropic") but not the specific models.

2. **Auto-issue creation threshold.** `DECISIONS.md` ADR-005 defers this to v1.1. Open question: what threshold (HIGH-only? unanimous-only? two-models-agree?) makes sense once signal-to-noise is measured. Cannot decide without real run data.

3. **Should the dispatcher be in-repo or a separate package?** Today the template ships dispatcher stubs. If those stubs grow large enough to be a real library, splitting them out to a separate npm package (`@yhyatt/agent-qa-dispatch` or similar) starts to make sense. Defer until v1 implementation lands and we know the actual size.

4. **CI invocation pattern.** The current `.github/workflows/ci.yml` runs only J4 (no auth needed). The auth-gated journeys need a way to consume a CI-friendly auth fixture (likely a long-lived `storageState` in encrypted form). Implementation pattern: `secrets.QA_AUTH_FIXTURE` as base64-encoded JSON, decoded at job start, written to `tests/e2e/fixtures/host-auth.json`. Not yet wired.

5. **Sharing journey IDs across forks.** If two consuming projects diverge their journey catalogs, can they share findings analysis? Probably not directly; the journey IDs are repo-local. Open question whether the dedup tooling needs to track repo origin.

6. **WebKit and Firefox.** The Playwright config only includes Chromium and iPhone-13 (which is also WebKit-Mobile under the hood). Should the default include Firefox? Chromium bugs occasionally do not surface on Firefox and vice versa. Cost: roughly doubles the run time. Deferred decision.

## Suggested priority order for the next session

1. **Wire scaffold.sh** for at least the Next.js + Supabase path. This unblocks Ballpark's adoption of the template (which is currently still in slice-14-lite shape).
2. **Implement multi-model-dispatch.ts** with Sonnet baseline plus one OpenRouter model. The dedup and report scripts can wait until this produces real outputs.
3. **Implement dedup-findings.ts** once dispatch produces multi-model outputs.
4. **Implement generate-report.ts** last; the rendering layer is the cheapest of the three and benefits from seeing real deduped output first.
5. **Wire CI auth fixture handling** once the harness has caught at least one bug in Ballpark.

## What was deliberately deferred

- A full multi-model dispatch implementation. The spec is documented; the code is slice-14-proper work in Ballpark, not template-bootstrap work.
- Provider-specific adapters beyond Next+Supabase and Next+Clerk sketches in `CUSTOMIZATION.md`. Add adapters when a real consuming project demands them.
- The CI workflow for full multi-model dispatch (separate from the per-PR J4 workflow). Wait until the dispatch script exists.
- An npm-publish step. The artifact today is a template repo, not a package. If the dispatcher graduates to a package, add publishing then.

## Style enforcement reminders

- No em-dashes anywhere in shipped strings. Allowed in code comments and markdown prose (hyphens, periods, colons, parentheses instead).
- No emojis unless Yonatan adds them later.
- Lowercase in body prose. Markdown headers can be Title Case.
- Project-agnostic everywhere except `examples/nextjs-supabase/`. Hebrew is Ballpark-only.

## Initial git state

One commit on `main`:

```
scaffold: agent-qa-harness-template initial structure
```

No remote configured. Yonatan creates the GitHub repo himself with `gh repo create yhyatt/agent-qa-harness-template --public --source=. --remote=origin --push`.

## Where this repo lives

`~/projects/agent-qa-harness-template/` - sibling to all other Yonatan projects. Outside the Ballpark project directory.
