# Cost Model

Dollar-and-cents estimates per harness run. Numbers as of 2026-05. Treat as order-of-magnitude; actual usage drifts with screenshot resolution, journey length, and model verbosity.

## Per-step token budget

A typical journey step looks like this in the model context:

- System prompt: ~800 tokens (schema, role, instructions)
- Screenshot: ~1500 tokens (image, JPEG-compressed, 1280x900 or mobile)
- Locale snapshot: ~200 tokens (the user-visible strings on the page)
- Console errors plus network failures: ~100 tokens (usually empty)
- Action prompt: ~150 tokens ("you just clicked X, judge what happened")

Total input per step: ~2750 tokens.
Total output per step: ~300 tokens (structured JSON, prose under 200 words).

A journey is roughly 6-12 steps. Call it 10 steps as the working estimate.

## Per-journey cost by tier

Pricing assumed (as of 2026-05, in USD per million tokens). All models route through OpenRouter; per-provider list prices apply with a small OpenRouter markup folded in.

| Tier | Input | Output |
|------|-------|--------|
| Haiku 4.5 (anthropic/) | $1.00 | $5.00 |
| Sonnet 4.6 (anthropic/) | $3.00 | $15.00 |
| Opus 4.7 (anthropic/) | $15.00 | $75.00 |
| Gemini 3.5 Flash (google/) | $1.50 | $9.00 |
| GPT-5 (openai/) | $2.50 | $15.00 |

One journey (10 steps, 2750 input + 300 output per step):

| Tier | Cost per journey | Cost per 8-journey suite |
|------|------------------|--------------------------|
| Haiku 4.5 | $0.04 | $0.32 |
| Sonnet 4.6 | $0.13 | $1.04 |
| Opus 4.7 | $0.64 | $5.12 |
| Gemini 3.5 Flash | $0.07 | $0.56 |
| GPT-5 | $0.11 | $0.88 |

A full multi-model dispatch (Haiku plus Sonnet plus Opus plus 2 OpenRouter models) over 8 journeys:

**Total per run: ~$8.**

Run nightly: ~$240/month. Run on every PR: depends on PR volume, but a 10-PR-per-week project lands at ~$320/month with a partial dispatch on PRs and a full dispatch nightly.

## Cost-vs-coverage scaling

You have two scaling axes: more journeys (cover more flows) or more models (catch more blind spots). Both cost roughly linearly. The right scaling direction depends on where you are:

### Early (first month of harness operation)

- 3-5 journeys covering the critical paths
- Sonnet baseline plus one cross-provider model (Gemini or GPT-5)
- Run nightly
- Estimated cost: ~$1-2/run, ~$45/month

You are buying signal about whether the harness is useful at all. Do not over-invest.

### Established (after the first month if the harness has caught real bugs)

- 8-12 journeys (the original critical paths plus state-transition and recovery flows)
- Haiku parallel sweep on every PR
- Sonnet plus Opus plus 2 cross-provider models nightly
- Estimated cost: ~$8/run nightly plus ~$0.50/run on PRs
- Monthly: ~$240 plus PR overhead

You are buying coverage and per-PR regression gating.

### Scale-out (after model disagreements have stopped surfacing novel bug classes)

- Stop adding more models. Marginal value drops.
- Start adding more journeys, especially recovery and adversarial flows.
- Or: invest in Pattern B coordination for the journeys where timing matters.

Diminishing returns kick in around 5 models per journey. Past that, you are paying for repeated agreement.

## When to scale up tier vs scale out journey count

**Scale up (add Opus, add cross-provider models)** when:
- Sonnet is giving you the same finding set as Haiku. Your judgment ceiling is the model, not the harness.
- You have caught false negatives in production that Sonnet's output did not surface. Opus might.
- A specific journey has subtle copy or layout requirements that Sonnet glosses over.

**Scale out (add journeys, broaden coverage)** when:
- The current journey set has caught its bugs and is now mostly green.
- Real bugs in production are happening in flows the harness does not walk.
- The set of "things that could go wrong" feels narrow because the harness is narrow.

## Cost gotchas to budget for

- **OpenRouter markup.** OpenRouter adds a small percentage. The numbers above already include the markup at roughly the right scale.
- **Screenshot size.** A 4K screenshot is several times more tokens than a 1280x900. Default to the smaller resolution.
- **Retry on flake.** The harness retries failed steps once for flake-resistance. Budget 1.2x your headline cost.
- **First-month learning runs.** You will run the harness many times in week one as you tune locators and journey structure. Budget 5-10x the steady-state number for the first month.
- **OCR or other paid LLM features in the app itself.** If the journey exercises a paid feature (image OCR, image generation, etc.), the *app's* costs add up too. Use a QA mode that bypasses the paid feature when possible.

## Free-tier exit signals

If the math says the harness costs more than the engineering time it saves, stop. The harness is a tool, not a religion. Signals to pull back:

- Findings are 95% false positive. Tune or reduce models.
- The same flake recurs every night and no one investigates. Reduce frequency or fix the flake.
- The team stops reading the reports. Either the reports are not useful or the team is wrong. Investigate which.
