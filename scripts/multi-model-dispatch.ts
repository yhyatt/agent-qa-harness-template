/**
 * Multi-model dispatcher.
 *
 * Reads findings.json from a QA run directory, dispatches each finding
 * to a configurable set of models in parallel (AP#6: no serial awaits in the
 * fan-out loop), and writes findings.dispatched.json with per-model judgments.
 *
 * Env vars:
 *   QA_RUN_DIR              run directory selector. Three accepted forms (see resolveRunDir):
 *                            (a) YYYY-MM-DD-HH-MM run id, resolved under .qa-runs/
 *                            (b) explicit relative or absolute path
 *                            (c) bare name, treated as a run id with a stderr note
 *                           When unset, the latest run under .qa-runs/ is used.
 *   QA_MODELS               comma-separated model list (default: anthropic/claude-sonnet-4-6,google/gemini-3.5-flash,openai/gpt-5).
 *                           Every real id must be an OpenRouter provider-prefixed id (`<provider>/<model>`).
 *   QA_DISPATCH_CONCURRENCY parallelism cap on the OpenRouter dispatch path (default: 4).
 *                           A separate semaphore caps the mock path at the same value.
 *   QA_DISPATCH_TIMEOUT_MS  per-call OpenRouter fetch deadline in ms (default: 60000)
 *   MOCK_DISPATCH           set to 1 to use the mock provider for all models
 *   QA_ALLOW_SINGLE_FAMILY  set to 1 to bypass ADR-002 single-family check (for testing)
 *   OPENROUTER_API_KEY      required for any real (non-mock) model
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StepFinding } from '../tests/e2e/journeys/helpers.js';
import type {
  ModelJudgment,
  DispatchedFinding,
  DispatchError,
  DispatchedRun,
  SkippedFinding,
  TargetDeployment,
} from './types.js';
import { resolveProvider, isMockModel } from './dispatch/providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Finding identity
// ---------------------------------------------------------------------------

/**
 * Compound key for a finding within a run. A combined multi-project run holds
 * two findings that share a step_id (one per Playwright project), so the
 * dispatcher keys its finding map on (project, step_id) to keep both
 * distinct. Findings written before the project field existed have
 * project undefined; `?? ''` maps them to a single project-agnostic bucket,
 * preserving the prior step_id-only behavior for single-project artifacts.
 */
function findingKey(f: Pick<StepFinding, 'step_id' | 'project'>): string {
  return `${f.project ?? ''}|${f.step_id}`;
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

function semaphore(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];

  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const attempt = () => {
        if (active < n) {
          active++;
          task()
            .then(resolve, reject)
            .finally(() => {
              active--;
              if (queue.length > 0) {
                const next = queue.shift();
                if (next) next();
              }
            });
        } else {
          queue.push(attempt);
        }
      };
      attempt();
    });
  };
}

// ---------------------------------------------------------------------------
// Find latest run directory / resolve QA_RUN_DIR
// ---------------------------------------------------------------------------

// Path-safety pattern: accepts timestamp run-ids (e.g. 2026-05-22-14-30) and
// semantic run-ids (e.g. overnight-2026-05-22). Rejects characters that would
// break path handling. The lookahead requires at least one alphanumeric, which
// rejects dot-segments ('.', '..', '...') so they fall through to the
// explicit-path branch in resolveRunDir instead of being joined into .qa-runs/.
const RUN_DIR_PATTERN = /^(?=.*[a-z0-9])[a-z0-9._-]+$/i;

// .qa-runs/ also houses utility directories that match the path-safety
// regex but are not runs (playwright-output/ from the JSON reporter and
// userDataDir/ from populate-auth). Exclude them from the latest-run scan
// so that when latest.txt is missing or stale, the fallback does not pick
// one (lexicographic sort would otherwise prefer playwright-output over
// timestamped run-ids).
const RUN_DIR_DENYLIST = new Set(['playwright-output', 'userDataDir']);

