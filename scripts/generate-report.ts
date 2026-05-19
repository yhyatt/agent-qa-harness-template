/**
 * STUB - final report generator.
 *
 * NOT YET IMPLEMENTED. Spec below.
 *
 * What this script does (when implemented):
 *
 *   1. Reads .qa-runs/<latest>/findings.deduped.json
 *   2. Renders a markdown report grouped by:
 *        - Status (fail / disagreement / partial / pass)
 *        - Severity (HIGH first)
 *        - Journey
 *   3. Embeds screenshots as relative links
 *   4. Includes per-model judgment columns for the disagreement section
 *   5. Includes run metadata (target URL, git SHA, timestamp, model set)
 *   6. Writes .qa-runs/<run>/REPORT.final.md
 *
 * Report template (from docs/PHILOSOPHY.md, refined):
 *
 *   # QA run: <timestamp>
 *   Target: <url>
 *   Build: <git sha>
 *   Models: <comma-sep list>
 *
 *   ## Summary
 *   - <JN>: <status> (<duration>, <finding count>, <agreement %>)
 *   ...
 *
 *   ## Disagreements
 *   ### <severity>: <title>
 *   - Step: <step_id>
 *   - Models pass: <list>
 *   - Models fail: <list>
 *   - Judgments:
 *     - <model>: <judgment>
 *     ...
 *
 *   ## High-severity findings (unanimous or partial)
 *   ### HIGH: <title>
 *   - <standard finding block, see helpers.ts writeReport>
 *
 *   ## Medium-severity findings
 *   ...
 *
 *   ## Low-severity findings
 *   ...
 *
 *   ## Axe a11y per-surface summary
 *   ...
 *
 *   ## Stats
 *   - Total raw findings: N
 *   - After dedup: M
 *   - Agreement rate: X%
 *   - Per-model finding counts: ...
 *
 * Implementation notes:
 *
 *   - Use the same em-dash-free style as the rest of the harness
 *     (see AGENTS.md style guide)
 *   - Screenshot paths should be repo-relative so the report renders
 *     correctly when opened in a markdown previewer
 *   - For large screenshot sets, link to the directory rather than
 *     embedding every image
 *   - The report is consumed by humans; optimize for skimmability
 *     (HIGH findings first, easy headings, short blocks)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

async function main() {
  // TODO: implement per the spec above.
  console.error(
    'generate-report.ts: not yet implemented. See the script comment for the spec.',
  );
  process.exit(2);
}

main();

void fs;
void path;
