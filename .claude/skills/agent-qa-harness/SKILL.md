---
name: agent-qa-harness
description: Scaffold a multi-model agent QA harness into a new or existing project. Supports four consumption patterns (sibling repo, local clone, fork, in-repo subdirectory). Asks the user which pattern before proceeding. Use when starting QA coverage on a web app with non-trivial multi-step user flows, especially multi-role apps. Skip for backend-only services, single-user trivial apps, or projects under ~1K LOC.
metadata:
  type: skill
  version: 0.2.0
---

# agent-qa-harness skill

This skill bootstraps a Playwright journey harness with multi-model dispatch. It handles the one-time setup step for any of the four supported consumption patterns. Day-to-day journey authoring, multi-model dispatch tuning, and report consumption are normal Claude Code workflows in the consuming repo.

## When to invoke

Invoke when the user says any of:

- "set up the QA harness in this project"
- "add agent-driven testing"
- "bootstrap the journey test scaffold"
- "create a new repo from the QA harness template"
- "I want the multi-model dispatch test setup"

Do not invoke for:

- Adding individual unit tests
- Setting up Playwright without the journey-harness pattern (use Playwright's own init)
- Pure backend service testing

## What this skill does

1. Asks the user which consumption pattern they want (see below and `docs/CONSUMPTION-PATTERNS.md`)
2. Proceeds down the selected branch (A, B, C, or D)
3. Runs `./scripts/scaffold.sh` interactively, which asks:
   - Framework (Next.js, SvelteKit, Astro, Nuxt)
   - Auth provider (Supabase, Clerk, Auth0)
   - Database (Postgres, D1, Mongo)
   - Host (Vercel, Cloudflare Workers)
   - Primary locale (ISO code, default `en-US`)
   - Target app URL (used as default `TEST_TARGET_URL`)
4. Substitutes adapter files based on the answers
5. Prints the next-step checklist tailored to the chosen pattern:
   - `npm install`
   - `npm run populate-auth` (one-time, headed browser)
   - `TEST_TARGET_URL=... npm run test:e2e -- --grep "J4"`
6. Stops there. Does not start running journeys. The user authors them.

## What this skill does not do

- Does not author journey specs. The stub `tests/e2e/journeys/journeys.spec.ts` has TODO placeholders for J1 through J4; the user fills them in based on their app.
- Does not provision shadow Supabase or Clerk projects. The user creates those out-of-band; the scaffolder produces config that references them.
- Does not run the harness. First invocation is a manual `npm run test:e2e` so the user sees what happens.
- Does not configure CI beyond the stub `.github/workflows/ci.yml`. The user wires it into their secrets.

## Pre-conditions

All patterns:
- `git` configured
- `npm` available (the template uses Node.js)

Pattern A and C only:
- `gh` CLI authenticated to GitHub

Pattern A only:
- A target directory chosen for the sibling repo (not nested inside the tested app)

Pattern D only:
- The tested app does NOT already have a `tests/e2e/` directory at its root. If it does, use pattern A or B instead.

## Failure modes

- **`gh repo create` errors with "repo already exists":** ask the user for a different name or to delete the existing repo. Applies to patterns A and C.
- **`scaffold.sh` errors on unknown framework:** the script supports Next.js, SvelteKit, Astro, Nuxt today. If the user has another framework, write the adapter manually following `docs/CUSTOMIZATION.md`.
- **Template repo not yet public:** during early bootstrapping, the template repo may be private. Set `--template` to a fork the user has access to. For patterns B and D, use `git clone` with credentials or a local path instead.
- **Pattern D: `tests/e2e/` already exists in the tested app:** do not overwrite it. Ask the user whether to abort (and use pattern A or B) or place the harness under a different subdirectory name.
- **Pattern C: merge conflict on upstream pull:** conflicts most likely in `playwright.config.ts` and `scripts/scaffold.sh`. The adapter files under `tests/e2e/adapters/` are generated locally by the scaffolder and do not exist in the upstream template, so they will not conflict.

## Skill invocation flow (what the agent should do step by step)

### Step 1: Ask the user which pattern they want

Before doing anything else, ask:

```
Use AskUserQuestion with the following question and choices:

Question:
"Four consumption patterns are supported. Which fits your situation?

  A. Sibling repo via gh repo create --template (default, separate GitHub repo, own CI)
  B. Local clone, no GitHub remote (exploration or one-off, no CI)
  C. Fork via GitHub UI (separate GitHub repo, can pull upstream harness improvements later)
  D. In-repo subdirectory (harness lives inside the tested app's repo, one git history)

See docs/CONSUMPTION-PATTERNS.md for the full decision tree. Which do you want? (A/B/C/D)"

Choices: ["A", "B", "C", "D"]
```

Make the decision visible before proceeding. If the user says anything other than A/B/C/D, ask again.

### Step 2A: Pattern A (sibling repo)

```
1. Confirm the new repo name with the user. Default: <their-project>-qa.
2. Confirm the target dir. Default: ~/projects/<their-project>-qa.
3. Run: gh repo create <name> --template yhyatt/agent-qa-harness-template --private --clone <dir>
4. cd <dir>
5. Run: ./scripts/scaffold.sh
6. Print checklist:
   - npm install
   - npm run populate-auth  (one-time, headed browser)
   - TEST_TARGET_URL=https://your-app.vercel.app npm run test:e2e -- --grep "J4"
7. Ask the user if they want to start authoring J1 now.
```

### Step 2B: Pattern B (local clone, no remote)

```
1. Confirm the target dir. Default: ~/projects/<their-project>-qa-scratch.
2. Run:
   git clone https://github.com/yhyatt/agent-qa-harness-template <dir>
   cd <dir>
   rm -rf .git
   git init
   git add .
   git commit -m "init from agent-qa-harness-template"
3. Run: ./scripts/scaffold.sh
4. Print checklist:
   - npm install
   - npm run populate-auth
   - TEST_TARGET_URL=https://your-app.vercel.app npm run test:e2e -- --grep "J4"
5. Remind the user: no CI, no remote, findings are local only.
6. Ask if they want to start authoring J1 now.
```

### Step 2C: Pattern C (fork)

```
1. Instruct the user to fork via GitHub UI:
   https://github.com/yhyatt/agent-qa-harness-template -> Fork button
   Wait for user to confirm they have forked.
2. Confirm the fork repo name (usually the same as the template).
3. Run: gh repo clone <their-username>/agent-qa-harness-template <dir>
4. cd <dir>
5. Run: git remote add upstream https://github.com/yhyatt/agent-qa-harness-template.git
6. Run: ./scripts/scaffold.sh
7. Print checklist:
   - npm install
   - npm run populate-auth
   - TEST_TARGET_URL=https://your-app.vercel.app npm run test:e2e -- --grep "J4"
   - To pull upstream harness improvements later: git fetch upstream && git merge upstream/master
8. Ask if they want to start authoring J1 now.
```

### Step 2D: Pattern D (in-repo subdirectory)

```
1. Check whether the tested app already has tests/e2e/ at its root.
   If it does: warn the user and suggest pattern A or B. Do not proceed with D unless they confirm a different subdir name.
2. Confirm the subdirectory name. Default: qa/
3. Run:
   git clone --depth 1 https://github.com/yhyatt/agent-qa-harness-template /tmp/qa-template
   cd <tested-repo-root>
   mkdir -p <subdir>
   cp -r /tmp/qa-template/scripts <subdir>/
   cp -r /tmp/qa-template/tests <subdir>/
   cp -r /tmp/qa-template/docs <subdir>/
   cp /tmp/qa-template/playwright.config.ts <subdir>/
   cp /tmp/qa-template/tsconfig.json <subdir>/tsconfig.qa.json
   rm -rf /tmp/qa-template
4. Remind the user to merge harness dev deps into the tested app's package.json.
   Key deps: @playwright/test, @axe-core/playwright, @anthropic-ai/sdk, zod.
5. cd <subdir>
6. Run: ./scripts/scaffold.sh
7. Print checklist:
   - npm install (in the tested app root, after merging deps)
   - npm run populate-auth
   - TEST_TARGET_URL=https://your-app.vercel.app npm run test:e2e -- --grep "J4"
8. Ask if they want to start authoring J1 now.
```

## Notes for the agent invoking this skill

- Ask the user which consumption pattern before doing anything else. All four patterns end up with a scaffolded harness; the difference is where it lives and whether it has a GitHub remote.
- The scaffolder is interactive. It will prompt; do not try to pipe answers through unless the user has explicitly given them.
- Do not commit the scaffolder's output automatically. The user should review the adapter substitutions before the first commit.
- The `tests/e2e/fixtures/` directory is gitignored. Do not check in any `*.json` from it.
- Read `docs/PHILOSOPHY.md` and `docs/JOURNEY-CATALOG-GUIDE.md` before helping the user author journeys; the choices documented there are load-bearing.
- For the full decision tree and tradeoffs, see `docs/CONSUMPTION-PATTERNS.md`.

## Related skills

- `dishonest-code-audit`: the static counterpart. Walks the source on disk for lying or stubbed code. Pair with this skill for full coverage.
- `vercel:deploy`: for getting the consuming app to a staging URL the harness can target.
