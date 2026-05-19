/**
 * STUB - multi-model dispatcher.
 *
 * NOT YET IMPLEMENTED. This is a structural shell describing what the
 * finished script will do. Filling this in is slice-14-proper work in
 * the first consuming project (Ballpark). After it hardens there,
 * port the implementation back here.
 *
 * What this script does (when implemented):
 *
 *   1. Reads .qa-runs/<latest>/findings.json (produced by the Playwright run)
 *   2. For each finding, dispatches the per-step JSON to N models in parallel
 *      via Promise.allSettled (see docs/ANTI-PATTERNS.md #6)
 *   3. Each model receives:
 *        - the structured JSON for the step
 *        - the screenshot (as a base64 image content block)
 *        - the locale snapshot
 *        - a system prompt asking for a structured judgment
 *   4. Each model returns a JSON object conforming to the per-step schema
 *      with `model` filled in, `judgment` rewritten, `severity`/`bucket`
 *      potentially adjusted.
 *   5. Aggregates all model outputs back into one combined findings.json
 *      with a per-finding `model_judgments: { [model]: judgment }` map.
 *
 * Dispatch matrix (the default; configurable via env):
 *
 *   Tier        | Provider     | Use case
 *   ------------|--------------|--------------------------------------------
 *   Haiku 4.5   | Anthropic    | Cheap parallel sweep, every PR
 *   Sonnet 4.6  | Anthropic    | Standard baseline, every nightly run
 *   Opus 4.7    | Anthropic    | Hard cases (phase transitions, ambiguity)
 *   Gemini 2.5  | OpenRouter   | Cross-provider second opinion
 *   GPT-5       | OpenRouter   | Cross-provider second opinion (alt)
 *
 * Cost: see docs/COST-MODEL.md. Roughly $8 per full-suite multi-model run.
 *
 * Env vars consumed:
 *   ANTHROPIC_API_KEY        required for any Anthropic tier
 *   OPENROUTER_API_KEY       required for any non-Anthropic model
 *   QA_RUN_DIR               which .qa-runs/* directory to process (default: latest)
 *   QA_MODELS                comma-separated list, e.g. "haiku-4-5,sonnet-4-6,gemini-2-5-pro"
 *   QA_DISPATCH_CONCURRENCY  parallelism cap per provider (default: 4)
 *
 * Expected per-model output shape (each model must return exactly this):
 *
 *   interface ModelJudgment {
 *     step_id: string;             // must match the input step_id
 *     model: string;               // e.g. "claude-sonnet-4-6"
 *     pass: boolean;
 *     severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
 *     bucket: 'pass' | 'blocking' | 'cosmetic' | 'flake';
 *     judgment: string;            // free-form prose, target ~150 words
 *     concerns: string[];          // bullet list of specific issues
 *     confidence: number;          // 0..1
 *   }
 *
 * Provider abstraction:
 *
 *   - Anthropic models go through @anthropic-ai/sdk (direct, supports caching)
 *   - All other models go through openai SDK pointed at openrouter.ai/api/v1
 *   - Both share a `dispatch(model: string, input: StepInput): Promise<ModelJudgment>` interface
 *
 * Implementation skeleton (TODO: fill in):
 *
 *   async function dispatchAll(findings: StepFinding[], models: string[]) {
 *     const tasks = findings.flatMap(f =>
 *       models.map(m => dispatch(m, f).then(j => ({ finding: f, judgment: j })))
 *     );
 *     const results = await Promise.allSettled(tasks);
 *     // group by finding.step_id; attach all model_judgments
 *     // write back to findings.json with model_judgments populated
 *   }
 *
 * Outputs:
 *   .qa-runs/<run>/findings.dispatched.json
 *   .qa-runs/<run>/REPORT.dispatched.md   (markdown rendering with per-model columns)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

async function main() {
  // TODO: implement per the spec above.
  console.error(
    'multi-model-dispatch.ts: not yet implemented. See the script comment for the spec.',
  );
  process.exit(2);
}

main();

// Suppress unused-import lint until implementation lands.
void fs;
void path;
