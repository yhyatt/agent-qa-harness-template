---
name: agent-qa-harness
description: Scaffold a multi-model agent QA harness into a new or existing project. Clones the agent-qa-harness-template repo via gh, then runs the interactive scaffolder to adapt it to the consuming project's framework, auth provider, database, and host. Use when starting QA coverage on a web app with non-trivial multi-step user flows, especially multi-role apps. Skip for backend-only services, single-user trivial apps, or projects under ~1K LOC.
metadata:
  type: skill
  version: 0.1.0
---

# agent-qa-harness skill

This skill bootstraps a Playwright journey harness with multi-model dispatch into a new sibling repo. It is intentionally narrow: it handles the one-time clone-and-scaffold step. Day-to-day journey authoring, multi-model dispatch tuning, and report consumption are normal Claude Code workflows in the consuming repo.

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

1. Asks the user for the target directory (defaults to a sibling of the current project)
2. Runs `gh repo create <name> --template yhyatt/agent-qa-harness-template --private --clone <dir>`
3. `cd`s into the new repo
4. Runs `./scripts/scaffold.sh` interactively, which asks:
   - Framework (Next.js, SvelteKit, Astro, Nuxt)
   - Auth provider (Supabase, Clerk, Auth0)
   - Database (Postgres, D1, Mongo)
   - Host (Vercel, Cloudflare Workers)
   - Primary locale (ISO code, default `en-US`)
   - Target app URL (used as default `TEST_TARGET_URL`)
5. Substitutes adapter files based on the answers
6. Prints the next-step checklist:
   - `npm install`
   - `npm run populate-auth` (one-time, headed browser)
   - `TEST_TARGET_URL=... npm run test:e2e -- --grep "J4"`
7. Stops there. Does not start running journeys. The user authors them.

## What this skill does not do

- Does not author journey specs. The stub `tests/e2e/journeys/journeys.spec.ts` has TODO placeholders for J1 through J4; the user fills them in based on their app.
- Does not provision shadow Supabase or Clerk projects. The user creates those out-of-band; the scaffolder produces config that references them.
- Does not run the harness. First invocation is a manual `npm run test:e2e` so the user sees what happens.
- Does not configure CI beyond the stub `.github/workflows/ci.yml`. The user wires it into their secrets.

## Pre-conditions

- `gh` CLI authenticated to GitHub
- `git` configured
- `npm` available (the template uses Node.js)
- A target project directory (the new repo is a sibling, not nested inside the target)

## Failure modes

- **`gh repo create` errors with "repo already exists":** ask the user for a different name or to delete the existing repo.
- **`scaffold.sh` errors on unknown framework:** the script supports Next.js, SvelteKit, Astro, Nuxt today. If the user has another framework, write the adapter manually following `docs/CUSTOMIZATION.md`.
- **Template repo not yet public:** during early bootstrapping, the template repo may be private. Set `--template` to a fork the user has access to.

## Skill invocation flow (what the agent should do step by step)

```
1. Confirm the target dir with the user. Default: ~/projects/<their-project>-qa or a sibling next to the current cwd.
2. Confirm the new repo name with the user. Default: <their-project>-qa.
3. Run: gh repo create <name> --template yhyatt/agent-qa-harness-template --private --clone <dir>
4. cd <dir>
5. Run: ./scripts/scaffold.sh
6. Print the next-step checklist verbatim.
7. Ask the user if they want to start authoring J1 now. If yes, open tests/e2e/journeys/journeys.spec.ts and walk them through the J1 TODO comments.
```

## Notes for the agent invoking this skill

- The scaffolder is interactive. It will prompt; do not try to pipe answers through unless the user has explicitly given them.
- Do not commit the scaffolder's output automatically. The user should review the adapter substitutions before the first commit.
- The `tests/e2e/fixtures/` directory is gitignored. Do not check in any `*.json` from it.
- Read `docs/PHILOSOPHY.md` and `docs/JOURNEY-CATALOG-GUIDE.md` before helping the user author journeys; the choices documented there are load-bearing.

## Related skills

- `dishonest-code-audit`: the static counterpart. Walks the source on disk for lying or stubbed code. Pair with this skill for full coverage.
- `vercel:deploy`: for getting the consuming app to a staging URL the harness can target.
