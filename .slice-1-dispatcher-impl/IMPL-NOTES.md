# Slice 1 dispatcher implementation notes

## design choices not in the brief

### ADR-002 check ordering

The brief listed validation in the order: mock check, openrouter-missing, anthropic-missing, ADR-002. Per advisor guidance, ADR-002 is checked first (before key checks) so the error message is unambiguous regardless of env state. If keys are missing AND only one family is used, the user should see the ADR-002 message, not a key-not-set message, because the fix is to add a non-Anthropic model.

### mock-* models bypass ADR-002

Mock models are treated as neither Anthropic nor OpenRouter for ADR-002 purposes. A mock-only matrix does not trip ADR-002 because mock models are test scaffolding, not real provider opinions. The `QA_ALLOW_SINGLE_FAMILY=1` override is still required when mixing mock + single real Anthropic family, but mock-only works cleanly.

### mock-b behavior on INFO severity

The brief said "model B fails on INFO severity findings" but did not specify which bucket or severity to assign. Decision: keep the original severity (do not escalate), set `pass: false`, and flip bucket to `cosmetic`. This models the scenario where model B is more conservative than the Playwright agent but does not consider INFO findings blocking.

### screenshot preloading

The brief said to cache screenshots per path. The implementation preloads all screenshots before the fan-out so the cache is warm before tasks start. This avoids concurrent file reads on the same path. Errors from preloading attribute to the first model in the matrix (an arbitrary choice; the error is about the file, not the model).

### stableStringify vs JSON.stringify with replacer

`JSON.stringify(obj, Object.keys(obj).sort(), 2)` only sorts the top-level keys. Deep sorting requires a custom replacer. The implementation uses `sortedReplacer` which recurses through every object level and sorts keys alphabetically. Arrays are preserved in insertion order (no sorting of array elements, which would change semantics for `findings`, `concerns`, etc.).

### dispatch errors in preload attributed to first model

When a screenshot file is missing or too large, the dispatch error is emitted once (during preload), attributed to `models[0]`. The same error is not emitted again per model. This avoids N copies of the same file error for an N-model matrix.

### `import type` enforced

The brief required `import type` for `StepFinding`, `Severity`, and `Bucket` from helpers.ts to avoid pulling in the Playwright-laden module at runtime. All three files use `import type` only. The dispatcher never imports from helpers.ts at runtime; it imports from `./types.js`.

## edge cases found

1. The `@axe-core/playwright` package has broken TypeScript signatures in the version range pinned; this caused two pre-existing errors in `helpers.ts`. These existed before slice 1 and are not caused by this work.

2. `journeys.spec.ts` uses bare relative imports (no `.js` extensions) which fail under `moduleResolution: NodeNext`. Also pre-existing. Not touching either file per "read-only reference" instruction.

3. The `image_url` content part type in the OpenAI SDK is typed via overloaded message types. Using a local `ContentPart` union and a type assertion at the call site avoids pulling in the full SDK type hierarchy.

## fixup round 1 (review-driven)

Five commits from Opus review (2026-05-19), addressed in order:

- **fd8cffc** R1: parseJudgment now throws for invalid severity/bucket enum values; the existing retry path catches and falls back to synthetic INFO/flake judgment. Added `VALID_SEVERITIES` and `VALID_BUCKETS` const arrays at the top of providers.ts.
- **c352479** R2: confidence clamped to [0,1] via `Math.max(0, Math.min(1, ...))` before storing. Previously stored verbatim from model output.
- **a270b94** R3: `loadScreenshot` signature widened to `stepId: string | null`; preload call site passes `null` to match the `DispatchError.step_id: null` contract for matrix-level errors.
- **4dd7152** R4: added comment on the 4MB check noting Anthropic vs OpenRouter limit asymmetry (3.9MB PNG encodes to ~5.2MB base64 data URI).
- **bc3a2be** R5: replaced `model.endsWith('-a')` / `endsWith('-b')` with `model.startsWith('mock-a-')` / `startsWith('mock-b-')` to prevent real model names ending in `-a`/`-b` from routing to mock.

## fixup round 2 (Copilot PR#1 review)

Four commits addressing Copilot inline comments, 2026-05-19:

- **C1**: `parseJudgment` now throws `invalid pass: <value>` when `parsed['pass']` is not strictly boolean. Previously `Boolean("false") === true` silently accepted string truthy values. Same retry-then-synthetic path catches it.
- **C2**: `QA_DISPATCH_CONCURRENCY` validated with `Number()` + `Number.isInteger()` + `> 0`. `parseInt()` was silently producing `NaN`/0/negative which caused semaphores to hang. Now exits early with a clear error naming the variable and the offending value.
- **C3**: Added `resolveRunDir(envValue)` helper. Previously the dispatcher resolved `QA_RUN_DIR` as a repo-root-relative path, conflicting with `helpers.ts` which treats it as a run-id under `.qa-runs/`. Now handles three forms: timestamp run-id (`YYYY-MM-DD-HHmm`) goes under `.qa-runs/`; values containing `/`/`\` or starting with `.`/`/` are treated as paths; bare names go under `.qa-runs/` with a stderr note.
- **C4**: `resolveProvider` now rejects any `mock-*` name that is not one of the canonical `mock-a`, `mock-b`, `mock-c` (or their `mock-X-...` variants). `isMockModel()` was only used as the routing gate, so `mock-openai/gpt-5` silently fell through to the mock provider. The fix adds `isCanonicalMockModel()` inside `resolveProvider`; throws with a clear error listing supported names. `MOCK_DISPATCH=1` still routes any model to mock as an explicit opt-in.

Routing site Copilot flagged for C4: `isMockModel()` at `resolveProvider` line 349 (original), not the MOCK_DISPATCH branch. The R5 fixup (bc3a2be) only tightened internal mock variant branching inside `makeMockProvider`; the outer gate was still `startsWith('mock-')`.

## open concerns for orchestrator

- The `findings.dispatched.json` output file is gitignored. The orchestrator's review subagent will not see it in the diff unless it runs the verification step manually. Recommend the review brief includes `npm run dispatch` with mock flag.
- The OpenRouter provider sends `image_url` with a data URI. Some OpenRouter-proxied models do not support vision. If a non-vision model is in the matrix and a screenshot is present, OpenRouter will return a 400. This bubbles up as a `dispatch_error` (provider-level, caught in the fan-out). No special handling is needed in v1.
- The `ANTHROPIC_API_KEY` check fires before trying to dispatch; if the key is set but invalid, the error surfaces at dispatch time as a provider 5xx, caught into `dispatch_errors` per the non-throwing contract.
