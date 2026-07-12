/**
 * Unit tests for the dispatch-hygiene slice (slice 2):
 *
 *   - hasAuthFixture rejects missing files, empty cookies/origins, and
 *     malformed JSON, returning false in each case.
 *   - The dispatcher skips auth-blocked placeholder findings (severity INFO,
 *     bucket pass, title matching the auth-blocked regex). Real INFO findings
 *     with unrelated titles still dispatch.
 *   - axe_violations: null renders as "not scanned" through the dispatch
 *     prompt and the helpers writeReport markdown path, distinctly from
 *     axe_violations: 0 ("scanned, no violations").
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasAuthFixture } from '../e2e/journeys/helpers.js';
import { renderStep } from '../../scripts/dispatch/prompt.js';
import type { DispatchedRun, SkippedFinding } from '../../scripts/types.js';
import type { StepFinding } from '../e2e/journeys/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DISPATCH_SCRIPT = path.join(REPO_ROOT, 'scripts', 'multi-model-dispatch.ts');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-hygiene-test-'));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeFinding(overrides: Partial<StepFinding> = {}): StepFinding {
  return {
    step_id: 'J1/01',
    journey_id: 'J1',
    step_name: 'auth-gate',
    action: 'placeholder',
    severity: 'MEDIUM',
    bucket: 'cosmetic',
    title: 'header text mismatch',
    locale_snapshot: [],
    db_state: null,
    console_errors: [],
    network_failures: [],
    axe_violations: null,
    axe_top3: [],
    judgment: 'tentative finding',
    ...overrides,
  };
}

describe('hasAuthFixture', () => {
  it('returns false when the file does not exist', () => {
    expect(hasAuthFixture(path.join(tmpRoot, 'missing.json'))).toBe(false);
  });

  it('returns false on empty cookies and empty origins', async () => {
    const p = path.join(tmpRoot, 'empty.json');
    await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
    expect(hasAuthFixture(p)).toBe(false);
  });

  it('returns true when origins is populated even if cookies is empty (JWT-in-localStorage auth)', async () => {
    const p = path.join(tmpRoot, 'origins-only.json');
    await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [{ origin: 'https://example.com', localStorage: [{ name: 'jwt', value: 'xyz' }] }] }));
    expect(hasAuthFixture(p)).toBe(true);
  });

  it('returns true when cookies is populated even if origins is empty (cookie-only session auth)', async () => {
    const p = path.join(tmpRoot, 'cookies-only.json');
    await fs.writeFile(p, JSON.stringify({ cookies: [{ name: 'session', value: 'abc' }], origins: [] }));
    expect(hasAuthFixture(p)).toBe(true);
  });

  it('returns false on malformed JSON without throwing', async () => {
    const p = path.join(tmpRoot, 'malformed.json');
    await fs.writeFile(p, '{not json');
    expect(hasAuthFixture(p)).toBe(false);
  });

  it('returns true when both cookies and origins are non-empty', async () => {
    const p = path.join(tmpRoot, 'populated.json');
    await fs.writeFile(
      p,
      JSON.stringify({
        cookies: [{ name: 'session', value: 'abc' }],
        origins: [{ origin: 'https://example.com' }],
      }),
    );
    expect(hasAuthFixture(p)).toBe(true);
  });
});

describe('renderStep axe_violations null handling', () => {
  it('prints "not scanned" when axe_violations is null', () => {
    const out = renderStep(makeFinding({ axe_violations: null }));
    expect(out).toContain('count: not scanned');
  });

  it('prints the count when axe_violations is 0', () => {
    const out = renderStep(makeFinding({ axe_violations: 0 }));
    expect(out).toContain('count: 0');
  });

  it('prints "scan failed" when axe_violations is -1', () => {
    const out = renderStep(makeFinding({ axe_violations: -1 }));
    expect(out).toContain('count: scan failed');
  });
});

describe('multi-model-dispatch skip rule', () => {
  it('skips auth-blocked placeholders, dispatches real findings', async () => {
    const runDir = path.join(tmpRoot, '2026-05-21-13-00');
    await fs.mkdir(runDir, { recursive: true });

    const authBlocked: StepFinding = makeFinding({
      step_id: 'J1/01',
      severity: 'INFO',
      bucket: 'pass',
      title: 'J1 auth-blocked: no fixture',
      judgment: 'Auth fixture not present.',
    });
    // Title matches the 'no code' branch directly. The template's own J2
    // placeholder uses 'J2 auth-blocked: no join code available' which is
    // covered by the 'auth-blocked' branch; this case exercises the 'no code'
    // branch independently in case a future journey leans on it.
    const noCode: StepFinding = makeFinding({
      step_id: 'J2/00',
      severity: 'INFO',
      bucket: 'pass',
      title: 'J2 skipped: no code available',
      judgment: 'no code available.',
    });
    const real: StepFinding = makeFinding({
      step_id: 'J3/01',
      severity: 'MEDIUM',
      bucket: 'cosmetic',
      title: 'header text mismatch',
    });
    // INFO/pass but title is unrelated to auth-blocked; must NOT be skipped.
    const realInfo: StepFinding = makeFinding({
      step_id: 'J4/01',
      severity: 'INFO',
      bucket: 'pass',
      title: 'landed on home',
    });

    await fs.writeFile(
      path.join(runDir, 'findings.json'),
      JSON.stringify({
        run_id: '2026-05-21-13-00',
        timestamp: '2026-05-21T13:00:00Z',
        target: 'https://example.com',
        harness_sha: 'test',
        target_deployment: null,
        results: [],
        findings: [authBlocked, noCode, real, realInfo],
        axe_surfaces: [],
      }),
    );

    const result = spawnSync(TSX_BIN, [DISPATCH_SCRIPT], {
      env: {
        ...process.env,
        QA_RUN_DIR: runDir,
        MOCK_DISPATCH: '1',
        QA_ALLOW_SINGLE_FAMILY: '1',
        QA_MODELS: 'mock-a,mock-b,mock-c',
      },
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(
        `dispatch script exited ${result.status}: stdout=${result.stdout} stderr=${result.stderr}`,
      );
    }

    // The stderr note announces the count of skipped findings.
    expect(result.stderr).toContain('skipped 2 auth-blocked findings');

    const dispatchedText = await fs.readFile(
      path.join(runDir, 'findings.dispatched.json'),
      'utf8',
    );
    const dispatched = JSON.parse(dispatchedText) as DispatchedRun;

    // Two findings dispatched (J3/01 and J4/01), two skipped.
    expect(dispatched.findings.length).toBe(2);
    expect(dispatched.findings.map((f) => f.step_id).sort()).toEqual(['J3/01', 'J4/01']);

    // ADR-015 / B-HARNESS-7: meta carries harness_sha, not the legacy `build`
    // field. No back-compat reader; the rename is unconditional.
    expect(dispatched.meta.harness_sha).toBe('test');
    expect('build' in (dispatched.meta as Record<string, unknown>)).toBe(false);

    // ADR-015 / B-HARNESS-8: meta carries target_deployment as a pass-through.
    // In this fixture the input set it to null; the dispatcher preserves null.
    expect(dispatched.meta.target_deployment ?? null).toBe(null);

    // meta.skipped is optional on the type for backwards compat with older
    // dispatched.json artifacts; the dispatcher always writes it, so we
    // assert presence and shape here.
    const skipped = (dispatched.meta.skipped ?? []) as SkippedFinding[];
    expect(skipped.length).toBe(2);

    // Skipped list is sorted by step_id and carries the reason.
    expect(skipped.map((s) => s.step_id)).toEqual(['J1/01', 'J2/00']);
    expect(skipped.every((s) => s.reason === 'auth-blocked-placeholder')).toBe(true);
    expect(skipped[0]!.title).toBe('J1 auth-blocked: no fixture');
    expect(skipped[1]!.title).toBe('J2 skipped: no code available');
  }, 30_000);
});

describe('multi-model-dispatch project-keyed finding map', () => {
  it('keeps both projects when two findings share a step_id (no clobber)', async () => {
    const runDir = path.join(tmpRoot, '2026-05-21-14-00');
    await fs.mkdir(runDir, { recursive: true });

    // A combined multi-project findings.json legitimately contains two
    // findings with the same step_id, one per Playwright project. The
    // dispatcher must key its finding map on (project, step_id) so the second
    // does not overwrite the first and their per-model judgments stay
    // separate. MEDIUM/cosmetic titles keep both out of the auth-blocked
    // skip path.
    const desktop: StepFinding = makeFinding({
      step_id: 'J1/01',
      journey_id: 'J1',
      severity: 'MEDIUM',
      bucket: 'cosmetic',
      title: 'header text mismatch',
      project: 'chromium-desktop',
    });
    const mobile: StepFinding = makeFinding({
      step_id: 'J1/01',
      journey_id: 'J1',
      severity: 'MEDIUM',
      bucket: 'cosmetic',
      title: 'header text mismatch',
      project: 'mobile-iphone-13',
    });

    await fs.writeFile(
      path.join(runDir, 'findings.json'),
      JSON.stringify({
        run_id: '2026-05-21-14-00',
        timestamp: '2026-05-21T14:00:00Z',
        target: 'https://example.com',
        harness_sha: 'test',
        target_deployment: null,
        results: [],
        findings: [desktop, mobile],
        axe_surfaces: [],
      }),
    );

    const result = spawnSync(TSX_BIN, [DISPATCH_SCRIPT], {
      env: {
        ...process.env,
        QA_RUN_DIR: runDir,
        MOCK_DISPATCH: '1',
        QA_ALLOW_SINGLE_FAMILY: '1',
        QA_MODELS: 'mock-a,mock-b,mock-c',
      },
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(
        `dispatch script exited ${result.status}: stdout=${result.stdout} stderr=${result.stderr}`,
      );
    }

    const dispatchedText = await fs.readFile(
      path.join(runDir, 'findings.dispatched.json'),
      'utf8',
    );
    const dispatched = JSON.parse(dispatchedText) as DispatchedRun;

    // Both project findings survive the finding-map keying; neither clobbers
    // the other despite the shared step_id.
    expect(dispatched.findings.length).toBe(2);
    expect(dispatched.findings.map((f) => f.project).sort()).toEqual([
      'chromium-desktop',
      'mobile-iphone-13',
    ]);

    // Every dispatched finding still reports step_id J1/01, so the survivors
    // are distinguished only by project, exactly the collision the fix targets.
    expect(dispatched.findings.every((f) => f.step_id === 'J1/01')).toBe(true);

    // Each finding carries its own three-model judgments; the second project's
    // judgments did not overwrite the first's at lookup time.
    for (const f of dispatched.findings) {
      expect(Object.keys(f.model_judgments).sort()).toEqual(['mock-a', 'mock-b', 'mock-c']);
    }
  }, 30_000);
});