/**
 * Resolves the run directory from the QA_RUN_DIR env value.
 *
 * Three forms are accepted:
 *  1. Path-safe run-id (matches `[a-z0-9._-]+`, e.g. `2026-05-22-14-30` or
 *     `overnight-2026-05-22`): resolved under .qa-runs/.
 *  2. Path (contains / or \, or starts with . or /): resolved relative to REPO_ROOT
 *     if not already absolute.
 *  3. Bare name (anything else): treated as a run-id under .qa-runs/ with a stderr note.
 */
function resolveRunDir(envValue: string): string {
  const RUN_DIR_RE = RUN_DIR_PATTERN;
  const isPath =
    envValue.includes('/') ||
    envValue.includes('\\') ||
    envValue.startsWith('.') ||
    envValue.startsWith('/');

  if (isPath) {
    // Form 2 (tested first): explicit path. Values like '.audit-2026-05-22'
    // also pass the path-safety regex, so checking path-ness first keeps them
    // treated as paths rather than joined into .qa-runs/.
    return path.isAbsolute(envValue) ? envValue : path.resolve(REPO_ROOT, envValue);
  }

  if (RUN_DIR_RE.test(envValue)) {
    // Form 1: path-safe run-id
    return path.join(REPO_ROOT, '.qa-runs', envValue);
  }

  // Form 3: bare name, treat as run-id and note it
  process.stderr.write(
    `note: interpreting QA_RUN_DIR='${envValue}' as a run id under .qa-runs/. ` +
      `Use a relative or absolute path to override.\n`,
  );
  return path.join(REPO_ROOT, '.qa-runs', envValue);
}

