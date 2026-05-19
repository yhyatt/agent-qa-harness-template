# Example: Next.js + Supabase (Ballpark)

TODO: link here once Ballpark's slice-14 (full multi-model dispatch) is live.

Reference materials in the interim:

- Ballpark slice-14 plan: `~/projects/ballpark/docs/BACKLOG.md` "Slice 14: Agent-driven QA harness"
- Slice-14-lite (the precursor to this template): `~/projects/ballpark/tests/e2e/journeys/` once merged
- Ballpark adapter draft: see `docs/CUSTOMIZATION.md` "Example 1: Next.js plus Supabase"

Once Ballpark slice-14 ships and the multi-model dispatch is wet-run validated, this directory will contain:

- A concrete `tests/e2e/adapters/nextjs-supabase.ts` extracted from Ballpark
- A worked journey example (one of J1-J8) showing the full pattern with real assertions
- The Hebrew-locale handling that Ballpark needs (RTL Tailwind logical properties note, bidi marks in numerals)
- The shadow Supabase provisioning recipe Ballpark used
- The post-run cleanup pattern (each journey deletes its own session)
