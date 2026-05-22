# Example: Next.js + Supabase (Ballpark)

The full worked example (journeys, adapter, fixtures) lands here once Ballpark's slice-14 (full multi-model dispatch) is wet-run validated. The `/__build` endpoint section below is the exception: it ships ahead of the rest because the harness depends on the convention at report time, so the snippet is canonical even before the broader example arrives.

Reference materials in the interim:

- Ballpark slice-14 plan: `~/projects/ballpark/docs/BACKLOG.md` "Slice 14: Agent-driven QA harness"
- Slice-14-lite (the precursor to this template): `~/projects/ballpark/tests/e2e/journeys/` once merged
- Ballpark adapter draft: see `docs/CUSTOMIZATION.md` "Example 1: Next.js plus Supabase"

Once Ballpark slice-14 ships and the multi-model dispatch is wet-run validated, this directory will contain:

- A concrete `tests/e2e/adapters/next-supabase.ts` extracted from Ballpark
- A worked journey example (one of J1-J8) showing the full pattern with real assertions
- The Hebrew-locale handling that Ballpark needs (RTL Tailwind logical properties note, bidi marks in numerals)
- The shadow Supabase provisioning recipe Ballpark used
- The post-run cleanup pattern (each journey deletes its own session)

## `/__build` endpoint

Optional but recommended. When the target app exposes `GET /__build` returning `{ commit, deployedAt }`, the harness surfaces those values in the report header so a downstream reader can pin findings to a specific deployed commit. See `docs/CUSTOMIZATION.md` for the full convention.

Drop the following file into a Next.js App Router project. The handler reads its identity from the Vercel runtime envs and falls back to safe defaults locally.

```ts
// app/__build/route.ts
import { NextResponse } from 'next/server';

// Vercel exposes these at build time; locally they are undefined and we
// emit a clearly-marked placeholder rather than throwing or 500-ing.
const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? 'local-dev';
// Vercel does not expose the deployment timestamp as an env var; the
// standard trick is to stamp it at build time. NEXT_PUBLIC_BUILD_TIME is
// set in next.config.js via `env: { NEXT_PUBLIC_BUILD_TIME: new Date().toISOString() }`.
const deployedAt = process.env.NEXT_PUBLIC_BUILD_TIME ?? new Date(0).toISOString();

export const dynamic = 'force-static';

export function GET(): Response {
  return NextResponse.json({ commit, deployedAt });
}
```

In `next.config.js`:

```js
module.exports = {
  env: {
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
};
```

The endpoint is cheap (force-static), exposes no secrets (commit SHAs are already in the response headers Vercel sets), and is safe to keep enabled in production.
