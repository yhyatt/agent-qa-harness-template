# Journey Catalog Guide

How to enumerate journeys for a new app. The journey catalog is the canonical list of "what does the harness walk." Get this right and the harness pays off; get it wrong and you spend cycles on flows nobody hits.

## Three layers, in order

Enumerate in this order: critical path first, state transitions second, recovery flows third. Skipping layer 1 to do layer 3 catches edge cases the harness should not be the primary tool for.

### Layer 1: Critical path

The two-or-three sentences a user would say describing what your app does. For Ballpark: "I create a trivia session, my friends join, we play, we vote on partial credit, we see who won." For a SaaS dashboard: "I sign up, I see my data, I export a report." For an e-commerce: "I browse, I add to cart, I check out, I get an email."

Every critical-path step becomes a journey. Conservatively, 3-5 journeys cover the whole path.

**Rules of thumb:**

- A critical-path journey is end-to-end. It starts at the unauthenticated landing or the sign-in screen and ends at "the user got the value they came for."
- Splitting a critical path across two journeys is fine if they share a clear handoff state (e.g. "host creates session" ends with a join code, "player joins" starts with that join code).
- If you find yourself writing the same setup steps for five journeys, factor them into a fixture or a helper but keep the journey end-to-end. Skipping setup is the most common way harness coverage rots.

### Layer 2: State transitions

Layer 2 captures "what happens when the app changes mode." These are the bug magnets: phase changes, modal opens, navigation, role switches.

For each layer-1 journey, ask: at what points does the app's visible state change? Each transition is a candidate sub-journey. You do not need a separate `test()` block for each one; many are sub-steps inside a layer-1 journey. But state transitions are where you put `screenshot(page, journey, step)` calls and where you check console errors.

**Examples:**

- Modal open: did the modal render with the right title, focus management, ARIA?
- Phase change: did the realtime nudge arrive and trigger the re-fetch, or did the UI go stale?
- Role switch (host to player or admin to user): did the UI update without a full reload, or is there a stale-state bug?
- Pagination, sort, filter: do the list assertions still hold after the state changes?

### Layer 3: Recovery flows

Layer 3 is "what happens when things go wrong." These are the journeys that catch the bugs production telemetry surfaces but unit tests miss.

**Examples:**

- Network drops mid-action. Does the optimistic UI revert? Does retry work?
- Session expires during a flow. Does the user get re-prompted, or do they see a generic error?
- Concurrent action conflict (two users edit the same record). Does the resolution UI appear?
- Browser refresh mid-state. Does the user resume where they were, or lose work?

Recovery flows are also where Pattern B (parallel agents per role) starts to become necessary. Pattern A can simulate "network drops" with `page.context().setOffline(true)` for a single role; it cannot reproduce "host offline while two players continue" cleanly.

## Sizing the catalog

A first pass should produce 5-8 journeys. More than 12 is usually a sign that you have not factored shared setup into helpers and the journeys are duplicating each other.

The Ballpark slice-14-lite ships with 4 journeys (host happy path, anonymous join, open round, static walk). The full slice-14 plan expands to 8. That is roughly the right size for a complex multi-role app.

For a simpler app (single-user dashboard), 3-5 journeys are plenty.

## ID scheme

Use stable numeric IDs: `J1`, `J2`, through `JN`. The README maps each ID to its current human-readable name. The ID is permanent; the name is editable.

```
| ID | Name (current)            | Roles            | Auth required |
|----|---------------------------|------------------|---------------|
| J1 | host tournament happy     | host             | host-auth     |
| J2 | anonymous player join     | player           | none          |
| J3 | open round publish        | host             | host-auth     |
| J4 | static surface walk       | none             | none          |
```

When a journey is deprecated, mark it as such in the README and keep the ID retired. Do not reuse IDs.

## Step ID scheme

Inside a journey, steps get sub-IDs: `J1/01`, `J1/02`, etc. Each step ID corresponds to one state transition (per layer 2 above). Six to twelve steps per journey is the working range.

The step ID shows up in:
- The screenshot path (`.qa-runs/.../screenshots/J1/04.png`)
- The structured JSON finding (`step_id: "J1/04"`)
- The dedup key
- The markdown report headers

## Naming conventions

- Journey IDs are uppercase letter plus number: `J1`, `J2`. Permanent.
- Journey names are short imperative phrases: "host tournament happy path," "anonymous player join." Editable.
- Step names are even shorter, kebab-case, action-oriented: `host-clicks-create`, `player-enters-code`, `vote-submitted`. Used in screenshot filenames.

## What goes in a journey vs what does not

**In a journey:**
- Real user actions (click, type, navigate)
- State transition assertions (URL changed, modal opened)
- Visible-text assertions (the toast says X)
- Capture calls (screenshot, listeners, axe)

**Not in a journey:**
- Server-side correctness assertions (the database has the right rows). Use unit or integration tests.
- Performance assertions (load time under 1s). Use Lighthouse or Web Vitals tooling.
- Pixel-level visual comparison. Out of scope (see ADR-009).
- Mocking. Journeys walk the real app. If you need mocks, you are writing an integration test.

## Common journey patterns by app type

### Multi-role social or collaboration app (Ballpark, Slack-like, Notion-like)

- J1: primary user creates a thing
- J2: secondary user joins the thing
- J3: primary user shares or publishes
- J4: static and unauth surfaces
- J5: state recovery (refresh mid-flow)
- J6: error path (invalid join code, permission denied)

### SaaS dashboard

- J1: sign up and first-time onboarding
- J2: standard daily action (create a record, view a list)
- J3: settings or account management
- J4: static and unauth surfaces
- J5: error path (expired session, 403)

### E-commerce

- J1: browse, add to cart, checkout
- J2: account creation and order history
- J3: filter and search flows
- J4: static and unauth surfaces
- J5: error path (out-of-stock, payment declined)

### Content or media app

- J1: discover and play (the primary user value)
- J2: account creation and library
- J3: share or subscribe
- J4: static and unauth surfaces
- J5: error path (region blocked, network drop during play)

## Anti-pattern: testing implementation details

A journey that asserts "the React component named UserProfile is in the DOM" is not a journey, it is a unit test. Journeys assert what a user sees. The internal component name can change without breaking what users see; if your journey breaks, it should be because the user experience broke, not because someone refactored a name.

## Catalog evolution

The catalog grows with the app. Add a journey when:

- A new critical-path flow ships. New flows always get a journey.
- A real bug surfaces in production that the existing journeys did not catch. Add a journey that would have caught it. This is the highest-leverage way to grow the catalog.
- A user-reported issue is filed for a flow the harness does not walk. Even if you do not have the bug yet, the absence of a journey is a coverage gap.

The catalog shrinks (rarely) when:

- A feature is removed. Mark the journey deprecated; keep the ID retired.
- A flow becomes obviously redundant with another journey. Merge.

Never remove a journey because it is flaky. Fix the flake or quarantine the specific step. A flaky journey covers something; a removed journey covers nothing.
