/**
 * Unit test for project attribution in the final post-dedup report
 * (scripts/generate-report.ts -> REPORT.final.md), ADR-016.
 *
 * Now that cross-project findings survive dedup as distinct entries (they
 * share journey_id/step_id/title but differ by project), the final report
 * that the human consumer reads must surface `project` on each finding and in
 * the per-journey summary, otherwise desktop vs mobile J1-J3 (whose stub
 * titles are project-agnostic) are indistinguishable to the reader.
 *
 * Exercised like the dedup/dispatch tests: write a synthetic
 * findings.deduped.json into a temp run dir, run generate-report.ts against
 * it, and read REPORT.final.md.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DedupedRun, DedupedFinding, ModelJudgment } from '../../scripts/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GENERATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'generate-report.ts');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

let tmpRoot: string;
let runDir: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-genreport-project-test-'));
  runDir = path.join(tmpRoot, '2026-05-21-12-00');
  await fs.mkdir(runDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function judgment(model: string): ModelJudgment {
  return {
    step_id: 'J1/01',
    model,
    pass: false,
    severity: 'MEDIUM',
    bucket: 'cosmetic',
    judgment: 'Header copy is off.',
    concerns: ['copy mismatch'],
    confidence: 0.8,
  };
}

// Two MEDIUM findings sharing journey_id/step_id/title, distinguished only by
// project. MEDIUM renders via the full (non-compact) finding body.
function finding(project: string, dedupKey: string): DedupedFinding {
  return {
    step_id: 'J1/01',
    journey_id: 'J1',
    step_name: '01-landed',
    action: 'navigate to authed home',
    severity: 'MEDIUM',
    bucket: 'cosmetic',
    title: 'header text mismatch',
    locale_snapshot: [],
    db_state: null,
    console_errors: [],
    network_failures: [],
    axe_violations: 0,
    axe_top3: [],
    judgment: 'Header copy is off.',
    project,
    model_judgments: { m1: judgment('m1') },
    dedup_key: dedupKey,
    fail_count: 1,
    total_count: 1,
  };
}

describe('generate-report surfaces project attribution', () => {
  it('renders project per finding and per summary row', async () => {
    const deduped: DedupedRun = {
      meta: {
        run_id: '2026-05-21-12-00',
        timestamp: '2026-05-21T12:00:00Z',
        target: 'https://example.com',
        harness_sha: 'test',
        target_deployment: null,
        models: ['m1'],
        skipped: [],
      },
      unanimous_findings: [
        finding('chromium-desktop', 'aaaaaaaaaaaa'),
        finding('mobile-iphone-13', 'bbbbbbbbbbbb'),
      ],
      partial_findings: [],
      disagreements: [],
      stats: {
        total_raw: 2,
        after_dedup: 2,
        agreement_rate: 1,
        per_model_finding_counts: { m1: 2 },
        per_model_parse_error_counts: { m1: 0 },
        per_model_total_judgments: { m1: 2 },
        dispatch_error_count: 0,
        warning: 'single-model run',
      },
      dispatch_errors: [],
    };

    await fs.writeFile(
      path.join(runDir, 'findings.deduped.json'),
      JSON.stringify(deduped, null, 2),
    );

    const result = spawnSync(TSX_BIN, [GENERATE_SCRIPT], {
      env: { ...process.env, QA_RUN_DIR: runDir },
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(
        `generate-report exited ${result.status}: stdout=${result.stdout} stderr=${result.stderr}`,
      );
    }

    const report = await fs.readFile(path.join(runDir, 'REPORT.final.md'), 'utf8');

    // Both projects are named in the report body.
    expect(report).toContain('chromium-desktop');
    expect(report).toContain('mobile-iphone-13');

    // Each finding block carries a Project line (one per project).
    const projectLines = report.split('\n').filter((l) => l.startsWith('- Project: '));
    expect(projectLines).toContain('- Project: chromium-desktop');
    expect(projectLines).toContain('- Project: mobile-iphone-13');

    // The per-journey summary distinguishes the two same-journey rows by
    // project, so J1 appears once per project rather than collapsed to one.
    expect(report).toContain('- J1 [chromium-desktop]:');
    expect(report).toContain('- J1 [mobile-iphone-13]:');
  }, 30_000);
});
