/**
 * Unit tests for the globalTeardown report-aggregation slice:
 *
 *   - writeProjectSidecar persists one project's results and axe surfaces to
 *     a JSON sidecar under PARTIALS_DIR, stamping `project` onto every
 *     JourneyResult and every StepFinding nested inside it.
 *   - aggregateRunReport reads every sidecar under PARTIALS_DIR and merges
 *     them into ONE combined findings.json / REPORT.md. Two projects that
 *     each report a finding with the identical journey_id/step_id/title
 *     both survive (no last-writer clobber), each tagged with its own
 *     project.
 *   - Because dedup-findings.ts now folds `project` into the dedup key, the
 *     two same-titled findings above would no longer collapse into one
 *     during dedup once they carry different projects.
 *   - Zero sidecars: aggregateRunReport writes no findings.json, preserving
 *     the "no journeys ran" discovery signal the dispatcher's latest-run
 *     scan depends on.
 *
 * QA_RUN_DIR must be set BEFORE helpers.ts is imported: module-level code in
 * helpers.ts resolves RUN_DIR / PARTIALS_DIR from process.env.QA_RUN_DIR at
 * import time. ESM static imports are hoisted ahead of any other
 * module-level statement, so this file sets the env var first and then uses
 * a dynamic import inside beforeAll, adapting the temp-run-dir pattern used
 * by tests/unit/dispatch-hygiene.test.ts (there, QA_RUN_DIR is threaded into
 * a subprocess env; here, the run happens in-process so the import itself
 * must be deferred).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { JourneyResult } from '../e2e/journeys/helpers.js';

let tmpRoot: string;
let helpers: typeof import('../e2e/journeys/helpers.js');

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-report-aggregation-test-'));
  process.env.QA_RUN_DIR = tmpRoot;
  helpers = await import('../e2e/journeys/helpers.js');
});

afterAll(async () => {
  delete process.env.QA_RUN_DIR;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// Clear PARTIALS_DIR and any previously written combined report before each
// test, so the zero-sidecar test does not inherit sidecars or a findings.json
// left over from an earlier test in this file.
beforeEach(async () => {
  const entries = await fs.readdir(helpers.PARTIALS_DIR).catch(() => []);
  await Promise.all(
    entries.map((e) => fs.rm(path.join(helpers.PARTIALS_DIR, e), { force: true })),
  );
  await fs.rm(helpers.JSON_FINDINGS_PATH, { force: true });
  await fs.rm(helpers.REPORT_PATH, { force: true });
});

function makeSameFindingResult(): JourneyResult {
  const finding = helpers.makeFinding({
    step_id: 'J1/01',
    journey_id: 'J1',
    step_name: '01-landed',
    action: 'navigate to authed home',
    severity: 'INFO',
    bucket: 'pass',
    title: 'authed landing rendered',
    judgment: 'Page rendered.',
  });
  return {
    id: 'J1',
    status: 'pass',
    durationMs: 1200,
    findings: [finding],
  };
}

describe('report aggregation across Playwright projects', () => {
  it('merges per-project sidecars into one combined findings.json with no finding loss', async () => {
    await helpers.writeProjectSidecar('chromium-desktop', 0, [makeSameFindingResult()], []);
    await helpers.writeProjectSidecar('mobile-iphone-13', 1, [makeSameFindingResult()], []);

    await helpers.aggregateRunReport('http://127.0.0.1:0');

    const text = await fs.readFile(helpers.JSON_FINDINGS_PATH, 'utf-8');
    const combined = JSON.parse(text) as {
      results: Array<{ id: string; status: string; durationMs: number; finding_count: number; project?: string }>;
      findings: Array<{ journey_id: string; step_id: string; title: string; project?: string }>;
    };

    // (a) both projects' findings survive; no last-writer clobber.
    expect(combined.findings.length).toBe(2);

    // (b) each finding carries the correct project.
    expect(combined.findings.map((f) => f.project).sort()).toEqual([
      'chromium-desktop',
      'mobile-iphone-13',
    ]);

    // (c) results contains both projects' journeys.
    expect(combined.results.length).toBe(2);
    expect(combined.results.map((r) => r.project).sort()).toEqual([
      'chromium-desktop',
      'mobile-iphone-13',
    ]);

    // (d) the two findings share journey_id/step_id/title but differ on
    // project, which is exactly what dedup-findings.ts now folds into the
    // dedup key tuple (journey_id|step_id|severityBucket|project|title) to
    // keep them from collapsing into one during dedup.
    const [f1, f2] = combined.findings;
    expect(f1.journey_id).toBe(f2.journey_id);
    expect(f1.step_id).toBe(f2.step_id);
    expect(f1.title).toBe(f2.title);
    expect(f1.project).not.toBe(f2.project);

    // The combined markdown groups by project instead of one project
    // overwriting the other's section.
    const markdown = await fs.readFile(helpers.REPORT_PATH, 'utf-8');
    expect(markdown).toContain('## Project: chromium-desktop');
    expect(markdown).toContain('## Project: mobile-iphone-13');
  });

  it('writes no findings.json when PARTIALS_DIR has zero sidecars', async () => {
    await helpers.aggregateRunReport('http://127.0.0.1:0');

    await expect(fs.access(helpers.JSON_FINDINGS_PATH)).rejects.toThrow();
    await expect(fs.access(helpers.REPORT_PATH)).rejects.toThrow();
  });
});
