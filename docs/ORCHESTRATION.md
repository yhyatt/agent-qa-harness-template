# agent-qa-harness-template Orchestration Playbook

Operational detail for running a slice. `AGENTS.md` carries the binding **triggers** (verb + condition + the one non-negotiable invariant); this file carries the **mechanics, rationale, and war stories** behind them. Read it when you enter slice work.

Bidirectional with the orchestrator's Claude Code auto-memory: the `PR gate` and `Post-PR routine` entries live in its private memory index (under `~/.claude/projects/<repo-key>/memory/`, outside this repo), not in a tracked file. Those notes and this file describe the same routine, so keep them in sync.

## Subagents (full roster)

- **Design**: produced via [Claude Design](https://claude.ai/design) as a system-first turn (DESIGN.md, no screens), then per-surface screen turns with DESIGN.md pasted at the top.
- **Implement**: Sonnet 4.6 in a **git worktree** (`isolation: "worktree"`) on a feature branch named `slice-N-<topic>`.
- **Review** (code + security): Opus 4.7 in the main worktree, read-only. Runs the `dishonest-code-audit` skill as part of every review pass. Run it BEFORE opening the PR, so bot reviewers get a pre-vetted diff.
- **Research**: Opus 4.7 in the main worktree; artifacts go to gitignored `.<topic>-research/` dirs, never `/tmp` (WSL wipes it).

## Delegation rule (orchestrator never hand-codes)

The orchestrator's job is to route, diagnose, verify, and review, not to write or edit code itself. **Every** unit of code that lands in this repo, whether a slice implementation or a review-driven fixup, is written by a subagent in an isolated git worktree (`isolation: "worktree"`), never by the orchestrator inline. This applies to bug fixes and fixup rounds exactly as it applies to a slice's first commit: a one-line lint fix from a bot-review round still goes through a worktree subagent, not an orchestrator `Edit` call.

What stays with the orchestrator: diagnosing the problem, deciding scope, briefing the subagent, running the Verification gate below, reviewing the diff, and all routine git plumbing (checkout, worktree add/remove, branch, push). What moves to the subagent: every **file-content edit**, `Edit`/`Write`, or a `Bash` command that rewrites source (e.g. `sed -i`). This is about who edits code, not who runs git.

**Hazards to watch for:**
- **Use `Edit`, not `Write`, for surgical changes.** A fixup that only needs a few lines changed should never regenerate a whole file, `Write` risks silently dropping unrelated content the briefing didn't anticipate.
- **Diff the pushed commit before trusting it.** After the subagent reports back, run `git diff <parent-sha> <new-tip-sha>` on the branch it pushed to confirm the commit contains only the intended hunks, not an accidental revert, a stray formatting pass, or an out-of-scope edit.
- **The main worktree can be left on the temp branch.** After a worktree agent finishes, the orchestrator's own working tree can end up checked out on the agent's temporary branch (an artifact of how `isolation: "worktree"` sets up the temp worktree). Check `git branch --show-current` before continuing; if it is not the slice branch, `git checkout <slice-branch>` in the main tree, then prune the temp worktree/branch (`git worktree remove <path>`, `git branch -d <temp-branch>`).

## Slice loop

Work proceeds in slices (see `HANDOFF.md + docs/DECISIONS.md`). Each slice: design → impl (worktree) → review (Opus, read-only) → orchestrator pushes the feature branch to `yhyatt/agent-qa-harness-template` and opens a PR; user merges. Security review runs on the PR head when the slice touches auth or data. End each slice green (typecheck + tests + lint) before opening the PR. **Never** direct-merge to `main` from the orchestrator; the PR is the audit trail and the human gate.

Deferred work (impl-debt, polish, lessons learned) goes into `docs/BACKLOG.md`, grouped by the target slice. The backlog is the durable punch list; the plan is the trajectory.

## Verification gate (binding, before review)

1. **Worktree env + deps.** Symlink the project's secrets dotenv (e.g. `.env.local`) from the main worktree into the impl worktree before any build/start in the gate. Gitignored, so safe. Without it, server routes that read secrets 500 silently and gate checks pass with no error. Symlink `node_modules` too (see Worktree caveats): a fresh worktree has none, so without it the gate commands cannot run in the worktree at all, and an agent may report "green" from the wrong tree or from nowhere.
2. **Browser/CLI runs check semantic success.** Lighthouse exits 0 even when the page 500s; Playwright can timeout but exit 0; `gh pr create` can succeed on a stale ref. Pre-flight URLs with `curl -sf`, parse for the semantic-success field (`r.runtimeError` for Lighthouse), exit non-zero if not present.
3. **Empirical claims need orchestrator re-verification.** Benchmark numbers, perf scores, test counts, anything-the-agent-measured-and-reported is draft until the orchestrator independently re-runs the same measurement. Orchestrator numbers are authoritative; mismatches get corrected via fixup commit, never amend.

## Post-PR routine (binding, every PR without exception)

**Sensing vs deciding (read first).** Bots and the scheduled check are a *sensing layer*: they review and **surface** findings into the session. They hold **no judgment** on whether or when to act. Every act-vs-wait decision is the orchestrator's, made by step 4's risk classification *alone*. Neither a bot's severity label (`P2`, "consider...", a thumbs-up) nor the read-only nature of a check is an act-or-wait signal; they are findings and transport, nothing more.

1. **Schedule a 10-minute bot-review check via `CronCreate` (local cron, session-only).** Immediately after `gh pr create`, fire a `CronCreate` call with `recurring: false` and `durable: false` (the default) for +10 minutes out. The prompt body must re-enter the orchestrator session and read **all three comment sources every round, as three explicit calls**: (1) review objects via `gh pr view <n> --json reviews,statusCheckRollup,mergeable,mergeStateStatus`; (2) conversation/issue comments via `gh api --paginate repos/yhyatt/agent-qa-harness-template/issues/<n>/comments` (explicit and paginated rather than `gh pr view --json comments`, which can truncate, and this is where Codex posts its clean verdicts); (3) inline PR comments via `gh api --paginate repos/yhyatt/agent-qa-harness-template/pulls/<n>/comments`. The `--paginate` flag is required on both REST calls: the list endpoints return 30/page, so without it a PR with >30 comments is silently undercounted and the round can be reported complete while missing findings. Then surface findings directly to the user. All three matter: Codex posts clean verdicts as plain conversation comments, not review objects, so a reviews-only read reports it silent when it already passed. The check must not mutate anything *as part of observing* (no comments / commits / pushes / edits merely to *fetch* state). It does **not** gate on the user: once findings are surfaced, the response is decided immediately by step 4. Mechanical findings get the fixup iteration in the same turn; only major-risk / product findings wait. "Read-only" scopes the *observation*, never the *response*. End the cron prompt with "...fetch, surface, then apply Post-PR step 4", never "forbid all edits," which would trap the wakeup into waiting against step 4.

   **Why `CronCreate` and not `schedule` / `RemoteTrigger`:** local cron fires the prompt INTO the orchestrator session, which already has its tools and full conversation context. Remote routines run in a separate cloud session whose output dies in a routine log the orchestrator never reads.

   **When NOT to use `CronCreate`:** the cron is session-only; if the terminal closes before it fires, the cron dies. For overnight or multi-day checks where the orchestrator session is guaranteed-dead at fire time, fall back to a remote routine (`schedule` skill) AND wire a real outbound surfacing channel (a labeled top-level PR comment like `## bot-check-summary:` is acceptable; email is not).

2. **Reply inline to every bot comment.** After landing a fixup commit (or deciding to push back), post a reply on each individual inline review comment via `gh api repos/yhyatt/agent-qa-harness-template/pulls/<n>/comments -F in_reply_to=<comment_id> -F body=...`. Reference the fixup commit short SHA. Disagreements get the rationale inline. Skipping a comment is not acceptable.

3. **Explicitly invoke bot re-review after every fixup push.** Bots are not uniform in auto-re-reviewing. After every fixup push: post `@codex review` as a top-level PR comment (Codex is NOT requestable via REST `requested_reviewers`; that call returns 200 but does not register it, verified 2026-06-11, so the comment is the only Codex trigger), and request Copilot via the REST review request `gh api -X POST repos/yhyatt/agent-qa-harness-template/pulls/<n>/requested_reviewers -f 'reviewers[]=copilot-pull-request-reviewer[bot]'` (`@copilot review again` comments do not reliably trigger a re-review, observed 2026-06-10; the GraphQL `gh pr edit --add-reviewer` path can fail on a projectCards deprecation error). **Vercel Agent** may skip a fresh inline review on redeploy; request it manually if a round finds none of its comments. Then schedule the 10-min check (step 1). Invoke first, then schedule, so the bots are actively re-reviewing when the check fires.

   **Reading the round (binding):**
   - **A thumbs-up reaction with no comments = that bot's approval / OK-to-merge.** Some bots (Codex especially) react thumbs-up on the PR or on their own review instead of commenting when they have nothing to flag. Check `reactions` on the PR (`gh api --paginate repos/yhyatt/agent-qa-harness-template/issues/<n>/reactions`) and on the latest review before concluding a bot "didn't review." No-comment-plus-thumbs-up is a pass, not silence.
   - **Codex posts clean verdicts as plain conversation comments** ("Codex Review: Didn't find any major issues. ..."), not review objects, so `gh pr view --json reviews` misses them; with findings it posts a review object plus inline comments, and an eyes reaction on the trigger comment means it is processing. Read three sources per round: review objects, issue comments, inline PR comments.
   - **Only one of Codex/Copilot responded this round?** Re-request ONLY the missing bot (don't re-ping the one that already answered), then schedule a fresh 10-min wake-up. Repeat until both have weighed in on the latest commit.

4. **Fixup-iteration autonomy (binding).** When a bot-review round lands findings, classify them and act WITHOUT waiting for the user. The bots' labels and the check's read-only framing carry no weight here. The only input is the risk classification below:
   - **All findings mechanical / low-risk** (lint, copy/string, hydration-safety, type nits, dead code, import order, test-only) → the orchestrator runs the next full iteration automatically: delegate the fix to a worktree subagent (per the Delegation rule above, the orchestrator does not apply the fix itself) → green the gate (typecheck + tests + lint) → push → reply inline to every comment (step 2) → re-invoke bots (step 3) → schedule the 10-min cron (step 1). Surface a summary *after*, not a permission request *before*.
   - **ANY finding carries major technical risk OR a UX/product decision** → STOP. Surface the finding(s) + proposed fix and wait for the user. Risk and product calls are the user's, never the bot's and never the orchestrator's.

   **Whether to re-run the review subagent on a fixup round is an orchestrator judgment call:** small/benign fixes and/or small PRs → skip it, rely on the external bots + cron. Large fixes and/or a PR that was complex to begin with → re-run the full review pass (read-only) before re-pushing.

5. **User merges, not the orchestrator.** After merge: remove the impl worktree (`git worktree remove`), sync local `main`, mark the slice's BACKLOG entry as shipped.

## Worktree caveats

- Live infrastructure (databases, deploy targets, API keys) is shared across worktrees. Only the orchestrator applies live migrations or pushes deploys.
- **A fresh worktree has NO `node_modules`** (gitignored, not copied by `git worktree`), so the impl agent cannot run the gate (typecheck/tests/lint) until deps resolve. **Symlink them from the main worktree** rather than installing per-worktree (a fresh install is slow and duplicates hundreds of MB). npm with a single root `node_modules`: `ln -s <main-worktree>/node_modules node_modules`. For pnpm / yarn-PnP / workspaces, adapt so the worktree resolves deps without a fresh install. The goal is a working dep tree, not a specific command. **Caveat:** a symlink shares main's install, so any `npm install` in the worktree mutates main's `node_modules` and races sibling sessions; a slice that adds or bumps a dependency must replace the symlink with a real per-worktree install instead. The orchestrator's independent gate re-run (above) likewise needs a `node_modules`-linked worktree.
- Persistent artifacts (IMPL-NOTES, audit reports, research outputs) live in `.<kind>-<topic>/` dirs at the repo root, all gitignored. Never in `/tmp` (WSL wipes on reboot).

## Why base off `origin/main`, not local `main` (matters most with parallel sessions)

The `.git` dir (`main` ref + all branches) is shared across every worktree of a clone. When multiple orchestrator sessions run different slices at once, local `main` drifts the instant a sibling session merges or lands a bookkeeping commit, and a worktree's creation-time base may already be stale. Fetching then branching off `origin/main` pins a current, deterministic base regardless of what HEAD the worktree inherited. Exception: when intentionally stacking on another in-flight branch, base off that branch's pushed ref and say so in the prompt. Corollary rules:

- `git fetch` before any "is this on main / is main current / which base" reasoning; local refs lie when a sibling moved origin.
- Serialize writes to shared `main`: one session advances it at a time, `git pull --ff-only origin main` before pushing to catch a race, never force-push `main`.
