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
 *   - A project that wrote a sidecar but produced zero JourneyResults still
 *     gets a section in the combined report (union-derived project list).
 *   - sanitizeSegment is traversal-safe: safe names pass through verbatim,
 *     disallowed chars map to a hyphen, and a dot-only or empty result is
 *     replaced with the placeholder `_`.
 *   - clearRunOutputs removes the run-stage output set (sidecars plus the run
 *     report findings.json / REPORT.md), so globalSetup wipes it at run start
 *     and a rerun into a reused RUN_DIR neither resurrects an old project nor
 *     serves a stale run report.
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

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { JourneyResult, AxeSurface } from '../e2e/journeys/helpers.js';

let tmpRoot: string;
let helpers: typeof import('../e2e/journeys/helpers.js');

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-report-aggregation-test-'));
  process.env.QA_RUN_DIR = tmpRoot;
  // helpers.ts resolves RUN_DIR / PARTIALS_DIR from QA_RUN_DIR at module-eval
  // time and caches them. Reset the module registry AFTER setting the env so
  // this import evaluates helpers fresh against our temp dir, and so a cached
  // helpers instance from another test in the same worker cannot leak its run
  // dir into ours (or vice versa), which would make the suite order-dependent.
  vi.resetModules();
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
  // Only a missing dir is an expected "nothing to clear" case; any other
  // errno (permissions, IO) is a real failure and must surface, matching the
  // product code (aggregateRunReport / clearRunOutputs).
  const entries = await fs.readdir(helpers.PARTIALS_DIR).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [] as string[];
    throw err;
  });
  await Promise.all(
    entries.map((e) => fs.rm(path.join(helpers.PARTIALS_DIR, e), { force: true })),
  );
  // Remove the run-stage artifacts so no test inherits one from an earlier
  // test in the same worker (the run dir is shared across this file's tests).
  await Promise.all(
    [helpers.JSON_FINDINGS_PATH, helpers.REPORT_PATH].map((p) => fs.rm(p, { force: true })),
  );
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

  it('renders a section for a project whose sidecar produced zero results', async () => {
    // chromium-desktop has one result; mobile-iphone-13 wrote a sidecar but
    // produced zero JourneyResults (only an axe surface). The mobile project
    // must still appear in the combined report rather than silently vanishing.
    const mobileAxe: AxeSurface = {
      route: '/',
      project: 'mobile-iphone-13',
      violations: 0,
      top3: [],
    };
    await helpers.writeProjectSidecar('chromium-desktop', 0, [makeSameFindingResult()], []);
    await helpers.writeProjectSidecar('mobile-iphone-13', 1, [], [mobileAxe]);

    await helpers.aggregateRunReport('http://127.0.0.1:0');

    const markdown = await fs.readFile(helpers.REPORT_PATH, 'utf-8');
    // Both projects get a section even though mobile has zero results.
    expect(markdown).toContain('## Project: chromium-desktop');
    expect(markdown).toContain('## Project: mobile-iphone-13');

    const text = await fs.readFile(helpers.JSON_FINDINGS_PATH, 'utf-8');
    const combined = JSON.parse(text) as {
      results: Array<{ project?: string }>;
      findings: Array<{ project?: string }>;
      axe_surfaces: Array<{ project: string }>;
    };
    // Only desktop contributed a result/finding; mobile contributed the axe
    // surface that keeps it visible.
    expect(combined.findings.length).toBe(1);
    expect(combined.findings[0]!.project).toBe('chromium-desktop');
    expect(combined.results.map((r) => r.project)).toEqual(['chromium-desktop']);
    expect(combined.axe_surfaces.map((s) => s.project)).toEqual(['mobile-iphone-13']);
  });
});

describe('sanitizeSegment path safety', () => {
  it('leaves already-safe names unchanged', () => {
    expect(helpers.sanitizeSegment('chromium-desktop')).toBe('chromium-desktop');
    expect(helpers.sanitizeSegment('mobile-iphone-13')).toBe('mobile-iphone-13');
    // Dots inside an otherwise valid name survive (e.g. a version tag).
    expect(helpers.sanitizeSegment('v1.2')).toBe('v1.2');
  });

  it('maps disallowed characters to a hyphen', () => {
    expect(helpers.sanitizeSegment('a/b')).toBe('a-b');
    expect(helpers.sanitizeSegment('a b')).toBe('a-b');
  });

  it('replaces dot-only and empty names with the placeholder _', () => {
    expect(helpers.sanitizeSegment('.')).toBe('_');
    expect(helpers.sanitizeSegment('..')).toBe('_');
    expect(helpers.sanitizeSegment('...')).toBe('_');
    expect(helpers.sanitizeSegment('')).toBe('_');
  });

  it('is deterministic for the same input', () => {
    expect(helpers.sanitizeSegment('a/b')).toBe(helpers.sanitizeSegment('a/b'));
  });
});

describe('clearRunOutputs', () => {
  it('removes the run-stage output set: sidecars plus findings.json / REPORT.md', async () => {
    // Seed a prior-run output set: a sidecar plus the run-stage report.
    await helpers.writeProjectSidecar('stale-project', 7, [makeSameFindingResult()], []);
    const topLevel = [helpers.JSON_FINDINGS_PATH, helpers.REPORT_PATH];
    for (const p of topLevel) {
      await fs.writeFile(p, '{"run_id":"stale"}');
    }

    // Sanity: the sidecar and both run-stage files exist before the clear.
    const before = await fs.readdir(helpers.PARTIALS_DIR);
    expect(before.some((f) => f.endsWith('.json'))).toBe(true);
    for (const p of topLevel) {
      await expect(fs.access(p)).resolves.toBeUndefined();
    }

    helpers.clearRunOutputs();

    // The sidecar and both run-stage files are gone.
    const after = await fs.readdir(helpers.PARTIALS_DIR);
    expect(after.some((f) => f.endsWith('.json'))).toBe(false);
    for (const p of topLevel) {
      await expect(fs.access(p)).rejects.toThrow();
    }
  });

  it('leaves no stale findings.json after a zero-sidecar rerun into a reused dir', async () => {
    // Simulate a reused run dir that still holds a prior run's report, then a
    // rerun that matches no journeys (zero sidecars). clearRunOutputs at run
    // start plus aggregateRunReport writing nothing must leave no marker.
    await fs.writeFile(helpers.JSON_FINDINGS_PATH, '{"run_id":"stale"}');
    await fs.writeFile(helpers.REPORT_PATH, '# stale report\n');

    helpers.clearRunOutputs();
    await helpers.aggregateRunReport('http://127.0.0.1:0');

    await expect(fs.access(helpers.JSON_FINDINGS_PATH)).rejects.toThrow();
    await expect(fs.access(helpers.REPORT_PATH)).rejects.toThrow();
  });
});
