/**
 * STUB - cross-model finding dedup.
 *
 * NOT YET IMPLEMENTED. Spec below.
 *
 * What this script does (when implemented):
 *
 *   1. Reads .qa-runs/<latest>/findings.dispatched.json
 *   2. Groups findings by dedup key
 *   3. Collapses agreeing findings into a single canonical entry
 *      with a `models: string[]` field listing which models agreed
 *   4. Surfaces disagreements (same finding key, different judgments)
 *      as their own report section
 *   5. Writes a consolidated findings.deduped.json
 *
 * Dedup key:
 *
 *   The key is a tuple, hashed together:
 *     (journey_id, step_id, severity_bucket, normalized_title)
 *
 *   `normalized_title` strips punctuation, lowercases, and collapses
 *   whitespace. Two model outputs that flag "Toast missing" and
 *   "toast missing." should dedup to one finding.
 *
 *   `severity_bucket` is HIGH/MEDIUM/LOW/INFO (the four-tier bucket,
 *   not finer-grained severity).
 *
 * Disagreement detection:
 *
 *   Two cases surface as disagreement:
 *
 *   a) Same dedup key, different model_judgments.pass values.
 *      Model A says pass, Model B says fail. The finding goes to
 *      a "disagreements" section with both judgments visible.
 *
 *   b) Finding present in N-1 of N models. Model A and B flag it;
 *      Model C did not. Could be a real bug A and B caught, or a
 *      false positive A and B share. Surface as "partial agreement"
 *      (less alarming than full disagreement, but worth a look).
 *
 * Output:
 *
 *   .qa-runs/<run>/findings.deduped.json
 *
 *   {
 *     "unanimous_findings": [ ... ],     // all models agreed
 *     "partial_findings": [ ... ],       // missed by at least one
 *     "disagreements": [ ... ],          // models contradicted each other
 *     "stats": {
 *       "total_raw": N,
 *       "after_dedup": M,
 *       "agreement_rate": 0.X
 *     }
 *   }
 *
 * Why this matters (see docs/ANTI-PATTERNS.md #4):
 *
 *   - Suppressing minority opinions loses signal
 *   - Auto-creating an issue per finding floods the queue with duplicates
 *   - Dedup is the load-bearing step that makes multi-model dispatch tractable
 *
 * Hash function (suggested):
 *
 *   import { createHash } from 'node:crypto';
 *   function key(f: StepFinding): string {
 *     const norm = f.title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
 *     const tuple = [f.journey_id, f.step_id, severityBucket(f.severity), norm].join('|');
 *     return createHash('sha1').update(tuple).digest('hex').slice(0, 12);
 *   }
 *
 * Severity bucketing:
 *
 *   HIGH and HIGH dedup together
 *   MEDIUM and MEDIUM dedup together
 *   LOW and LOW dedup together
 *   INFO and INFO dedup together
 *   HIGH and MEDIUM do NOT dedup (different bucket = different finding)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

async function main() {
  // TODO: implement per the spec above.
  console.error(
    'dedup-findings.ts: not yet implemented. See the script comment for the spec.',
  );
  process.exit(2);
}

main();

void fs;
void path;
