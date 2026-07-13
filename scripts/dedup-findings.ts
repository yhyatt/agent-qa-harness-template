/**
 * Cross-model finding deduplication.
 *
 * Reads findings.dispatched.json from a QA run directory, groups findings
 * by dedup key, classifies them as unanimous, partial, or disagreement,
 * and writes findings.deduped.json.
 *
 * Env vars:
 *   QA_RUN_DIR   path to the .qa-runs/<run> directory (default: latest under .qa-runs/)
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Severity } from './types.js';
import type {
  DispatchedRun,
  ModelJudgment,
  DedupedFinding,
  DedupedRun,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Find latest run directory (mirrors multi-model-dispatch.ts).
// The pattern is path-safety only: it accepts both timestamp run-ids
// (e.g. 2026-05-22-14-30) and semantic run-ids (e.g. overnight-2026-05-22)
// while rejecting characters that would break path handling. The lookahead
// requires at least one alphanumeric, which rejects dot-segments ('.', '..',
// '...') so they fall through to the explicit-path branch in resolveRunDir
// instead of being joined into .qa-runs/.
// ---------------------------------------------------------------------------

const RUN_DIR_PATTERN = /^(?=.*[a-z0-9])[a-z0-9._-]+$/i;

// .qa-runs/ also houses utility directories that match the path-safety
// regex but are not runs. Exclude them from the latest-run scan so that
// when latest.txt is missing or stale, the fallback does not pick one.
const RUN_DIR_DENYLIST = new Set(['playwright-output', 'userDataDir']);

async function findLatestRunDir(): Promise<string> {
  const base = path.resolve(REPO_ROOT, '.qa-runs');

  // Prefer the pointer written by playwright.config.ts at run time.
  // Fall back to scan+sort if the file is absent or contains an invalid value.
  const latestFile = path.join(base, 'latest.txt');
  try {
    const candidate = (await fs.readFile(latestFile, 'utf-8')).trim();
    if (RUN_DIR_PATTERN.test(candidate) && !RUN_DIR_DENYLIST.has(candidate)) {
      const resolved = path.join(base, candidate);
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
  // Filter to candidate dirs that match the path-safety regex and are not on
  // the denylist, then keep only those containing a findings.json marker.
  // findings.json is written once by the journey runtime at run end and is
  // never rewritten by dispatch/dedup/report, so its mtime is the true
  // run-finish time and is not perturbed by later post-processing of an
  // older run. Requiring the marker also rejects arbitrary user-created
  // directories under .qa-runs/ that the static denylist would otherwise miss.
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
// Deterministic JSON serializer (mirrors multi-model-dispatch.ts)
// ---------------------------------------------------------------------------

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
// Dedup key helpers
// ---------------------------------------------------------------------------

/**
 * Identity function for now. Kept as a named function so future severity
 * bucket merging (e.g. collapsing HIGH and CRITICAL) is a single-site change.
 */
function severityBucket(s: Severity): Severity {
  return s;
}

/**
 * Lowercases, strips Unicode punctuation (\p{P}), collapses whitespace, trims.
 */
