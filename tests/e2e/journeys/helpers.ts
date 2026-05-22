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

// ---------------------------------------------------------------------------
// Target-deployment header capture (B-HARNESS-8)
//
// We record the FIRST navigation response's Vercel identity headers so the
// report can pin down which deployment the journey actually hit. Subsequent
// responses do not overwrite the captured values; only the first matters
// because that is the deployment the journey opened against. The state is
// module-level on purpose (one harness process equals one report) but the
// `__resetTargetDeployment` export exists so any in-process test that wants
// a clean slate between fake runs can call it.
// ---------------------------------------------------------------------------

interface CapturedVercelHeaders {
  vercel_id: string | null;
  deployment_url: string | null;
  captured_at: string;
}

let capturedTargetDeployment: CapturedVercelHeaders | null = null;

/**
 * Pure header parser. Reads x-vercel-id and x-vercel-deployment-url from a
 * headers bag (the shape Playwright's response.headers() returns) and
 * returns the captured pair plus an ISO timestamp. Missing headers come
 * back as null on their respective fields; an empty bag returns both null.
 * Exported for unit testing.
 */
export function parseVercelHeaders(
  headers: Record<string, string>,
  capturedAt: string = new Date().toISOString(),
): CapturedVercelHeaders {
  const vercelId = headers['x-vercel-id'];
  const deploymentUrl = headers['x-vercel-deployment-url'];
  return {
    vercel_id: typeof vercelId === 'string' && vercelId.length > 0 ? vercelId : null,
    deployment_url:
      typeof deploymentUrl === 'string' && deploymentUrl.length > 0 ? deploymentUrl : null,
    captured_at: capturedAt,
  };
}

/** Accessor for the captured headers. Returns null when nothing has fired. */
export function getTargetDeployment(): CapturedVercelHeaders | null {
  return capturedTargetDeployment;
}

/** Test hygiene: clears module-level state between fake runs in a Vitest process. */
export function __resetTargetDeployment(): void {
  capturedTargetDeployment = null;
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

    // Capture the first response's Vercel identity. Subsequent responses
    // are ignored on purpose: we want the deployment the journey first hit,
    // not whatever was last contacted. Wrapped defensively because some
    // Playwright responses can throw on .headers() under unusual conditions.
    if (capturedTargetDeployment === null) {
      try {
        const headerBag = response.headers();
        const parsed = parseVercelHeaders(headerBag);
        // Only commit if at least one header was present; otherwise wait for
        // a later response that might carry them (some hosts attach Vercel
        // headers only to the page document, not to every sub-resource).
        if (parsed.vercel_id !== null || parsed.deployment_url !== null) {
          capturedTargetDeployment = parsed;
        }
      } catch {
        // never let header capture fail a journey
      }
    }
  });

  return { errors, networkFailures };
}

// ---------------------------------------------------------------------------
// /__build endpoint (B-HARNESS-9)
//
// Optional consumer-side convention. If the target app exposes GET /__build
// returning `{ commit, deployedAt }` (the consuming app reads
// VERCEL_GIT_COMMIT_SHA and the deployment timestamp from its own runtime
// env), the harness will surface the values in target_deployment. Anything
// goes wrong (network error, non-2xx, non-JSON, missing fields, timeout):
// return both nulls. Never throw.
// ---------------------------------------------------------------------------

export interface BuildEndpointResult {
  commit: string | null;
  deployed_at: string | null;
}

/**
 * Pure response-body parser for the /__build convention. Returns both nulls
 * unless the input is an object with a string `commit` AND a string
 * `deployedAt`. Exported for unit testing.
 */
export function parseBuildEndpointResponse(body: unknown): BuildEndpointResult {
  if (body === null || typeof body !== 'object') {
    return { commit: null, deployed_at: null };
  }
  const obj = body as Record<string, unknown>;
  const commit = typeof obj.commit === 'string' && obj.commit.length > 0 ? obj.commit : null;
  const deployedAt =
    typeof obj.deployedAt === 'string' && obj.deployedAt.length > 0 ? obj.deployedAt : null;
  return { commit, deployed_at: deployedAt };
}

