# agent-qa-harness-template PR review calibration

Guidance for automated PR reviewers (GitHub Copilot, and any other bot reviewing this repo). This repo runs a bot-review plus fixup loop where **every finding you post can trigger a full fixup and re-review cycle.** Optimize for signal, not coverage. Before posting a finding, apply these:

1. **Severity honesty.** Label correctness, data-loss, and security as high; a genuinely reachable edge case as medium; naming, style, "consider", and "you could also" as low. Do not inflate. When only low-severity observations remain, say "no blocking issues" rather than manufacturing a nit to have something to report.
2. **One finding per issue.** Do not restate the same concern on several lines or in several forms, and do not repeat a point another reviewer already made. Piling inflates the round count without adding information.
3. **Do not re-raise a settled finding.** If a finding was already fixed, deferred to the backlog, or declined with a stated rationale in an earlier round, do not raise it again on the next commit. Re-raising a dispositioned item is the single biggest driver of wasted review cycles here.
4. **No gold-plating.** Do not ask for a guard, abstraction, or hardening against an input the code's own constraints cannot produce. If you cannot name a concrete, reachable input that triggers the bug, do not raise it. Defense in depth against a state that cannot occur is noise, and it makes the change more complex than its goal requires.
5. **Respect the stated scope.** Read the PR description's goal and any "out of scope" or "deferred" notes. Do not ask the PR to build deferred work or to add surface beyond its goal. A good idea outside the goal is a backlog suggestion, phrased as such, not a change request on this PR.
6. **The repo sets the style rules, not you.** Follow this repo's conventions in `AGENTS.md` (for example its dash and punctuation rules) and do not flag repo-sanctioned patterns as defects.
7. **Prefer the whole over the line.** If your suggested fix would make the change more complex than its goal requires, say so instead of proposing the added complexity.

The goal is a PR that is correct and matches its stated goal, not a PR that has survived the maximum number of review passes.
