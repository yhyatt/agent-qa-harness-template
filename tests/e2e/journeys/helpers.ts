/**
 * Shared helpers for the journey harness.
 *
 * Generalized from Ballpark slice-14-lite (W3 worktree, commit 204375f).
 * Where the seed referenced Hebrew-specific snapshotting, that role is
 * delegated to `locale-snapshot.ts` (which is locale-agnostic).
 *
 * Capture utilities:
 *   - screenshot            per-journey, per-step, namespaced by project
 *   - attachListeners       console errors + network 4xx/5xx
 *   - runAxe                axe-core a11y scan with WCAG 2.1 AA tags
 *   - hasAuthFixture        storageState fixture detection
 *   - writeProjectSidecar   per-project results/findings sidecar writer
 *   - aggregateRunReport    merges every project's sidecar into one combined
 *                           findings.json / REPORT.md; called once from
 *                           tests/e2e/global-teardown.ts after every
 *                           Playwright project has finished
 *
 * Output goes to a gitignored `.qa-runs/<YYYY-MM-DD-HHmm>/` directory.
 */

import { type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { formatTargetDeploymentLine, type TargetDeployment } from '../../../scripts/types.js';
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

export const RUN_DIR = path.resolve('.qa-runs', RUN_ID);
export const SCREENSHOT_BASE = path.join(RUN_DIR, 'screenshots');
export const REPORT_PATH = path.join(RUN_DIR, 'REPORT.md');
export const JSON_FINDINGS_PATH = path.join(RUN_DIR, 'findings.json');
/**
 * Per-project sidecars written by writeProjectSidecar, one file per
 * Playwright project/worker. aggregateRunReport reads every file here and
 * merges them into the combined findings.json / REPORT.md after all
 * projects finish (Playwright globalTeardown).
 */
export const PARTIALS_DIR = path.join(RUN_DIR, '.partials');

fs.mkdirSync(RUN_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOT_BASE, { recursive: true });
fs.mkdirSync(PARTIALS_DIR, { recursive: true });

/**
 * Turns a Playwright project name into a traversal-safe path segment for
 * screenshot directories and sidecar filenames. Project names come from
 * playwright.config.ts (author-controlled slugs like `chromium-desktop`), so
 * this is a defensive sanitizer, not a collision-avoidance scheme.
 *
 * Safe names ([a-zA-Z0-9._-], e.g. `chromium-desktop`, `v1.2`) pass through
 * verbatim. Any disallowed character maps to a hyphen. A dot-only (`.`, `..`)
 * or empty result would escape the run dir via path.join, so it is replaced
 * with the placeholder `_`.
 */
export function sanitizeSegment(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, '-');
  // Guard against path traversal: a dot-only or empty segment ('.', '..', '')
  // could escape the run dir via path.join. Replace with a safe placeholder.
  if (cleaned === '' || /^\.+$/.test(cleaned)) return '_';
  return cleaned;
}

/**
 * Removes the run-stage generated output of a prior run from RUN_DIR, so a run
 * that reuses RUN_DIR (default minute-granularity timestamp on quick reruns,
 * or a fixed QA_RUN_DIR) does not serve a prior run's report. Called once from
 * tests/e2e/global-setup.ts at run start. Clears:
 *   - `.partials/ *.json`   per-project sidecars (dir created if absent)
 *   - findings.json          combined run report JSON (JSON_FINDINGS_PATH)
 *   - REPORT.md              combined run report markdown (REPORT_PATH)
 *
 * Stale-data cases this closes:
 *   - Partial merge: a narrower rerun (test:e2e:desktop after a full
 *     both-projects run) would leave mobile's stale sidecar, so the
 *     desktop-only report would still show mobile from the old run.
 *   - Stale run report: a rerun that produces ZERO sidecars (a --grep
 *     matching nothing, or all journeys skipped) makes globalTeardown write
 *     nothing, so the prior run's findings.json / REPORT.md would linger and
 *     be served as if current (the dispatcher keys on that findings.json).
 *
 * Does not touch screenshots/: orphaned stale screenshots are harmless since a
 * regenerated report only references the current run's paths. Also leaves the
 * downstream pipeline artifacts (findings.dispatched.json, findings.deduped.json,
 * REPORT.final.md) to the dispatch/dedup/report scripts that own them.
 *
 * force: true on each rmSync makes an absent file a no-op (fresh run dir, or a
 * stage that did not run).
 */
