# agent-qa-harness-template

Reusable scaffolding for an agent-driven, multi-model QA harness over a web app. Hybrid template repo plus Claude skill: clone via `gh repo create --template`, then run the scaffolder against a specific stack.

This template is the portable shell. The first wet-run validator is Ballpark (`~/projects/ballpark`), whose slice 14 will be the first concrete instantiation. Other projects pick this up afterwards.

## What this is, in one paragraph

A Playwright journey harness with a multi-model dispatch layer on top. Each user journey is one `test()` block. Every step captures: screenshot, console errors, network 4xx/5xx, axe-core a11y, locale text snapshot, DB state where the app exposes it. Findings are emitted as structured JSON per step. A dispatcher fans out journeys across model tiers (Haiku parallel, Sonnet standard, Opus hard, plus at least one OpenRouter cross-provider model) and a dedup layer collapses agreeing findings while surfacing disagreements as tuning signals. Markdown reports land in a gitignored `.qa-runs/` directory.

The static counterpart is `dishonest-code-audit` (looks at code on disk). This is the dynamic counterpart (walks the running app).

## When to use it

- Web app with a non-trivial multi-step user flow
- More than one user role (host plus player, admin plus end-user, buyer plus seller)
- Critical paths whose failure modes are visual or timing-dependent (toast wording, phase transitions, race conditions)
- Project past the toy stage, where manual smoke testing is starting to miss regressions

Skip it if: single-user app with trivial journeys, pure backend service with no UI, project under ~1K lines where manual smoke is cheaper than the infra.

## 60-second quick start

Three consumption patterns are supported in v1. See `docs/CONSUMPTION-PATTERNS.md` for the decision tree. The quick start below uses pattern A (sibling repo via `gh repo create --template`).

```bash
# 1. Create a new repo from this template (one of the two paths)
gh repo create my-app-qa --template yhyatt/agent-qa-harness-template --private --clone
cd my-app-qa

# 2. Run the interactive scaffolder
./scripts/scaffold.sh
# answers framework? next | sveltekit | astro | nuxt
# answers auth?      supabase | clerk | auth0
# answers db?        postgres | d1 | mongo
# answers host?      vercel | cloudflare
# writes adapter files in place
#
# First-class adapters ship for: next-supabase, next-clerk.
# Other combos write a stub adapter; fill it in per docs/CUSTOMIZATION.md.

# 3. Install Playwright (reuse the host project's binary if you wire this as a sibling)
npm install

# 4. Capture host auth fixture (one-time, headed browser)
npm run populate-auth

# 5. Run the static journey (no auth needed) against the target URL
TEST_TARGET_URL=https://your-app.vercel.app npm run test:e2e -- --grep "J4"
```

A markdown report and screenshots land in `.qa-runs/<timestamp>/`.

## Repo layout

```
.
├── README.md                  this file
├── AGENTS.md                  binding rules for any Claude touching this repo
├── HANDOFF.md                 next-session pickup notes (bootstrap state)
├── docs/                      design, philosophy, decisions, cost model
├── tests/e2e/journeys/        journey catalog (stub J1 through J4)
├── tests/e2e/fixtures/        storageState fixtures (gitignored)
├── scripts/                   multi-model dispatch, dedup, report, scaffolder
├── .claude/skills/            Claude skill wrapper for one-shot setup
├── examples/                  worked examples per stack
└── .github/workflows/         CI: run the no-auth journey on every PR
```

## Doc map (read in this order)

0. `docs/CONSUMPTION-PATTERNS.md` - decision tree for which of the three supported consumption patterns to use (sibling repo, local clone, fork). Start here if you are not sure which setup path to take.
1. `docs/PHILOSOPHY.md` - why each pattern exists. The rationale, framed against real Ballpark bugs that the harness would have caught earlier.
2. `docs/PATTERN-A-VS-B.md` - coordination decision tree. When a single coordinator agent driving multiple browser contexts is enough, when you need a separate agent per role.
3. `docs/ANTI-PATTERNS.md` - common failure modes. Mostly about treating Playwright contexts wrong and writing flaky journey assertions.
4. `docs/COST-MODEL.md` - model-tier dollar estimates per run, scaling decisions (more journeys vs more models).
5. `docs/CUSTOMIZATION.md` - per-stack adapter guide. Concrete patches for Next.js plus Supabase, Next.js plus Clerk.
6. `docs/DECISIONS.md` - ADR-style log. Why Playwright, why mixed Anthropic plus OpenRouter, what is deliberately out of scope for v1.
7. `docs/JOURNEY-CATALOG-GUIDE.md` - how to enumerate journeys for a new app. Critical path first, state transitions second, recovery flows third.

## License

MIT.