/**
 * Fetches GET /__build off the target URL with a 3-second deadline.
 * Returns both nulls on any failure mode (DNS, network, non-2xx, non-JSON,
 * missing fields, timeout). Never throws.
 */
export async function fetchBuildEndpoint(targetUrl: string): Promise<BuildEndpointResult> {
  let endpoint: string;
  try {
    endpoint = new URL('/__build', targetUrl).toString();
  } catch {
    return { commit: null, deployed_at: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(endpoint, { signal: controller.signal });
    if (!res.ok) {
      return { commit: null, deployed_at: null };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { commit: null, deployed_at: null };
    }
    return parseBuildEndpointResponse(body);
  } catch {
    return { commit: null, deployed_at: null };
  } finally {
    clearTimeout(timer);
  }
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
 * Returns true when the auth fixture file exists AND parses to a
 * storageState with at least one cookie OR at least one origin. The OR
 * matters: cookie-based sessions legitimately have empty `origins`
 * (no localStorage / sessionStorage state to capture), and JWT-in-
 * localStorage sessions legitimately have empty `cookies`. Both arrays
 * empty (or a malformed JSON file) is treated as missing; one stderr
 * line records the downgrade so journeys gating on this signal are
 * not silently mistaken about session presence.
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

  if (cookies.length === 0 && origins.length === 0) {
    process.stderr.write(
      `note: auth fixture present but both cookies and origins are empty; treating as missing\n`,
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

interface TargetDeploymentLine {
  vercel_id: string | null;
  deployment_url: string | null;
  captured_at: string;
  build_commit: string | null;
  deployed_at: string | null;
}

/**
 * Renders the target_deployment object as a single markdown header line.
 * Falls back to "unknown" when the field is null (no journey ran) or every
 * sub-field is null (non-Vercel host with no /__build endpoint).
 */
function formatTargetDeploymentLine(td: TargetDeploymentLine | null): string {
  if (td === null) return 'unknown';
  const parts: string[] = [];
  if (td.build_commit !== null) parts.push(td.build_commit);
  if (td.vercel_id !== null) parts.push(`Vercel ${td.vercel_id}`);
  if (td.deployment_url !== null) parts.push(td.deployment_url);
  if (td.deployed_at !== null) parts.push(`deployed ${td.deployed_at}`);
  return parts.length > 0 ? parts.join(' ') : 'unknown';
}

export async function writeReport(
  results: JourneyResult[],
  axeSurfaces: AxeSurface[],
  targetUrl: string,
): Promise<void> {
  const ts = new Date().toISOString();

  let gitSha = 'unknown';
  try {
    gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // not in a git checkout, or git unavailable
  }

  // Kick the /__build fetch off in parallel with the rest of report assembly.
  // The 3-second abort fires from inside fetchBuildEndpoint, so even if every
  // other branch is instant, the whole writeReport finishes within ~3s of the
  // fetch starting. Failures resolve to (null, null), never throw.
  const buildEndpointPromise = fetchBuildEndpoint(targetUrl);

  // Compose the target_deployment record. Even when both Vercel headers were
  // missing (non-Vercel host) we emit an object with nulls instead of a bare
  // null, because at least one journey ran. The outer field is null only if
  // no journey ran at all (results is empty AND no headers were captured).
  const headers = getTargetDeployment();
  const journeyRan = results.length > 0;
  const buildEndpoint = await buildEndpointPromise;

  type TargetDeployment = {
    vercel_id: string | null;
    deployment_url: string | null;
    captured_at: string;
    build_commit: string | null;
    deployed_at: string | null;
  };
  let targetDeployment: TargetDeployment | null = null;
  if (journeyRan || headers !== null) {
    targetDeployment = {
      vercel_id: headers?.vercel_id ?? null,
      deployment_url: headers?.deployment_url ?? null,
      captured_at: headers?.captured_at ?? ts,
      build_commit: buildEndpoint.commit,
      deployed_at: buildEndpoint.deployed_at,
    };
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
        harness_sha: gitSha,
        target_deployment: targetDeployment,
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
    `Target deployment: ${formatTargetDeploymentLine(targetDeployment)}`,
    `Harness SHA: ${gitSha}`,
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
