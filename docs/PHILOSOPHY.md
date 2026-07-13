# Philosophy

Why this harness exists, what it is for, what it is not for. Read this before extending or porting.

## The core observation

Static code analysis finds bugs that the code commits in writing. Linters, type checkers, static auditors like `dishonest-code-audit` (the static sibling of this project) walk the source on disk. They are cheap, repeatable, and they miss everything that depends on the running app.

A surprising fraction of real shipping bugs are not in the source on disk. They are in the running system. Three families show up over and over:

- **Configuration drift.** The code is fine. The hosted environment is misconfigured. Example: an OAuth redirect URL set to localhost in production. Code is correct, dashboard is wrong, users land on a broken page after Google sign-in.
- **Copy and visual mistakes.** The toast appears but says the wrong thing. The button is rendered but its contrast ratio fails WCAG. The locale string is missing for one path and the user sees the variable name.
- **Timing and state.** The component exists. It even renders. But it flashes for 200ms when the spec called for 2s, or it shows a stale value because the realtime nudge raced the database write.

Static analysis cannot see any of these. Manual smoke testing catches them, sometimes, when the human happens to look. Production telemetry catches them after users hit them.

This harness aims for the gap between static and telemetry. Walk the running app like a user would, capture everything (DOM, console, network, axe, locale text), let multiple models judge each step, and emit structured findings.

## Lessons that motivated the pattern

The first concrete instantiation is Ballpark slice 14. Three findings from the Ballpark 2026-05-19 hands-on audit drove the design:

1. **CONFIG-002 (Supabase site URL set to localhost in prod).** Google sign-in on production redirected to `http://localhost:3000/` instead of `/auth/callback`. The code was correct. A journey that walks the host sign-in flow and asserts the post-OAuth URL would have caught it in 30 seconds. A telemetry-based alert would have caught it after users complained.

2. **ARCH-001 (chip-id collision in the per-question reveal view).** Two unrelated chip elements shared a DOM id. The visual audit caught it because a human noticed the wrong chip highlighted. A structured journey harness that captures axe-core output per step would have flagged it earlier (axe-core reports duplicate ids as a WCAG violation). Static analysis missed it because the ids are generated from runtime data, not literals in the source.

3. **The audit took several hours of manual time.** Going through the IOS-UX-FINDINGS list, roughly 60% of the findings are mechanically detectable: missing locale strings, contrast violations, console errors, 4xx responses, broken redirects. A harness that runs nightly would surface those without human time. The remaining 40% (copy taste, brand voice, social context) still need humans.

The math is roughly: every hour the harness runs saves an hour of human audit time, plus catches some fraction of bugs earlier than the next audit would.

## Why structured JSON per step

A free-form agent report is hard to dedup, hard to diff between runs, and hard to consume programmatically. JSON per step gives:

- **Deterministic dedup.** Hash by `(journey_id, step_id, severity, project, normalized_title)`. Same finding from two models collapses; disagreement surfaces. `project` keeps findings from different Playwright projects (e.g. `chromium-desktop` vs `mobile-iphone-13`) from collapsing into one even when their titles are identical.
- **Run-over-run diff.** Last night's run found 12 findings, tonight's found 14. Which two are new? Trivial with JSON, painful with prose.
- **Programmatic gates.** CI can read the JSON and fail the build on any HIGH severity finding without parsing markdown.
- **Multi-model comparison.** Same schema across all models means dedup and disagreement detection are uniform.

The markdown report is a rendering of the JSON. The source of truth is JSON.

Per-step schema (canonical):

```json
{
  "step_id": "J1/04",
  "journey_id": "J1",
  "action": "click sign-in button",
  "pass": true,
  "screenshot_path": ".qa-runs/2026-05-19-1900/screenshots/chromium-desktop/J1/04.png",
  "locale_snapshot": ["Sign in with Google", "By continuing you agree..."],
  "db_state": null,
  "console_errors": [],
  "network_5xx": [],
  "axe_violations": 0,
  "axe_top3": [],
  "judgment": "Button rendered with correct copy. Click triggered OAuth redirect to expected URL.",
  "bucket": "pass",
  "model": "anthropic/claude-sonnet-4-6",
  "project": "chromium-desktop"
}
```