function normalizeTitle(t: string): string {
  // \p{P} requires the 'u' flag
  return t
    .toLowerCase()
    .replace(/\p{P}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes a 12-char hex sha1 dedup key.
 *
 * The key uses the *input* finding's severity, not any model-adjusted severity.
 * Cross-severity divergence (model A says HIGH, model B says MEDIUM on the same
 * logical finding) is surfaced via cross_severity_warning rather than by merging
 * two separate dedup keys. See cross-severity collision detection below.
 *
 * `project` was added so a multi-project harness run (e.g. chromium-desktop
 * and mobile-iphone-13) does not collapse two distinct findings that share a
 * journey_id/step_id/title but come from different Playwright projects. A
 * single-project or multi-model run has a constant `project` value across
 * every finding, so the tuple, and therefore the grouping, is unchanged from
 * before this field existed.
 *
 * The tuple is JSON.stringify-encoded before hashing rather than joined with a
 * raw `|`, so a `|` inside any field cannot shift the field boundaries and
 * collide with a different tuple. This changes the hash VALUES from earlier
 * runs, which is fine: dedup_key is an opaque intra-run grouping id, never
 * compared across runs, and grouping behavior for a given input is identical.
 */
function dedupKey(
  journey_id: string,
  step_id: string,
  severity: Severity,
  project: string,
  title: string,
): string {
  const tuple = JSON.stringify([
    journey_id,
    step_id,
    severityBucket(severity),
    project,
    normalizeTitle(title),
  ]);
  return createHash('sha1').update(tuple).digest('hex').slice(0, 12);
}

/**
 * Compound (project, step_id) key for cross-severity collision tracking. A
 * combined multi-project run holds two findings that share a step_id (one per
 * Playwright project), so keying the collision map on step_id alone would
 * mislabel them as a cross-severity collision. Scoping to (project, step_id)
 * compares within a single project+step. Findings written before the project
 * field existed map to a single project-agnostic bucket via `?? ''`.
 *
 * JSON.stringify-encoded rather than a raw `|` join because step_id and the
 * free-form project name could contain the delimiter; a structured array
 * encoding cannot collide across different field splits.
 */
function stepKey(project: string, step_id: string): string {
  return JSON.stringify([project, step_id]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Parse env
  let runDir = process.env.QA_RUN_DIR ?? '';
  if (!runDir) {
    runDir = await findLatestRunDir();
  } else if (!path.isAbsolute(runDir)) {
    runDir = path.resolve(REPO_ROOT, runDir);
  }

  // 2. Load input
  const inputPath = path.join(runDir, 'findings.dispatched.json');
  let dispatchedRun: DispatchedRun;
  try {
    const text = await fs.readFile(inputPath, 'utf-8');
    dispatchedRun = JSON.parse(text) as DispatchedRun;
  } catch (err) {
    console.error(
      `Failed to read ${inputPath}: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  const { meta, findings, dispatch_errors } = dispatchedRun;

  // 3. Handle empty input gracefully (do not throw)
  if (findings.length === 0) {
    const emptyRun: DedupedRun = {
      meta,
      unanimous_findings: [],
      partial_findings: [],
      disagreements: [],
      stats: {
        total_raw: 0,
        after_dedup: 0,
        agreement_rate: 0,
        per_model_finding_counts: Object.fromEntries(
          [...meta.models].sort().map((m) => [m, 0]),
        ),
        per_model_parse_error_counts: Object.fromEntries(
          [...meta.models].sort().map((m) => [m, 0]),
        ),
        per_model_total_judgments: Object.fromEntries(
          [...meta.models].sort().map((m) => [m, 0]),
        ),
        dispatch_error_count: dispatch_errors.length,
        ...(meta.models.length === 1 ? { warning: 'single-model run' } : {}),
      },
      dispatch_errors,
    };
    const outPath = path.join(runDir, 'findings.deduped.json');
    await fs.writeFile(outPath, stableStringify(emptyRun));
    console.log('dedup: 0 findings into 0 unanimous, 0 partial, 0 disagreement; agreement 0%');
    return;
  }

  // 4. Classify each finding
  const unanimous: DedupedFinding[] = [];
  const partial: DedupedFinding[] = [];
  const disagreements: DedupedFinding[] = [];

  // Accumulate stats as we go
  let totalRaw = 0;
  let agreedPairs = 0;

  // Per-model pass=false counts. Seed all models with 0.
  const perModelCounts: Record<string, number> = {};
  for (const m of meta.models) {
    perModelCounts[m] = 0;
  }

  // Per-model parse-error counts (judgment.error set). Seed all models with 0
  // so the report shows the full matrix even when no model errored.
  const perModelParseErrorCounts: Record<string, number> = {};
  for (const m of meta.models) {
    perModelParseErrorCounts[m] = 0;
  }

  // Per-model total judgments returned (valid + errored). Used as the
  // honest denominator for parse-error rate annotations. Seeded to 0.
  const perModelTotalJudgments: Record<string, number> = {};
  for (const m of meta.models) {
    perModelTotalJudgments[m] = 0;
  }

  // Cross-severity map: (project, step_id) -> Set of dedup_keys. Keyed on the
  // project-qualified step so two same-step findings from different projects
  // are not mistaken for a cross-severity collision.
  const stepKeyMap = new Map<string, Set<string>>();

  for (const finding of findings) {
    const judgments = Object.values(finding.model_judgments) as ModelJudgment[];

    // Filter out errored judgments; they don't count toward N
    const nonError = judgments.filter((j) => !j.error);
    const n = nonError.length;
    const failCount = nonError.filter((j) => j.pass === false).length;

    totalRaw += n;
    // majority size per finding: how many agreed with the majority direction
    agreedPairs += Math.max(failCount, n - failCount);

    // Per-model pass=false counts, parse-error counts, and total judgments.
    for (const [model, j] of Object.entries(finding.model_judgments)) {
      if (!(model in perModelTotalJudgments)) {
        // model not in meta.models (shouldn't happen, but be safe)
        perModelTotalJudgments[model] = 0;
      }
      perModelTotalJudgments[model]++;
      if (j.error) {
        if (!(model in perModelParseErrorCounts)) {
          perModelParseErrorCounts[model] = 0;
        }
        perModelParseErrorCounts[model]++;
        continue;
      }
      if (j.pass === false) {
        if (!(model in perModelCounts)) {
          perModelCounts[model] = 0;
        }
        perModelCounts[model]++;
      }
    }

    const key = dedupKey(
      finding.journey_id,
      finding.step_id,
      finding.severity,
      finding.project ?? '',
      finding.title,
    );

    // Track cross-severity collisions for this project+step
    const sKey = stepKey(finding.project ?? '', finding.step_id);
    if (!stepKeyMap.has(sKey)) {
      stepKeyMap.set(sKey, new Set());
    }
    stepKeyMap.get(sKey)!.add(key);

    // Build the base DedupedFinding (spread, do not mutate input)
    const dedupedBase: Omit<DedupedFinding, 'cross_severity_warning'> = {
      ...finding,
      dedup_key: key,
      fail_count: failCount,
      total_count: n,
    };

    // Classify into bucket
    if (n === 0) {
      // All models errored on this step. Not interesting but don't drop it.
      // Mark with notes so consumers can identify these entries.
      const withNotes: DedupedFinding = {
        ...dedupedBase,
        notes: (finding.notes ? finding.notes + '; ' : '') + 'all model judgments errored',
      };
      unanimous.push(withNotes);
    } else if (n === 1 || failCount === 0 || failCount === n) {
      // Single-model run: unanimous by definition.
      // All agreed: either all pass or all fail.
      unanimous.push({ ...dedupedBase });
    } else if (n >= 3 && (failCount === 1 || failCount === n - 1)) {
      // N-1 dissent (makes sense only for N >= 3; a 1-1 split is a disagreement)
      partial.push({ ...dedupedBase });
    } else {
      // Genuinely split
      disagreements.push({ ...dedupedBase });
    }
  }

  // 5. Cross-severity collision detection
  // Within a single (project, step_id), each step normally has exactly one
  // StepFinding so the set holds one key. A multi-project run legitimately has
  // multiple findings per step_id (one per Playwright project), but the map is
  // keyed on (project, step_id), so each project's step still resolves to its
  // own set and cross-project findings are not mistaken for a collision.
  // Multiple keys under one (project, step_id) can only arise if the same
  // project+step appeared with different severity values in different findings
  // (not possible with the current dispatcher output format). Implemented
  // anyway for correctness; cross_severity_warning is populated below if the
  // set size is > 1.
  //
  // Note: we key on the *input* finding's severity, not the model judgment's
  // severity. Model-adjusted severity divergence is not tracked here in v1.
  function attachCrossSeverityWarnings(arr: DedupedFinding[]): DedupedFinding[] {
    return arr.map((f) => {
      const siblings = stepKeyMap.get(stepKey(f.project ?? '', f.step_id));
      if (!siblings || siblings.size <= 1) return f;
      const others = [...siblings].filter((k) => k !== f.dedup_key).sort();
      return { ...f, cross_severity_warning: others };
    });
  }

  const unanimousSorted = attachCrossSeverityWarnings(
    unanimous.sort((a, b) =>
      a.dedup_key < b.dedup_key ? -1 : a.dedup_key > b.dedup_key ? 1 : a.step_id.localeCompare(b.step_id),
    ),
  );
  const partialSorted = attachCrossSeverityWarnings(
    partial.sort((a, b) =>
      a.dedup_key < b.dedup_key ? -1 : a.dedup_key > b.dedup_key ? 1 : a.step_id.localeCompare(b.step_id),
    ),
  );
  const disagreementsSorted = attachCrossSeverityWarnings(
    disagreements.sort((a, b) =>
      a.dedup_key < b.dedup_key ? -1 : a.dedup_key > b.dedup_key ? 1 : a.step_id.localeCompare(b.step_id),
    ),
  );

  // 6. Stats
  const agreementRate =
    totalRaw === 0 ? 0 : Math.round((agreedPairs / totalRaw) * 10000) / 10000;

  // Sort per-model counts alphabetically
  const perModelCountsSorted: Record<string, number> = {};
  for (const k of Object.keys(perModelCounts).sort()) {
    perModelCountsSorted[k] = perModelCounts[k]!;
  }

  const perModelParseErrorCountsSorted: Record<string, number> = {};
  for (const k of Object.keys(perModelParseErrorCounts).sort()) {
    perModelParseErrorCountsSorted[k] = perModelParseErrorCounts[k]!;
  }

  const perModelTotalJudgmentsSorted: Record<string, number> = {};
  for (const k of Object.keys(perModelTotalJudgments).sort()) {
    perModelTotalJudgmentsSorted[k] = perModelTotalJudgments[k]!;
  }

  const stats: DedupedRun['stats'] = {
    total_raw: totalRaw,
    after_dedup: findings.length,
    agreement_rate: agreementRate,
    per_model_finding_counts: perModelCountsSorted,
    per_model_parse_error_counts: perModelParseErrorCountsSorted,
    per_model_total_judgments: perModelTotalJudgmentsSorted,
    dispatch_error_count: dispatch_errors.length,
    ...(meta.models.length === 1 ? { warning: 'single-model run' } : {}),
  };

  // 7. Build output
  const dedupedRun: DedupedRun = {
    meta,
    unanimous_findings: unanimousSorted,
    partial_findings: partialSorted,
    disagreements: disagreementsSorted,
    stats,
    dispatch_errors,
  };

  // 8. Write output
  const outPath = path.join(runDir, 'findings.deduped.json');
  await fs.writeFile(outPath, stableStringify(dedupedRun));

  const U = unanimousSorted.length;
  const P = partialSorted.length;
  const D = disagreementsSorted.length;
  const pct = (agreementRate * 100).toFixed(2);
  console.log(
    `dedup: ${findings.length} findings into ${U} unanimous, ${P} partial, ${D} disagreement; agreement ${pct}%`,
  );
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
