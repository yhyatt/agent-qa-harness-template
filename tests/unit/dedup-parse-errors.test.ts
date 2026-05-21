/**
 * Unit test for the new per_model_parse_error_counts stat.
 *
 * dedup-findings.ts is a CLI; we exercise it by writing a synthetic
 * findings.dispatched.json into a temp QA run directory, invoking the
 * script with QA_RUN_DIR pointing at it, and parsing the resulting
 * findings.deduped.json.
 *
 * Scenario: 3 models, 1 finding. Two models flake (judgment.error set);
 * one model returns a valid pass=false judgment. Expected:
 *   - per_model_parse_error_counts shows {flake-a: 1, flake-b: 1, ok: 0}
 *     seeded for every model in meta.models, sorted alphabetically.
 *   - agreement_rate reflects only the one valid voter (rate = 1.0 since
 *     the lone voter agrees with itself).
 *   - per_model_finding_counts shows {ok: 1, flake-a: 0, flake-b: 0}
 *     (the two flake models contribute nothing because their judgments
 *     errored).
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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-dedup-test-'));
  runDir = path.join(tmpRoot, '2026-05-21-12-00');
  await fs.mkdir(runDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeFinding(overrides: Partial<StepFinding> = {}): StepFinding {
  return {
    step_id: 'J1/01',
    journey_id: 'J1',
    step_name: 'land-on-home',
    action: 'navigate to /',
    severity: 'MEDIUM',
    bucket: 'cosmetic',
    title: 'header text mismatch',
    locale_snapshot: [],
    db_state: null,
    console_errors: [],
    network_failures: [],
    axe_violations: 0,
    axe_top3: [],
    judgment: 'Tentative finding from playwright.',
    ...overrides,
  };
}

function makeJudgment(model: string, finding: StepFinding, opts: { error?: string; pass?: boolean } = {}): ModelJudgment {
  if (opts.error) {
    return {
      step_id: finding.step_id,
      model,
      pass: true,
      severity: 'INFO',
      bucket: 'flake',
      judgment: 'Dispatch parse error.',
      concerns: ['parse failed after retry'],
      confidence: 0,
      error: opts.error,
      raw: '{"bad json',
    };
  }
  return {
    step_id: finding.step_id,
    model,
    pass: opts.pass ?? true,
    severity: 'MEDIUM',
    bucket: 'cosmetic',
    judgment: 'Real judgment from this model.',
    concerns: opts.pass === false ? ['some concrete concern'] : [],
    confidence: 0.7,
  };
}

describe('dedup per_model_parse_error_counts', () => {
  it('counts errored judgments per model and seeds non-erroring models to 0', async () => {
    const finding = makeFinding();
    const dispatched: DispatchedRun = {
      meta: {
        run_id: '2026-05-21-12-00',
        timestamp: '2026-05-21T12:00:00Z',
        target: 'https://example.com',
        build: 'test',
        // intentionally unsorted to verify the dedup script sorts internally
        models: ['ok', 'flake-b', 'flake-a'],
        skipped: [],
      },
      findings: [
        {
          ...finding,
          model_judgments: {
            'flake-a': makeJudgment('flake-a', finding, { error: 'parse failed after retry: bad json' }),
            'flake-b': makeJudgment('flake-b', finding, { error: 'parse failed after retry: missing keys' }),
            'ok': makeJudgment('ok', finding, { pass: false }),
          },
        },
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

    // Parse-error counts: seeded for every model, errored models incremented.
    expect(deduped.stats.per_model_parse_error_counts).toEqual({
      'flake-a': 1,
      'flake-b': 1,
      'ok': 0,
    });

    // Sorted alphabetically (verifies the sort step in dedup-findings.ts).
    expect(Object.keys(deduped.stats.per_model_parse_error_counts)).toEqual([
      'flake-a',
      'flake-b',
      'ok',
    ]);

    // Per-model fail counts: only the non-erroring voter contributes, and it
    // returned pass=false, so its count is 1. The two flake models stay at 0.
    expect(deduped.stats.per_model_finding_counts).toEqual({
      'flake-a': 0,
      'flake-b': 0,
      'ok': 1,
    });

    // Per-model total judgments: every model returned exactly one judgment
    // for the single finding (the two flake models returned errored
    // judgments, ok returned a valid one). All three should be 1.
    expect(deduped.stats.per_model_total_judgments).toEqual({
      'flake-a': 1,
      'flake-b': 1,
      'ok': 1,
    });

    // Agreement: only one valid voter, who agrees with itself. total_raw=1,
    // agreed_pairs=1, agreement_rate=1.
    expect(deduped.stats.total_raw).toBe(1);
    expect(deduped.stats.agreement_rate).toBe(1);

    // The one finding lands in unanimous (n=1, all-pass-or-all-fail trivially).
    expect(deduped.unanimous_findings.length).toBe(1);
    expect(deduped.partial_findings.length).toBe(0);
    expect(deduped.disagreements.length).toBe(0);
  }, 30_000);
});
