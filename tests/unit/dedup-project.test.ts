/**
 * Unit test for the `project` axis of the dedup key (ADR-016).
 *
 * A combined multi-project run holds two findings that share
 * journey_id/step_id/severity/title but come from different Playwright
 * projects (e.g. chromium-desktop and mobile-iphone-13, whose stub journey
 * titles are project-agnostic by design). Before `project` was folded into
 * the dedup key and the cross-severity map, these two would either collapse
 * into one dedup entry or be mislabeled as a cross-severity collision. This
 * test pins both behaviors:
 *
 *   - the two findings survive dedup as TWO distinct entries (no collapse),
 *     each with its own project-derived dedup_key;
 *   - neither carries a spurious cross_severity_warning (the cross-severity
 *     map is keyed on (project, step_id), so same-step/different-project
 *     findings are not siblings).
 *
 * Exercised the same way as dedup-parse-errors.test.ts: write a synthetic
 * findings.dispatched.json into a temp run dir, run dedup-findings.ts against
 * it, and parse findings.deduped.json.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DispatchedRun, DedupedRun, ModelJudgment } from '../../scripts/types.js';
import type { StepFinding } from '../../tests/e2e/journeys/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEDUP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'dedup-findings.ts');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

let tmpRoot: string;
let runDir: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-dedup-project-test-'));
  runDir = path.join(tmpRoot, '2026-05-21-12-00');
  await fs.mkdir(runDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// Identical finding shape except for `project`. Everything the dedup key
// hashes (journey_id, step_id, severity, title) is the same; only project
// differs, which is the axis under test.
function makeFinding(project: string): StepFinding {
  return {
    step_id: 'J1/01',
    journey_id: 'J1',
    step_name: '01-landed',
    action: 'navigate to authed home',
    severity: 'INFO',
    bucket: 'pass',
    title: 'authed landing rendered',
    locale_snapshot: [],
    db_state: null,
    console_errors: [],
    network_failures: [],
    axe_violations: 0,
    axe_top3: [],
    judgment: 'Page rendered.',
    project,
  };
}

function makeJudgment(model: string, finding: StepFinding): ModelJudgment {
  return {
    step_id: finding.step_id,
    model,
    pass: true,
    severity: 'INFO',
    bucket: 'pass',
    judgment: 'Looks fine.',
    concerns: [],
    confidence: 0.9,
  };
}

describe('dedup keeps same-step findings from different projects distinct', () => {
  it('does not collapse or cross-severity-warn two projects sharing a step_id', async () => {
    const desktop = makeFinding('chromium-desktop');
    const mobile = makeFinding('mobile-iphone-13');

    const dispatched: DispatchedRun = {
      meta: {
        run_id: '2026-05-21-12-00',
        timestamp: '2026-05-21T12:00:00Z',
        target: 'https://example.com',
        harness_sha: 'test',
        target_deployment: null,
        models: ['m1'],
        skipped: [],
      },
      findings: [
        { ...desktop, model_judgments: { m1: makeJudgment('m1', desktop) } },
        { ...mobile, model_judgments: { m1: makeJudgment('m1', mobile) } },
      ],
      dispatch_errors: [],
    };

    await fs.writeFile(
      path.join(runDir, 'findings.dispatched.json'),
      JSON.stringify(dispatched, null, 2),
    );

    const result = spawnSync(TSX_BIN, [DEDUP_SCRIPT], {
      env: { ...process.env, QA_RUN_DIR: runDir },
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(
        `dedup script exited ${result.status}: stdout=${result.stdout} stderr=${result.stderr}`,
      );
    }

    const dedupedText = await fs.readFile(path.join(runDir, 'findings.deduped.json'), 'utf8');
    const deduped = JSON.parse(dedupedText) as DedupedRun;

    // Both findings survive as two distinct unanimous entries (no collapse).
    expect(deduped.unanimous_findings.length).toBe(2);
    expect(deduped.partial_findings.length).toBe(0);
    expect(deduped.disagreements.length).toBe(0);

    // Each entry carries its own project.
    expect(deduped.unanimous_findings.map((f) => f.project).sort()).toEqual([
      'chromium-desktop',
      'mobile-iphone-13',
    ]);

    // The two dedup keys differ precisely because project is in the tuple.
    const keys = deduped.unanimous_findings.map((f) => f.dedup_key);
    expect(new Set(keys).size).toBe(2);

    // Neither finding is mislabeled as a cross-severity collision: the
    // cross-severity map is keyed on (project, step_id), so same-step
    // different-project findings are not siblings.
    for (const f of deduped.unanimous_findings) {
      expect(f.cross_severity_warning).toBeUndefined();
    }
  }, 30_000);
});