Per-run meta schema (ADR-015 update). The `meta` block on each `findings.dispatched.json` / `findings.deduped.json` carries three distinct identities so a downstream reader cannot confuse the harness's identity with the target app's deployed build:

```json
{
  "meta": {
    "run_id": "2026-05-22-19-00",
    "timestamp": "2026-05-22T19:00:00.000Z",
    "target": "https://app.example.com",
    "harness_sha": "f270b74",
    "target_deployment": {
      "vercel_id": "iad1::abc123-1700000000000-deadbeef",
      "deployment_url": "app-xyz.vercel.app",
      "captured_at": "2026-05-22T19:00:01.234Z",
      "build_commit": "abc1234",
      "deployed_at": "2026-05-22T18:55:12.000Z"
    },
    "models": ["anthropic/claude-sonnet-4-6", "google/gemini-3.5-flash", "openai/gpt-5"]
  }
}
```

`harness_sha` is the QA harness repo's short git SHA. `target_deployment` is captured at journey runtime (Vercel headers) plus an optional `GET /__build` fetch off the target URL. Either pair of sub-fields may be null on a non-Vercel host or when the consumer does not expose `/__build`; the outer field is null only when no journey ran. See ADR-015 and `docs/CUSTOMIZATION.md` for the full convention.

## Why multi-model dispatch

One model produces one opinion. One opinion has blind spots. Cross-model dispatch buys two things:

1. **Tier economics.** Haiku at $1/$5 per million tokens runs cheaply over every journey on every commit. Sonnet runs the same journeys with more thorough screenshot judgment. Opus runs the hard cases (phase transitions, ambiguous states). The cost scales with the value of the judgment.

2. **Provider-family blind spots.** Anthropic models share training data with each other. When a Hebrew copy mistake or a layout edge case slips past Sonnet, it usually slips past Opus too. A second opinion from a Gemini or GPT-5 (via OpenRouter) catches a different slice. The cost is dollars; the upside is a class of bugs that pure-Anthropic dispatch never sees.

Disagreements between models are not noise. They are tuning signals. Same diagnostic pattern as the `dishonest-code-audit` two-specialist split: when one specialist flags a finding the other missed, that is either a real bug the second missed or a false positive worth understanding.

## Why Pattern A first, Pattern B reserved

Pattern A: one coordinator agent driving multiple Playwright BrowserContexts. Each context has its own session storage, so context-1 is "host", context-2 is "player A", context-3 is "player B". The agent drives all three serially or with `Promise.all` for interleaved actions.

Pattern B: multiple agents in parallel, one per role, sharing state through a scratch file or a small server.

Pattern A handles most journeys with less overhead. One model, one decision tree, no inter-agent coordination. The exception is when cross-device timing is *the thing being tested*. If the journey is "host clicks reveal at the same time as player submits a vote, do both go through?", you need actual parallel agents because Pattern A's serial drive cannot reproduce the race.

The default is Pattern A. Escalate to B only when the bug class demands it.

## What this harness is not

- Not a replacement for unit tests. Unit tests cover pure logic. The harness covers running-system integration.
- Not a load tester. One synthetic user per role, not thousands.
- Not a visual regression tool. Axe-core covers a11y; pixel diffing is a separate problem.
- Not a manual test runner. Humans still do final pre-release walks. The harness reduces the surface area they have to cover.

## Cost-of-iteration framing

The win is not that the harness is cheaper than a human auditor on a per-bug basis (it often is, but the comparison depends on bug rarity). The win is that the harness runs every night without anyone scheduling it. Cumulative coverage over time, not per-run cost, is the right metric.

See `COST-MODEL.md` for dollar estimates and `DECISIONS.md` for what was deliberately deferred to keep v1 shippable.
