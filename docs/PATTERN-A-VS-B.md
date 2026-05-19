# Pattern A vs Pattern B: Coordination Decision Tree

Two ways to wire multi-role journeys. Most journeys want A. A small fraction need B.

## Pattern A: Single Coordinator

One agent drives multiple Playwright `BrowserContext` objects inside one Node process. Each context has separate cookies, separate localStorage, separate session. The agent sequences actions across them.

```
┌─────────────────────────────┐
│   coordinator agent         │
│   (one model)               │
│                             │
│   ├─ ctx[host]              │
│   ├─ ctx[playerA]           │
│   └─ ctx[playerB]           │
└─────────────────────────────┘
```

**When to use:**
- Multi-role journey where roles act in sequence (host creates, then player joins, then host advances)
- Multi-role journey where interleaving is logical not temporal (player A submits then player B submits, order matters but a few hundred ms drift is fine)
- Any journey where one agent's judgment across all roles is acceptable

**Tradeoffs:**
- One model decides for all roles. If the model is biased toward the host's perspective, player-side bugs may go unnoticed.
- Serial drive cannot reproduce true cross-device races.
- Simpler to author, debug, and dedup. One decision tree, one set of findings per run.

**Cost:** roughly the same as a single-role journey. The dominant cost is model inference per step, not the number of contexts.

## Pattern B: Role-as-Separate-Agent

Multiple agents in parallel, each owning one role's browser session. They coordinate through a shared scratch file or a small in-memory server.

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ host agent   │    │ playerA agt  │    │ playerB agt  │
│ ctx[host]    │    │ ctx[playerA] │    │ ctx[playerB] │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                    │
       └─────────── shared state file ──────────┘
                  (join code, phase signal, etc)
```

**When to use:**
- Cross-device timing *is* the thing being tested
- Race conditions where simultaneity (not sequencing) matters
- Network partition scenarios (one agent goes offline mid-flow, comes back, state must be consistent)
- Adversarial scenarios (player A and player B vote on the same answer at the same instant, who wins?)

**Tradeoffs:**
- Higher coordination overhead. The shared-state file becomes a synchronization point.
- More moving parts. Each agent can produce findings; dedup has to merge across them.
- Real parallelism. You can produce races that Pattern A cannot.

**Cost:** roughly N times Pattern A, where N is the number of role-agents. Plus the scratch-file IO overhead, which is small but real.

## Decision tree

```
Is the bug class about simultaneity or cross-device timing?
│
├── No  → Pattern A. Done.
│
└── Yes → Is the timing assertion structural (within a 500ms tolerance) or strict (true race)?
         │
         ├── Structural → Pattern A with awaits. Strong enough.
         │
         └── Strict     → Pattern B.
```

## Worked examples

### Example 1: Host creates a quiz, three players join, host advances three questions, all submit, host reveals

**Pattern: A.** All sequencing is logical (host acts, then players act, then host advances). Even though host plus three players is four contexts, none of them needs to act at the same wall-clock instant. Pattern A drives the four contexts in turn.

### Example 2: Two players vote on the same answer at the same time, expected outcome is both votes are counted

**Pattern: B (probably).** "At the same time" is the test. Pattern A would do `await ctx[playerA].click(voteButton); await ctx[playerB].click(voteButton)` which serializes the two votes. The vote-counting code on the server has to handle true parallel POSTs; that path is only exercised by parallel agents.

That said, Pattern A can fake this with `Promise.all([ctx[playerA].click(...), ctx[playerB].click(...)])`. The two clicks fire in the same JavaScript microtask but the network requests still leave the machine within a few ms of each other. Often good enough.

Rule of thumb: if your tolerance is "within 500ms," Pattern A with `Promise.all` works. If your tolerance is "within 5ms," you need Pattern B.

### Example 3: Host abandons mid-game (closes tab), players observe correct end state

**Pattern: A.** Closing the host context is a deterministic action. The player contexts wait a few seconds and observe what they observe. No timing race here, just a sequence with a longer dwell.

### Example 4: Host loses network connectivity during voting, players continue, host reconnects, state reconciles

**Pattern: B.** The interesting bug class is "what does the player see while the host is gone, and what does the host see after reconnect?" That requires the player agent to be actively driving while the host agent is offline. Pattern A cannot do "offline while another context does work" because it is one process driving both.

### Example 5: New user signs up, lands on welcome screen, dismisses onboarding tooltip, navigates to first feature

**Pattern: A.** Single role. Pattern A is overkill terminology; this is just a single-context journey. Mentioned for completeness.

## Defaults for the template

The stub journeys in `tests/e2e/journeys/journeys.spec.ts` are all Pattern A. Pattern B requires a separate runner (a parent process that spawns role-agents). The stub does not include that runner; add it in the consuming repo when a journey genuinely needs it.

## When to escalate

You started with A and now suspect you need B. Symptoms:

- The journey "passes" but you cannot reproduce a bug users hit
- `Promise.all` makes the assertion look right but you do not believe the server actually handles parallel input
- Test flake correlates with system load (server-side mutex behavior depends on real concurrency, which A does not provide)

When you escalate, write the migration: copy the journey to a new file, refactor the host actions into one agent script and the player actions into another, add a shared-state scratch file. Keep the A version next to it; sometimes the bug is a Pattern-A bug and you need both runs to compare.

See `DECISIONS.md` for why Pattern B is not the default.
