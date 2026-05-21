/**
 * Shared helpers for the journey harness.
 *
 * Generalized from Ballpark slice-14-lite (W3 worktree, commit 204375f).
 * Where the seed referenced Hebrew-specific snapshotting, that role is
 * delegated to `locale-snapshot.ts` (which is locale-agnostic).
 *
 * Capture utilities:
 *   - screenshot       per-journey, per-step
 *   - attachListeners  console errors + network 4xx/5xx
 *   - runAxe           axe-core a11y scan with WCAG 2.1 AA tags
 *   - hasAuthFixture   storageState fixture detection
 *   - writeReport      markdown report writer
 *
 * Output goes to a gitignored `.qa-runs/<YYYY-MM-DD-HHmm>/` directory.
 */

import { type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Output directories
// ---------------------------------------------------------------------------

/**
 * Each invocation gets a fresh timestamped directory under .qa-runs/.
 * Override with QA_RUN_DIR env var for deterministic CI paths.
 */
const RUN_ID =
  process.env.QA_RUN_DIR ??
  new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

const RUN_DIR = path.resolve('.qa-runs', RUN_ID);
export const SCREENSHOT_BASE = path.join(RUN_DIR, 'screenshots');
export const REPORT_PATH = path.join(RUN_DIR, 'REPORT.md');
export const JSON_FINDINGS_PATH = path.join(RUN_DIR, 'findings.json');

fs.mkdirSync(RUN_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOT_BASE, { recursive: true });

// ---------------------------------------------------------------------------
// Types - the canonical per-step JSON schema (see docs/PHILOSOPHY.md)
// ---------------------------------------------------------------------------

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type Bucket = 'pass' | 'blocking' | 'cosmetic' | 'flake';

export interface StepFinding {
  /** Stable ID, e.g. "J1/04". Combines journey ID and step number. */
  step_id: string;
  /** Permanent journey ID (J1, J2, ...). */
  journey_id: string;
  /** Short kebab-case step name, used in screenshot filename. */
  step_name: string;
  /** One-line description of what the agent did at this step. */
  action: string;
  /** Severity bucket for the finding. */
  severity: Severity;
  /** Pass/fail bucket - see Bucket type. */
  bucket: Bucket;
  /** Free-form finding title (used in dedup hash after normalization). */
  title: string;
  /** Path to the screenshot for this step (absolute or repo-relative). */
  screenshot_path?: string;
  /** User-visible strings captured from the page at this step. */
  locale_snapshot: string[];
  /** Optional DB-state snapshot. Shape is app-specific. */
  db_state: Record<string, unknown> | null;
  /** Console errors observed during the step. */
  console_errors: string[];
  /** Network 4xx/5xx responses observed during the step. */
  network_failures: string[];
  /**
   * Count of axe-core violations on the page at this step.
   *
   * Convention:
   *   null: axe was not run on this step (default in makeFinding)
   *   0: scanned, no violations
   *   positive integer: scanned, that many violations
   *   -1: scan failed mid-run (axe library threw)
   *
   * The null branch was introduced in ADR-013 to disambiguate "scan not
   * attempted" from "scan ran and clean". Consumers must handle null.
   */
  axe_violations: number | null;
  /** Top 3 axe violations, formatted "id: description". */
  axe_top3: string[];
  /** Free-form agent prose explaining the judgment. */
  judgment: string;
  /** Which model produced this finding. Filled in by the dispatcher. */
  model?: string;
  /** Optional extra notes. */
  notes?: string;
}

export type JourneyStatus = 'pass' | 'fail' | 'auth-blocked';

export interface JourneyResult {
  id: string;
  status: JourneyStatus;
  durationMs: number;
  findings: StepFinding[];
}

export interface AxeSurface {
  route: string;
  project: string;
  violations: number;
  top3: string[];
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export async function screenshot(
  page: Page,
  journeyId: string,
  stepName: string,
): Promise<string> {
  const dir = path.join(SCREENSHOT_BASE, journeyId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stepName}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

// ---------------------------------------------------------------------------
// Console + network listeners
// ---------------------------------------------------------------------------

export interface PageListeners {
  errors: string[];
  networkFailures: string[];
}

export function attachListeners(page: Page): PageListeners {
  const errors: string[] = [];
  const networkFailures: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });

  page.on('response', (response) => {
    const status = response.status();
    if (status >= 400) {
      networkFailures.push(`${status} ${response.url()}`);
    }
  });

  return { errors, networkFailures };
}

// ---------------------------------------------------------------------------
// Axe-core scan
// ---------------------------------------------------------------------------

export async function runAxe(
  page: Page,
): Promise<{ count: number; top3: string[] }> {
  try {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    const violations = results.violations;
    const top3 = violations.slice(0, 3).map((v: { id: string; description: string }) => `${v.id}: ${v.description}`);
    return { count: violations.length, top3 };
  } catch {
    return { count: -1, top3: ['axe scan failed'] };
  }
}

// ---------------------------------------------------------------------------
// Auth fixture check
// ---------------------------------------------------------------------------

export const AUTH_FIXTURE_PATH =
  process.env.QA_AUTH_FIXTURE_PATH ??
  path.resolve('tests/e2e/fixtures/host-auth.json');

/**
 * Returns true only when the auth fixture file exists AND parses to a
 * storageState with at least one cookie and one origin. An empty
 * `{"cookies": [], "origins": []}` (or a malformed JSON file) is treated
 * as missing; one stderr line records the downgrade so journeys gating
 * on this signal are not silently mistaken about session presence.
 */
export function hasAuthFixture(fixturePath: string = AUTH_FIXTURE_PATH): boolean {
  if (!fs.existsSync(fixturePath)) return false;

  let text: string;
  try {
    text = fs.readFileSync(fixturePath, 'utf-8');
  } catch (err) {
    process.stderr.write(
      `note: auth fixture present but unreadable (${String(err)}); treating as missing\n`,
    );
    return false;
  }

  let parsed: { cookies?: unknown; origins?: unknown };
  try {
    parsed = JSON.parse(text) as { cookies?: unknown; origins?: unknown };
  } catch (err) {
    process.stderr.write(
      `note: auth fixture present but failed to parse (${err instanceof Error ? err.message : String(err)}); treating as missing\n`,
    );
    return false;
  }

  const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
  const origins = Array.isArray(parsed.origins) ? parsed.origins : [];

  if (cookies.length === 0 || origins.length === 0) {
    process.stderr.write(
      `note: auth fixture present but empty (cookies=${cookies.length}, origins=${origins.length}); treating as missing\n`,
    );
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Finding factory - gives every finding the full schema with sensible defaults
// ---------------------------------------------------------------------------

export function makeFinding(
  partial: Partial<StepFinding> &
    Pick<
      StepFinding,
      'step_id' | 'journey_id' | 'step_name' | 'action' | 'severity' | 'bucket' | 'title' | 'judgment'
    >,
): StepFinding {
  return {
    locale_snapshot: [],
    db_state: null,
    console_errors: [],
    network_failures: [],
    axe_violations: null,
    axe_top3: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Report writer
// ---------------------------------------------------------------------------

export function writeReport(
  results: JourneyResult[],
  axeSurfaces: AxeSurface[],
  targetUrl: string,
): void {
  const ts = new Date().toISOString();

  let gitSha = 'unknown';
  try {
    gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // not in a git checkout, or git unavailable
  }

  // JSON sidecar (source of truth for tooling)
  const allFindings = results.flatMap((r) => r.findings);
  fs.writeFileSync(
    JSON_FINDINGS_PATH,
    JSON.stringify(
      {
        run_id: RUN_ID,
        timestamp: ts,
        target: targetUrl,
        build: gitSha,
        results: results.map((r) => ({
          id: r.id,
          status: r.status,
          durationMs: r.durationMs,
          finding_count: r.findings.length,
        })),
        findings: allFindings,
        axe_surfaces: axeSurfaces,
      },
      null,
      2,
    ),
  );

  // Markdown report (rendering of the JSON)
  const lines: string[] = [
    `# QA run: ${ts}`,
    `Target: ${targetUrl}`,
    `Build: ${gitSha}`,
    `Run dir: ${RUN_DIR}`,
    '',
    '## Summary',
  ];

  for (const r of results) {
    const dur = (r.durationMs / 1000).toFixed(1);
    lines.push(`- ${r.id}: ${r.status} (${dur}s, ${r.findings.length} findings)`);
  }

  lines.push('', '## Findings');

  if (allFindings.length === 0) {
    lines.push('', 'No findings.');
  } else {
    for (const f of allFindings) {
      lines.push('', `### ${f.severity}: ${f.title}`);
      lines.push(`- Step: ${f.step_id}`);
      lines.push(`- Action: ${f.action}`);
      lines.push(`- Bucket: ${f.bucket}`);
      if (f.screenshot_path) lines.push(`- Screenshot: ${f.screenshot_path}`);
      if (f.console_errors.length > 0) {
        lines.push(`- Console errors: ${f.console_errors.join('; ')}`);
      } else {
        lines.push('- Console errors: none');
      }
      if (f.network_failures.length > 0) {
        lines.push(`- Network failures: ${f.network_failures.join('; ')}`);
      } else {
        lines.push('- Network failures: none');
      }
      const axeLabel =
        f.axe_violations === null
          ? 'not scanned'
          : f.axe_violations < 0
            ? 'scan failed'
            : `${f.axe_violations} violations`;
      const top3str =
        f.axe_top3.length > 0 ? `: top 3: ${f.axe_top3.join(', ')}` : '';
      lines.push(`- Axe violations: ${axeLabel}${top3str}`);
      if (f.locale_snapshot.length > 0) {
        lines.push(`- Locale snapshot: ${f.locale_snapshot.slice(0, 5).join(' | ')}`);
      }
      if (f.judgment) lines.push(`- Judgment: ${f.judgment}`);
      if (f.notes) lines.push(`- Notes: ${f.notes}`);
      if (f.model) lines.push(`- Model: ${f.model}`);
    }
  }

  lines.push('', '## Axe a11y summary (per surface)');
  if (axeSurfaces.length === 0) {
    lines.push('', 'No surfaces scanned.');
  } else {
    for (const s of axeSurfaces) {
      const label = s.violations < 0 ? 'scan failed' : `${s.violations} violations`;
      lines.push(`- \`${s.route}\` ${s.project}: ${label}`);
    }
  }

  fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
}
