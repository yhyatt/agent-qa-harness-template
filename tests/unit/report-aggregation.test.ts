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
 *   - sanitizeSegment never returns a path-traversal segment and is injective
 *     for names that required sanitizing (no two distinct originals collide).
 *   - clearRunOutputs removes stale sidecars AND the top-level
 *     findings.json / REPORT.md (globalSetup uses it so a rerun into a reused
 *     RUN_DIR neither resurrects an old project nor serves a stale report).
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
import type { JourneyResult, AxeSurface } from '../e2e/journeys/helpers.js';

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

describe('sanitizeSegment path safety and injectivity', () => {
  it('leaves already-safe names unchanged', () => {
    expect(helpers.sanitizeSegment('chromium-desktop')).toBe('chromium-desktop');
    expect(helpers.sanitizeSegment('mobile-iphone-13')).toBe('mobile-iphone-13');
    // Dots inside an otherwise valid name survive (e.g. a version tag).
    expect(helpers.sanitizeSegment('v1.2')).toBe('v1.2');
  });

  it('does not collapse distinct names that clean to the same segment', () => {
    // 'a/b', 'a b', and 'a-b' all naively clean to 'a-b'. Only the already
    // safe 'a-b' is returned verbatim; the others get a hash suffix, so no
    // two distinct originals share a segment (no last-writer clobber).
    const slash = helpers.sanitizeSegment('a/b');
    const space = helpers.sanitizeSegment('a b');
    const safe = helpers.sanitizeSegment('a-b');

    expect(safe).toBe('a-b');
    expect(slash).not.toBe(safe);
    expect(space).not.toBe(safe);
    expect(slash).not.toBe(space);
    // The sanitized variants still start from the cleaned base.
    expect(slash.startsWith('a-b-')).toBe(true);
    expect(space.startsWith('a-b-')).toBe(true);
  });

  it('makes dot-only and empty names safe and mutually distinct', () => {
    const dot = helpers.sanitizeSegment('.');
    const dotdot = helpers.sanitizeSegment('..');
    const dotdotdot = helpers.sanitizeSegment('...');
    const empty = helpers.sanitizeSegment('');

    // None is a bare dot-run or empty (would escape the run dir).
    for (const seg of [dot, dotdot, dotdotdot, empty]) {
      expect(seg).not.toBe('');
      expect(/^\.+$/.test(seg)).toBe(false);
      expect(seg.startsWith('_-')).toBe(true);
    }
    // All four are mutually distinct.
    expect(new Set([dot, dotdot, dotdotdot, empty]).size).toBe(4);
  });

  it('is deterministic for the same input', () => {
    expect(helpers.sanitizeSegment('a/b')).toBe(helpers.sanitizeSegment('a/b'));
  });
});

describe('clearRunOutputs', () => {
  it('removes stale sidecars and the top-level findings.json / REPORT.md', async () => {
    // Seed a full prior-run output set: a sidecar plus both top-level files.
    await helpers.writeProjectSidecar('stale-project', 7, [makeSameFindingResult()], []);
    await fs.writeFile(helpers.JSON_FINDINGS_PATH, '{"run_id":"stale"}');
    await fs.writeFile(helpers.REPORT_PATH, '# stale report\n');

    // Sanity: all three exist before the clear.
    const before = await fs.readdir(helpers.PARTIALS_DIR);
    expect(before.some((f) => f.endsWith('.json'))).toBe(true);
    await expect(fs.access(helpers.JSON_FINDINGS_PATH)).resolves.toBeUndefined();
    await expect(fs.access(helpers.REPORT_PATH)).resolves.toBeUndefined();

    helpers.clearRunOutputs();

    // All three are gone.
    const after = await fs.readdir(helpers.PARTIALS_DIR);
    expect(after.some((f) => f.endsWith('.json'))).toBe(false);
    await expect(fs.access(helpers.JSON_FINDINGS_PATH)).rejects.toThrow();
    await expect(fs.access(helpers.REPORT_PATH)).rejects.toThrow();
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
