# Anti-patterns

Concrete failure modes encountered while building and using this harness. Each entry: what people do, why it fails, what to do instead.

## 1. Sharing auth fixtures across journey roles

**Anti-pattern:** save one `storageState` file and load it in every context, including the player contexts.

**Why it fails:** the player contexts now share the host's session cookies. The "player joining a session" journey actually tests "host joining their own session as a guest," which is a different flow with different code paths. The bug class you wanted to catch (anonymous join failing because of a missing role check) is invisible because the player is not anonymous.

**Do instead:** one fixture per role. `host-auth.json`, `playerA-auth.json` (anonymous, optional), and never reuse them across roles. Player contexts should default to fresh browser state.

## 2. Hard-coded timing waits

**Anti-pattern:** `await page.waitForTimeout(2000)` after every state transition because "it works on my laptop."

**Why it fails:** on slower CI, 2 seconds is not enough. On faster local, you waited 1.9 seconds longer than needed. Both fail differently: slow CI flakes, fast local burns wall-clock. And the assertion is implicitly "the thing happens within 2 seconds," which is rarely the assertion you actually want.

**Do instead:** `await expect(locator).toBeVisible({ timeout: 5_000 })`. This polls. It returns as soon as the condition is met. It fails fast with a useful message if it does not. Reserve `waitForTimeout` for genuine "I am asserting a thing should not happen within N seconds" cases.

## 3. Single model deciding all journeys

**Anti-pattern:** dispatch all journeys to Sonnet only because "Sonnet is good enough."

**Why it fails:** model-family blind spots are a real class of bug. A copy mistake that Sonnet generated will not get flagged by Sonnet on review. The whole point of multi-model dispatch is independent judgments. Single-model dispatch is barely better than no dispatch.

**Do instead:** at least one Anthropic tier (Sonnet baseline) plus at least one non-Anthropic model via OpenRouter. The cost is dollars; the upside is a category of bugs that single-vendor dispatch will never see. If budget is tight, run Sonnet baseline plus a cross-provider model on the critical-path journey only.

## 4. Suppressing model disagreements

**Anti-pattern:** when two models disagree on whether a step passed, take the majority vote and discard the minority opinion.

**Why it fails:** disagreement is signal. If Sonnet says pass and Gemini says fail, that is the most interesting data point in the run. Suppressing it loses the information that would have told you about a flaky step, an ambiguous UI, or a model-family blind spot.

**Do instead:** surface disagreements as their own section in the report. Tag them as "disagreement" not "pass" or "fail." Look at them before you look at the unanimous findings.

## 5. Journey assertions that depend on absolute timing

**Anti-pattern:** `expect(elapsed).toBeLessThan(1500)` because the spec says "the toast should appear within 1.5 seconds."

**Why it fails:** the harness runs on shared CI machines, sometimes loaded, sometimes idle. Absolute timing assertions fail randomly. You either ignore them (so they are useless) or you tune them loose enough that they catch only catastrophic regressions.

**Do instead:** assert structure not timing. "The toast appears before the next state transition." "The loading indicator is visible while the request is in flight." Use Playwright's web-first assertions which poll.

## 6. Letting one model's failure block another's

**Anti-pattern:** in `multi-model-dispatch.ts`, await each model in series. Model 1 errors out; the run stops; models 2 and 3 never get a chance.

**Why it fails:** transient API errors are common. A 5xx from one provider should not block the entire dispatch. You lose all the data from the models that would have succeeded.

**Do instead:** `Promise.allSettled` over the dispatch matrix. Each model's result is captured independently. Failed dispatches show up in the report as "model errored, not as a journey pass/fail."

## 7. Capturing screenshots after every action

**Anti-pattern:** screenshot on every click, every keypress, every assertion.

**Why it fails:** the screenshot directory balloons. The signal-to-noise drops. The post-run analysis becomes "find the screenshot that shows the bug among 400 PNGs."

**Do instead:** screenshot at state transitions only. Definition of state transition: the URL changes, a modal opens or closes, a phase indicator flips. Within a state, capture only when an action fails. The schema's `step_id` should align with state transitions, not individual interactions.

## 8. Treating `.qa-runs/` as durable

**Anti-pattern:** committing `.qa-runs/` so the team can review yesterday's findings.

**Why it fails:** binary screenshots blow up the repo. Diff noise drowns real diff. Future-you trying to bisect cannot find the run from three weeks ago because the repo is 4GB.

**Do instead:** `.qa-runs/` is gitignored. If you want to preserve a specific run, copy it to a documented path (e.g. `docs/qa-runs-archive/<date>-<topic>.md`) and reference it. The archive policy is opt-in, not default.

## 9. Coupling journey IDs to feature names

**Anti-pattern:** `tournament-happy-path.spec.ts`, `open-round-publish.spec.ts`. Each journey gets a name that reflects the current feature semantics.

**Why it fails:** features get renamed. Code archeology against a six-month-old `.qa-runs/` archive becomes "what was 'tournament' in the May taxonomy?"

**Do instead:** stable journey IDs (`J1` through `JN`). The README or `JOURNEY-CATALOG-GUIDE.md` maps the ID to its current human-readable name. The ID is permanent; the name is editable.

## 10. Replacing manual smoke testing entirely

**Anti-pattern:** the harness is green, so we ship without a manual walk-through.

**Why it fails:** the harness misses everything it was not coded to look for. New visual mistakes, new copy issues, new social-context bugs are exactly the class that humans catch and the harness does not. The harness is additive, not a replacement.

**Do instead:** harness gates on regressions to known journeys. Humans cover novel paths and taste judgments. Before a release, the human walk is shorter and more focused because the harness has cleared the routine surfaces.

## 11. Putting business logic in journey assertions

**Anti-pattern:** `if (response.body.score === expectedScore) { pass } else { fail }` inside the journey spec.

**Why it fails:** the journey spec is now duplicating the server's scoring logic. When the server changes, the journey breaks for the wrong reason. The journey is also now coupled to internal API shape; refactors that should not affect users break the harness.

**Do instead:** the journey asserts what the user sees, not what the server computed. "The scoreboard shows player A in first place." Server-side correctness is a unit-test or integration-test concern, not a journey concern.

## 12. Auto-creating GitHub issues from findings in v1

**Anti-pattern:** every HIGH finding becomes a GitHub issue automatically.

**Why it fails:** signal-to-noise is unproven. The first few runs produce noise (axe-core picks up the same color-contrast violation on every page). Issues pile up. People stop reading them. The cost of cleaning up false-positive issues outweighs the value of automation.

**Do instead:** v1 emits markdown reports. Humans triage. After the first month of real runs, measure: what fraction of findings became real bugs? If it is high enough, then automate. See `DECISIONS.md` for the deferral reasoning.

## 13. WSL UNC-path failure

**Anti-pattern (Linux-on-Windows specific):** running scripts from a directory like `.claude/worktrees/...` while invoking Windows-interop tools.

**Why it fails:** Windows interop reinterprets WSL paths as UNC. `cmd.exe` refuses UNC working directories. Tools fail silently or produce zero results with confusing error messages ("Docker daemon" misdirection is the classic).

**Do instead:** run from the main repo directory. Use Linux-native binary paths (`/usr/local/bin/...`, `./node_modules/.bin/...`) not the Windows wrappers. If you see "zero results" from a tool that should return data, check `pwd` first.

This is a Yonatan-specific environmental hazard, but it has cost real work. Document it for future-anyone running this harness on WSL.