async function findLatestRunDir(): Promise<string> {
  const base = path.resolve(REPO_ROOT, '.qa-runs');

  // Prefer the pointer written by playwright.config.ts at run time.
  // Fall back to scan+sort if the file is absent or contains an invalid value.
  const latestFile = path.join(base, 'latest.txt');
  try {
    const candidate = (await fs.readFile(latestFile, 'utf-8')).trim();
    if (RUN_DIR_PATTERN.test(candidate) && !RUN_DIR_DENYLIST.has(candidate)) {
      const resolved = path.join(base, candidate);
      // Verify the directory actually exists before trusting the pointer.
      await fs.stat(resolved);
      return resolved;
    }
  } catch {
    // File missing, unreadable, or points to a non-existent directory. Fall through.
  }

  let rawEntries: import('node:fs').Dirent[];
  try {
    rawEntries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    throw new Error(
      `No .qa-runs/ directory found at ${base}. ` +
        'Run the Playwright harness first, or set QA_RUN_DIR.',
    );
  }
  // Filter to candidate dirs that contain a findings.json marker, then sort
  // by that file's mtime. The marker is the same file the journey runtime
  // writes once at end-of-run; its mtime is the true run-finish time and is
  // not perturbed by later dedup/report writes to the same directory.
  // Requiring the marker also rejects arbitrary user-created directories
  // under .qa-runs/ (a configured QA_AUTH_PROFILE_DIR, for example) that the
  // static denylist would otherwise miss.
  const candidates = rawEntries
    .filter((e) => e.isDirectory() && RUN_DIR_PATTERN.test(e.name) && !RUN_DIR_DENYLIST.has(e.name))
    .map((e) => e.name);
  const runs = (
    await Promise.all(
      candidates.map(async (name) => {
        try {
          const stat = await fs.stat(path.join(base, name, 'findings.json'));
          return { name, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      }),
    )
  ).filter((r): r is { name: string; mtimeMs: number } => r !== null);
  if (runs.length === 0) {
    throw new Error(
      `.qa-runs/ has no completed run directories (a run dir must contain a findings.json marker).`,
    );
  }
  runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return path.join(base, runs[0]!.name);
}

// ---------------------------------------------------------------------------
// Screenshot loader
// ---------------------------------------------------------------------------

/**
 * Returns a base64-encoded PNG string, or null if the file is missing or too large.
 * Emits a dispatch_error entry (non-fatal) when the file is absent or oversized.
 */
async function loadScreenshot(
  screenshotPath: string,
  stepId: string | null,
  model: string,
  dispatchErrors: DispatchError[],
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(screenshotPath)) {
    return cache.get(screenshotPath)!;
  }

  const resolved = path.isAbsolute(screenshotPath)
    ? screenshotPath
    : path.resolve(REPO_ROOT, screenshotPath);

  let data: Buffer;
  try {
    data = await fs.readFile(resolved);
  } catch {
    dispatchErrors.push({
      model,
      step_id: stepId,
      message: `screenshot missing or unreadable: ${screenshotPath}`,
    });
    cache.set(screenshotPath, null);
    return null;
  }

  // OpenRouter routes to underlying providers whose per-image limits vary; the
  // strictest in practice is 4MB (Anthropic). A 3.9MB raw PNG becomes ~5.2MB as
  // a base64 data URI, which some providers may still reject. Those rejections
  // bubble through as normal dispatch_errors.
  const FOUR_MB = 4 * 1024 * 1024;
  if (data.byteLength > FOUR_MB) {
    dispatchErrors.push({
      model,
      step_id: stepId,
      message: `screenshot too large (${data.byteLength} bytes > 4MB), dispatching text-only: ${screenshotPath}`,
    });
    cache.set(screenshotPath, null);
    return null;
  }

  const b64 = data.toString('base64');
  cache.set(screenshotPath, b64);
  return b64;
}

// ---------------------------------------------------------------------------
// Raw run JSON shape (from helpers.ts writeReport)
// ---------------------------------------------------------------------------

interface RawRunJson {
  run_id: string;
  timestamp: string;
  target: string;
  /**
   * Short git SHA of the consuming repo at harness run time. Renamed from
   * `build` in ADR-015. No back-compat reader for the legacy name: callers
   * regenerate findings.json on every run, so older artifacts simply will
   * not flow through this dispatcher unchanged.
   */
  harness_sha: string;
  /**
   * Runtime-captured identity of the deployment the journey hit. Optional
   * because findings.json files written before ADR-015 do not include it.
   * Consumers must use `?? null` defensively.
   */
  target_deployment?: TargetDeployment | null;
  results: unknown[];
  findings: StepFinding[];
  axe_surfaces: unknown[];
}

// ---------------------------------------------------------------------------
// Skip rules: auth-blocked placeholder findings
// ---------------------------------------------------------------------------

/**
 * Matches the placeholder titles that journeys emit when they bail because
 * the auth fixture is missing or no join code is available. The dot in
 * `auth.blocked` deliberately matches both "auth-blocked" and "auth blocked"
 * (case insensitive). 'no fixture' and 'no code' cover the J2-style
 * "skipped: no join code available" placeholder.
 *
 * The rule is conjoined with severity === 'INFO' && bucket === 'pass' in
 * shouldSkipFinding so a real INFO finding whose title happens to mention
 * "no code" cannot accidentally be skipped.
 */
const AUTH_BLOCKED_TITLE_RE = /auth.blocked|no fixture|no code/i;

function shouldSkipFinding(f: StepFinding): boolean {
  return (
    f.severity === 'INFO' &&
    f.bucket === 'pass' &&
    AUTH_BLOCKED_TITLE_RE.test(f.title)
  );
}

// ---------------------------------------------------------------------------
// Deterministic JSON serializer
// ---------------------------------------------------------------------------

/**
 * Serializes an object with sorted keys at every level.
 * Produces byte-identical output for the same logical content.
 */
function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(value, sortedReplacer, indent);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Parse env
  const mockDispatch = process.env.MOCK_DISPATCH === '1';
  const allowSingleFamily = process.env.QA_ALLOW_SINGLE_FAMILY === '1';
  const rawConcurrency = process.env.QA_DISPATCH_CONCURRENCY ?? '4';
  const concurrency = Number(rawConcurrency);
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    console.error(
      `QA_DISPATCH_CONCURRENCY must be a positive integer, got: ${rawConcurrency}`,
    );
    process.exit(1);
  }
  const modelList =
    process.env.QA_MODELS ?? 'anthropic/claude-sonnet-4-6,google/gemini-3.5-flash,openai/gpt-5';
  const models = modelList.split(',').map((m) => m.trim()).filter(Boolean);

  const runDirEnv = process.env.QA_RUN_DIR;
  const runDir = runDirEnv ? resolveRunDir(runDirEnv) : await findLatestRunDir();

  // 2. Validate matrix (ADR-002)
  // Model id shape check runs FIRST: a bare un-prefixed id like
  // `claude-sonnet-4-6` would otherwise pass the cross-provider gate (it does
  // not start with `anthropic/`), only to 404 at OpenRouter dispatch time and
  // produce noisy dispatch_errors instead of a fast configuration failure.
  // After the shape check, the ADR-002 gate runs so the message is unambiguous
  // regardless of which keys are set in the environment. With provider-prefixed
  // OpenRouter model ids, the cross-provider requirement reads "at least one
  // model whose id does not start with anthropic/".
  if (!mockDispatch) {
    const realModels = models.filter((m) => !isMockModel(m));

    const OPENROUTER_ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9._-]+(?::[a-z0-9-]+)?$/;
    const malformed = realModels.filter((m) => !OPENROUTER_ID_PATTERN.test(m));
    if (malformed.length > 0) {
      console.error(
        'Invalid model id(s) in dispatch matrix. All real (non-mock) ids must use the\n' +
          'OpenRouter provider-prefixed form, e.g. anthropic/claude-sonnet-4-6.\n' +
          `Offending ids: ${malformed.join(', ')}\n` +
          `Current model list: ${models.join(', ')}`,
      );
      process.exit(1);
    }

    const nonAnthropicModels = realModels.filter((m) => !m.startsWith('anthropic/'));

    if (realModels.length > 0 && nonAnthropicModels.length === 0 && !allowSingleFamily) {
      console.error(
        'ADR-002 violation: at least one non-Anthropic model is required in the dispatch matrix.\n' +
          'Cross-provider second opinions are load-bearing for finding provider-family blind spots.\n' +
          'Set QA_ALLOW_SINGLE_FAMILY=1 to override (testing only).\n' +
          `Current model list: ${models.join(', ')}`,
      );
      process.exit(1);
    }

    // Key check (after ADR-002): OpenRouter is the single dispatch path. Any
    // real (non-mock) model in the matrix requires OPENROUTER_API_KEY.
    if (realModels.length > 0 && !process.env.OPENROUTER_API_KEY) {
      console.error(
        `OPENROUTER_API_KEY is not set but real models were requested: ${realModels.join(', ')}`,
      );
      process.exit(1);
    }
  }

  // 3. Load findings
  const findingsPath = path.join(runDir, 'findings.json');
  let rawRun: RawRunJson;
  try {
    const text = await fs.readFile(findingsPath, 'utf-8');
    rawRun = JSON.parse(text) as RawRunJson;
  } catch (err) {
    console.error(`Failed to read ${findingsPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Reject inputs that pre-date ADR-015. The harness_sha field is required;
  // older artifacts carry `meta.build` instead and would otherwise pass
  // `undefined` through serialization, yielding "Harness SHA: undefined" in
  // the rendered report and silently degrading run provenance.
  if (typeof rawRun.harness_sha !== 'string' || rawRun.harness_sha.length === 0) {
    const legacy = (rawRun as unknown as { build?: unknown }).build;
    const detail =
      typeof legacy === 'string' && legacy.length > 0
        ? ` Found legacy meta.build='${legacy}'; ADR-015 renamed this to meta.harness_sha and the dispatcher does not back-compat the old name.`
        : '';
    console.error(
      `findings.json at ${findingsPath} is missing meta.harness_sha (got ${JSON.stringify(rawRun.harness_sha)}).${detail} Re-run the journey to regenerate findings.json under the current schema.`,
    );
    process.exit(1);
  }

  const allFindings: StepFinding[] = rawRun.findings ?? [];

  // 3a. Partition: skip auth-blocked placeholder findings before fan-out.
  // These are emitted by journeys that bailed because the auth fixture was
  // missing (or no join code was available). Sending them to three models
  // costs real money and produces "yes this placeholder is fine" judgments.
  // Skipped findings are pulled out entirely (no DispatchedFinding entry);
  // they surface only as a count in meta.skipped, which threads through to
  // dedup and the final report.
  const findingsToDispatch: StepFinding[] = [];
  const skipped: SkippedFinding[] = [];
  for (const f of allFindings) {
    if (shouldSkipFinding(f)) {
      skipped.push({
        step_id: f.step_id,
        title: f.title,
        reason: 'auth-blocked-placeholder',
      });
    } else {
      findingsToDispatch.push(f);
    }
  }
  skipped.sort((a, b) => a.step_id.localeCompare(b.step_id));

  if (skipped.length > 0) {
    process.stderr.write(
      `note: skipped ${skipped.length} auth-blocked findings (saves model dispatch)\n`,
    );
  }

  const findings = findingsToDispatch;

  // 4. Handle empty input
  if (findings.length === 0) {
    if (allFindings.length === 0) {
      console.error('No findings in input. Writing empty dispatched run.');
    } else {
      console.error(
        `All ${allFindings.length} findings were skipped. Writing empty dispatched run.`,
      );
    }
    const emptyRun: DispatchedRun = {
      meta: {
        run_id: rawRun.run_id,
        timestamp: rawRun.timestamp,
        target: rawRun.target,
        harness_sha: rawRun.harness_sha,
        target_deployment: rawRun.target_deployment ?? null,
        models,
        skipped,
      },
      findings: [],
      dispatch_errors: [],
    };
    const outPath = path.join(runDir, 'findings.dispatched.json');
    await fs.writeFile(outPath, stableStringify(emptyRun));
    console.error(`Wrote empty dispatched run to ${outPath}`);
    return;
  }

  const dispatchErrors: DispatchError[] = [];
  const screenshotCache = new Map<string, string | null>();

  // Two semaphores: one for the openrouter dispatch path, one for mock.
  const openrouterLimit = semaphore(concurrency);
  const mockLimit = semaphore(concurrency);

  function limiterFor(model: string): ReturnType<typeof semaphore> {
    if (isMockModel(model) || mockDispatch) return mockLimit;
    return openrouterLimit;
  }

  // 5. Load screenshots (preload all)
  // We preload with 'all-models' as placeholder; errors are deduplicated per screenshot path.
  const screenshotPaths = new Set(
    findings.filter((f) => f.screenshot_path).map((f) => f.screenshot_path!),
  );

  for (const sp of screenshotPaths) {
    // Load once; errors are matrix-level (step_id: null) as they are per-path, not per finding-model pair.
    const firstModel = models[0] ?? 'unknown';
    await loadScreenshot(sp, null, firstModel, dispatchErrors, screenshotCache);
  }

  // 6. Fan-out (AP#6: never await serially in the loop)
  type TaskResult =
    | { ok: true; finding: StepFinding; model: string; judgment: ModelJudgment }
    | { ok: false; finding: StepFinding; model: string; error: string };

  const tasks = findings.flatMap((f) =>
    models.map((m) => {
      const limit = limiterFor(m);
      const provider = resolveProvider(m, mockDispatch);
      const screenshotB64 = f.screenshot_path
        ? (screenshotCache.get(f.screenshot_path) ?? null)
        : null;

      return limit(() =>
        provider
          .dispatch(m, f, screenshotB64)
          .then((judgment): TaskResult => ({ ok: true, finding: f, model: m, judgment }))
          .catch((err): TaskResult => ({
            ok: false,
            finding: f,
            model: m,
            error: err instanceof Error ? err.message : String(err),
          })),
      );
    }),
  );

  const settled = await Promise.allSettled(tasks);

  // 7. Aggregate
  // Build a map keyed on (project, step_id). A combined multi-project
  // findings.json legitimately holds two findings that share a step_id (one
  // per Playwright project, e.g. chromium-desktop and mobile-iphone-13 both
  // emitting J1/01), so a step_id-only key would let the second project's
  // finding overwrite the first here, and its per-model judgments would
  // clobber the first's at lookup time. The project-qualified key keeps both
  // findings and their judgments distinct through fan-out and aggregation.
  const findingMap = new Map<string, DispatchedFinding>();
  for (const f of findings) {
    findingMap.set(findingKey(f), {
      ...f,
      model_judgments: {},
    });
  }

  for (const result of settled) {
    if (result.status === 'rejected') {
      // Belt-and-suspenders: tasks already catch internally, but if the semaphore itself rejects
      dispatchErrors.push({
        model: 'unknown',
        step_id: null,
        message: `Unexpected task rejection: ${String(result.reason)}`,
      });
      continue;
    }

    const val = result.value;
    if (!val.ok) {
      dispatchErrors.push({
        model: val.model,
        step_id: val.finding.step_id,
        message: val.error,
      });
      continue;
    }

    const { finding, model, judgment } = val;

    // 8. step_id echo validation
    if (judgment.step_id !== finding.step_id) {
      process.stderr.write(
        `Warning: model ${model} returned step_id "${judgment.step_id}" ` +
          `but expected "${finding.step_id}". Coercing.\n`,
      );
      judgment.step_id = finding.step_id;
    }

    const dispatched = findingMap.get(findingKey(finding));
    if (dispatched) {
      dispatched.model_judgments[model] = judgment;
    }
  }

  // 9. Write output with deterministic ordering. Order by (project, step_id)
  // so two projects' findings for the same step_id both survive and sort
  // stably run-over-run.
  const sortedFindings = [...findingMap.values()].sort((a, b) => {
    const projectCmp = (a.project ?? '').localeCompare(b.project ?? '');
    if (projectCmp !== 0) return projectCmp;
    return a.step_id.localeCompare(b.step_id);
  });

  // Sort model_judgments keys within each finding
  for (const f of sortedFindings) {
    const sortedJudgments: Record<string, ModelJudgment> = {};
    for (const k of Object.keys(f.model_judgments).sort()) {
      sortedJudgments[k] = f.model_judgments[k]!;
    }
    f.model_judgments = sortedJudgments;
  }

  // Sort dispatch_errors for determinism
  const sortedErrors = [...dispatchErrors].sort((a, b) => {
    const stepCmp = (a.step_id ?? '').localeCompare(b.step_id ?? '');
    if (stepCmp !== 0) return stepCmp;
    return a.model.localeCompare(b.model);
  });

  const dispatchedRun: DispatchedRun = {
    meta: {
      run_id: rawRun.run_id,
      timestamp: rawRun.timestamp, // preserve from input, not regenerated
      target: rawRun.target,
      harness_sha: rawRun.harness_sha,
      target_deployment: rawRun.target_deployment ?? null,
      models,
      skipped,
    },
    findings: sortedFindings,
    dispatch_errors: sortedErrors,
  };

  const outPath = path.join(runDir, 'findings.dispatched.json');
  await fs.writeFile(outPath, stableStringify(dispatchedRun));

  const errorCount = sortedErrors.length;
  const findingCount = sortedFindings.length;
  console.error(
    `Dispatch complete: ${findingCount} findings, ${errorCount} errors. Output: ${outPath}`,
  );
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
