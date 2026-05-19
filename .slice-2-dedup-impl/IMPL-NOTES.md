# Slice 2 implementation notes

## Branch

`slice-2-dedup` branched from `origin/slice-1-dispatcher` (bc3a2be).

## Files changed

- `scripts/types.ts` - appended `DedupedFinding` and `DedupedRun` interfaces.
- `scripts/dedup-findings.ts` - replaced stub with full implementation.

## Design choices

### findLatestRunDir: R-nit-2 fix

S1's `findLatestRunDir` did no filtering on directory entries; any stray file/dir under
`.qa-runs/` could become "latest". The copy in dedup adds a regex filter `^\d{4}-\d{2}-\d{2}-\d{4}$`
before sorting. S1 was not modified (scope discipline).

### stats.warning: meta.models.length === 1

The spec ties "single-model run" to the `n === 1` per-finding case but that is ambiguous when
3 models were configured and 2 errored. The clean signal is `meta.models.length === 1`: the
dispatch was configured with a single model. Interpreted "single-model run" as a config-level
signal, not a per-finding n=1 signal. Errored-out models show up in `dispatch_errors` and in
zero `total_count` per finding, which is already surfaced.

### n === 0 edge

All models errored on a step. Not interesting but not dropped. Goes to `unanimous_findings`
with `notes` appended: `'all model judgments errored'`. Spread from input, no mutation.

### Cross-severity detection

For v1 inputs, `step_id` is unique per finding in `findings.json`, so the step-key map
always has one dedup_key per step. The path is implemented and tested; it just never triggers.
Comment in code explains that we key on input severity, not model-adjusted severity.

### per_model_finding_counts: seeded from meta.models

All models in `meta.models` appear in the counts, even if they contributed zero `pass=false`
judgments. Models that appeared in judgments but not in `meta.models` (edge case) are also
included for completeness.

### Agreement rate rounding

Rounded to 4 decimal places via `Math.round(x * 10000) / 10000` before writing. Prevents
float representation divergence across runs.

### JSON determinism

Uses the same `stableStringify`/`sortedReplacer` pattern from S1 (not imported to avoid
coupling). Byte-identical output confirmed by diff across two successive runs.

## Green gate results

```
npx tsc --noEmit scripts/dedup-findings.ts scripts/types.ts
# TypeScript: No errors found

QA_RUN_DIR=tests/fixtures/dispatch-input QA_MODELS=mock-a,mock-b,mock-c npm run dispatch
# Dispatch complete: 5 findings, 0 errors.

QA_RUN_DIR=tests/fixtures/dispatch-input npm run dedup
# dedup: 5 findings into 3 unanimous, 2 partial, 0 disagreement; agreement 86.67%

# Byte-identical check: diff returned empty (files identical).
```

## Manual disagreement test

Edited `findings.dispatched.json` to set J1/04: mock-c errored, mock-a=false, mock-b=true.
With N=2, failCount=1, the finding went to `disagreements` (not partial, since partial requires N>=3).
J4/01 and J4/02 remained in `partial_findings` (N=3, failCount=1).
Reverted by re-running dispatch.

## PR #2 fixup notes (slice-2-dedup)

### C1: per_model_finding_counts renamed to per_model_fail_counts

Renamed in types.ts, both callsites in dedup-findings.ts, and the
generate-report.ts spec comment (template string only; the stub has no real code).

### C2: cross-severity comment aligned with v1 implementation

The old comment promised cross-severity divergence across model_judgments[*].severity
was surfaced. The impl only uses the input finding's severity for the dedup key.
Updated comment to say exactly what v1 does and explain where v2 would extend.

### C3: resolveRunDir helper

Replaced the inline two-branch check with a resolveRunDir() helper. Four-case behavior:
1. Undefined/empty -> findLatestRunDir()
2. YYYY-MM-DD-HHmm exactly -> .qa-runs/<run-id>
3. Contains / or \, starts with . or / -> treat as path
4. Otherwise -> .qa-runs/<value> with stderr note

The fixture path `tests/fixtures/dispatch-input` falls in case 3 (contains /); behavior
is identical to the old inline check for all current callers.

### C4: group duplicate dedup keys before classification

groupMap collects findings by dedup_key in input order. model_judgments are merged
with alphabetical iteration (last-write wins on collision). fail_count and total_count
are summed. The first finding's metadata fields are used.

For v1 fixtures, step_id is unique per finding, so every group has size 1 and the
output is byte-identical to pre-C4. after_dedup now reports groupOrder.length (the
post-merge count) instead of findings.length.

### C5: errored_findings separate array

Moved the n===0 case from unanimous_findings to errored_findings. Preserves the
"surface, don't drop" principle from the S2 Opus review while addressing the Codex
point that there is no consensus when all dispatches errored.

after_dedup = U + P + D only (does not include errored). errored_finding_count added
to stats. Empty-run path initialized consistently.

For v1 fixtures no finding is errored so errored_findings: [] in the output JSON.

## Open concerns

None. All green gate checks pass.