export function clearRunOutputs(): void {
  fs.mkdirSync(PARTIALS_DIR, { recursive: true });
  for (const file of fs.readdirSync(PARTIALS_DIR)) {
    if (file.endsWith('.json')) {
      fs.rmSync(path.join(PARTIALS_DIR, file), { force: true });
    }
  }
  fs.rmSync(JSON_FINDINGS_PATH, { force: true });
  fs.rmSync(REPORT_PATH, { force: true });
}

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
  /**
   * Which Playwright project (e.g. "chromium-desktop") produced this
   * finding. Stamped onto every finding at sidecar-write time by
   * writeProjectSidecar, from testInfo.project.name. Optional on the type
   * because in-repo test fixtures build a StepFinding by hand without a
   * project; every finding emitted by the harness itself always carries it.
   */
  project?: string;
  /** Optional extra notes. */
  notes?: string;
}

export type JourneyStatus = 'pass' | 'fail' | 'auth-blocked';

export interface JourneyResult {
  id: string;
  status: JourneyStatus;
  durationMs: number;
  findings: StepFinding[];
  /**
   * Which Playwright project produced this result. Stamped at sidecar-write
   * time by writeProjectSidecar, from testInfo.project.name. Always present
   * in emitted artifacts (findings.json, REPORT.md).
   */
  project?: string;
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
  project: string,
  journeyId: string,
  stepName: string,
): Promise<string> {
  const dir = path.join(SCREENSHOT_BASE, sanitizeSegment(project), journeyId);
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

    // Capture target deployment identity from the main-frame document
    // navigation response only. Filtering matters: an unconditional
    // page.on('response') listener can latch onto a subresource (script,
    // image, fetch/XHR) or a cross-origin Vercel app that the page pulls
    // in, which then misattributes meta.target_deployment to the wrong
    // deployment and defeats the chronology goal of this capture.
    //
    // request.isNavigationRequest() stays true through the entire redirect
    // chain, so combined with mainFrame + resourceType 'document' it picks
    // the resolved HTML response. We capture once and freeze; if the target
    // is not on Vercel, vercel_id and deployment_url stay null and that is
    // the correct signal (build_commit / deployed_at from /__build cover the
    // non-Vercel case separately).
    if (capturedTargetDeployment === null) {
      try {
        const request = response.request();
        if (
          request.isNavigationRequest() &&
          response.frame() === page.mainFrame() &&
          request.resourceType() === 'document'
        ) {
          capturedTargetDeployment = parseVercelHeaders(response.headers());
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
 * Pure response-body parser for the /__build convention. Each field resolves
 * independently: a valid `commit` string survives even when `deployedAt` is
 * missing or malformed, and vice versa. Returns both nulls only when the
 * input is not an object at all. Exported for unit testing.
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
 * Fetches GET /__build off the target URL with a 3-second deadline. The
 * abort signal propagates through `res.json()` (fetch spec), so the body
 * read is bounded by the same deadline as the request head. Per-field
 * semantics follow `parseBuildEndpointResponse` (independent resolution).
 * Returns both nulls on any failure mode (DNS, network, non-2xx, non-JSON,
 * timeout). Never throws.
 */
export async function fetchBuildEndpoint(targetUrl: string): Promise<BuildEndpointResult> {
  // Resolve the endpoint relative to the target's base path. A leading-slash
  // URL ('/__build') would reset to the origin root and miss apps hosted
  // under a subpath like `https://host/app/`. Force a trailing slash on the
  // base so `new URL('__build', base)` respects the path segments.
  let endpoint: string;
  try {
    const base = targetUrl.endsWith('/') ? targetUrl : targetUrl + '/';
    endpoint = new URL('__build', base).toString();
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
// Per-project sidecar writer + globalTeardown aggregation
//
// Playwright runs each project (chromium-desktop, mobile-iphone-13) in its
// own worker process, so this module gets a fresh copy per project and the
// module-level journeyResults/axeSurfaces arrays in journeys.spec.ts only
// ever hold one project's results. Each project's test.afterAll calls
// writeProjectSidecar to persist its own slice under PARTIALS_DIR; a
// Playwright globalTeardown (tests/e2e/global-teardown.ts) then calls
// aggregateRunReport exactly once, after every project has finished, to
// merge all sidecars into the single combined findings.json / REPORT.md that
// the dispatcher, dedup, and generate-report scripts read.
// ---------------------------------------------------------------------------

interface ProjectSidecar {
  project: string;
  worker_index: number;
  results: JourneyResult[];
  axe_surfaces: AxeSurface[];
  target_deployment_headers: CapturedVercelHeaders | null;
}

/**
 * Writes one project's results and axe surfaces to a sidecar file under
 * PARTIALS_DIR. Stamps `project` onto every JourneyResult and onto every
 * StepFinding nested inside each result's findings, so downstream
 * aggregation and dedup can key on it without a second pass. Pure file
 * write: no git lookup, no /__build fetch, no markdown rendering. Those
 * happen once in aggregateRunReport after every project has written its
 * sidecar.
 */
export async function writeProjectSidecar(
  project: string,
  workerIndex: number,
  results: JourneyResult[],
  axeSurfaces: AxeSurface[],
): Promise<void> {
  const stampedResults: JourneyResult[] = results.map((r) => ({
    ...r,
    project,
    findings: r.findings.map((f) => ({ ...f, project })),
  }));

  const sidecar: ProjectSidecar = {
    project,
    worker_index: workerIndex,
    results: stampedResults,
    axe_surfaces: axeSurfaces,
    target_deployment_headers: getTargetDeployment(),
  };

  // Write atomically: write to a temp file, then rename into place. A rename
  // on the same filesystem is atomic, so aggregateRunReport (running in a
  // separate globalTeardown process) never observes a half-written sidecar,
  // even if this worker is killed mid-write. The tmp name is per
  // (project, workerIndex) so concurrent workers never share a temp path.
  const file = path.join(PARTIALS_DIR, `${sanitizeSegment(project)}__${workerIndex}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sidecar, null, 2));
  // Remove the destination first: fs.renameSync cannot overwrite an existing
  // file on Windows, and a rerun into the same RUN_DIR would otherwise fail
  // to replace the prior sidecar. globalSetup's clearRunOutputs already
  // removes stale sidecars at run start; this is belt-and-suspenders for a
  // same-run rewrite of the same (project, workerIndex).
  fs.rmSync(file, { force: true });
  fs.renameSync(tmp, file);
}

/**
 * Reads every sidecar under PARTIALS_DIR and merges them into the combined
 * findings.json + REPORT.md at RUN_DIR. Called once from
 * tests/e2e/global-teardown.ts after all Playwright projects finish.
 *
 * Zero sidecars (no journeys ran, or every project's afterAll failed before
 * writing one) writes nothing and returns. This preserves the
 * pre-aggregation behavior: a run with no journeys leaves no findings.json
 * marker, and the dispatcher's discovery layer keys on that marker's
 * presence to decide whether a run is worth dispatching.
 */
export async function aggregateRunReport(targetUrl: string): Promise<void> {
  let partialFiles: string[];
  try {
    // Sorted so the merged results/findings order and the target_deployment
    // tie-break below are stable run-over-run (PHILOSOPHY wants clean diffs).
    partialFiles = fs
      .readdirSync(PARTIALS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (err) {
    // A missing partials dir means genuinely zero sidecars (no journeys ran):
    // return quietly, leaving no findings.json marker so the dispatcher skips
    // the run. Any other error (permissions, transient FS failure) is a real
    // problem and must be loud, not silently rendered as a clean empty run.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw err;
  }

  if (partialFiles.length === 0) {
    return;
  }

  // Parse each sidecar independently: a single corrupt or truncated sidecar
  // must not sink the whole run. Skip-and-warn on failure so the healthy
  // projects still aggregate, matching ADR-016's degradation contract (a bad
  // sidecar drops that one project, the rest survive).
  const sidecars: ProjectSidecar[] = [];
  for (const file of partialFiles) {
    try {
      const text = fs.readFileSync(path.join(PARTIALS_DIR, file), 'utf-8');
      sidecars.push(JSON.parse(text) as ProjectSidecar);
    } catch (err) {
      process.stderr.write(
        `note: skipping unreadable sidecar ${file} (${err instanceof Error ? err.message : String(err)}); its project is dropped from this run's report\n`,
      );
    }
  }

  // Every sidecar failed to parse. Treat as zero sidecars: write no marker.
  if (sidecars.length === 0) {
    return;
  }

  const results: JourneyResult[] = sidecars.flatMap((s) => s.results);
  const axeSurfaces: AxeSurface[] = sidecars.flatMap((s) => s.axe_surfaces);

  // Pick target_deployment_headers from the first sidecar that actually
  // captured a vercel_id; fall back to the first sidecar's headers (which
  // may be all-null, e.g. a non-Vercel target) if none did.
  const withVercelId = sidecars.find((s) => s.target_deployment_headers?.vercel_id != null);
  const headers = (withVercelId ?? sidecars[0])?.target_deployment_headers ?? null;

  const ts = new Date().toISOString();

  let gitSha = 'unknown';
  try {
    gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // not in a git checkout, or git unavailable
  }

  // Fire the /__build fetch eagerly; the synchronous composition below runs
  // while it's in flight. The 3-second abort fires from inside
  // fetchBuildEndpoint, so the await below is bounded by that deadline.
  // Failures resolve to (null, null), never throw.
  const buildEndpointPromise = fetchBuildEndpoint(targetUrl);

  // Compose the target_deployment record. Even when both Vercel headers were
  // missing (non-Vercel host) we emit an object with nulls instead of a bare
  // null, because at least one journey ran. The outer field is null only if
  // no journey ran at all (results is empty AND no headers were captured).
  const journeyRan = results.length > 0;
  const buildEndpoint = await buildEndpointPromise;

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

  // JSON sidecar (source of truth for tooling). Top-level keys are
  // unchanged from the pre-aggregation shape; results and findings now
  // carry `project`.
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
          project: r.project,
        })),
        findings: allFindings,
        axe_surfaces: axeSurfaces,
      },
      null,
      2,
    ),
  );

  // Markdown report (rendering of the JSON), grouped by project so a
  // multi-project run reads as one document instead of two projects
  // overwriting each other.
  const lines: string[] = [
    `# QA run: ${ts}`,
    `Target: ${targetUrl}`,
    `Target deployment: ${formatTargetDeploymentLine(targetDeployment)}`,
    `Harness SHA: ${gitSha}`,
    `Run dir: ${RUN_DIR}`,
  ];

  // Project sections come from the UNION of every sidecar's declared project
  // and any project seen in results or axe surfaces, so a project that ran but
  // produced zero JourneyResults (only axe surfaces, or nothing) still gets a
  // section instead of silently vanishing. Sorted for a deterministic report.
  const projects = [
    ...new Set([
      ...sidecars.map((s) => s.project),
      ...results.map((r) => r.project ?? 'unknown'),
      ...axeSurfaces.map((s) => s.project),
    ]),
  ].sort();

  for (const project of projects) {
    const projectResults = results.filter((r) => (r.project ?? 'unknown') === project);
    const projectFindings = projectResults.flatMap((r) => r.findings);

    lines.push('', `## Project: ${project}`, '', '### Summary');

    for (const r of projectResults) {
      const dur = (r.durationMs / 1000).toFixed(1);
      lines.push(`- ${r.id}: ${r.status} (${dur}s, ${r.findings.length} findings)`);
    }

    lines.push('', '### Findings');

    if (projectFindings.length === 0) {
      lines.push('', 'No findings.');
    } else {
      for (const f of projectFindings) {
        lines.push('', `#### ${f.severity}: ${f.title}`);
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
