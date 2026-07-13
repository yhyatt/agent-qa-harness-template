/**
 * Final report generator.
 *
 * Reads findings.deduped.json from a QA run directory and renders a
 * structured markdown report grouped by disagreements first (AP#4),
 * then by severity and consensus type.
 *
 * Env vars:
 *   QA_RUN_DIR   path to the .qa-runs/<run> directory (default: latest under .qa-runs/)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DedupedRun, DedupedFinding } from './types.js';
import { formatTargetDeploymentLine } from './types.js';
import type { Severity, AxeSurface } from '../tests/e2e/journeys/helpers.js';

// ---------------------------------------------------------------------------
// Target-deployment header rendering (ADR-015 / B-HARNESS-8)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Find latest run directory (copied from dedup-findings.ts; not exported there).
// The pattern is path-safety only: it accepts both timestamp run-ids
// (e.g. 2026-05-22-14-30) and semantic run-ids (e.g. overnight-2026-05-22).
// The lookahead requires at least one alphanumeric, which rejects dot-segments
// ('.', '..', '...') so they fall through to the explicit-path branch in
// resolveRunDir instead of being joined into .qa-runs/.
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
  // Filter to candidate dirs that contain a findings.json marker, sort by
  // that file's mtime. See dedup-findings.ts findLatestRunDir for rationale.
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
// Resolve QA_RUN_DIR to an absolute path (cross-cutting fix: PR #1 / PR #2)
// ---------------------------------------------------------------------------

/**
 * Resolves the run directory from the QA_RUN_DIR env value.
 *
 * Accepted forms (applied in order):
 *  1. Undefined or empty -> use findLatestRunDir().
 *  2. Path-safe run-id matching RUN_DIR_PATTERN (timestamps like
 *     2026-05-22-14-30 and semantic names like overnight-2026-05-22):
 *     resolved under .qa-runs/.
 *  3. Contains '/' or '\\', starts with '.' or '/': treated as a path;
 *     relative paths resolved against REPO_ROOT.
 *  4. Anything else (unsafe characters): treated as a run-id under
 *     .qa-runs/ with a stderr note.
 */
async function resolveRunDir(raw: string | undefined): Promise<string> {
  if (!raw) {
    return findLatestRunDir();
  }
  // Test the path form first so values like '.audit-2026-05-22' or any other
  // dot-prefixed local path are treated as explicit paths even though the
  // path-safety regex would also accept them.
  if (raw.includes('/') || raw.includes('\\') || raw.startsWith('.') || raw.startsWith('/')) {
    return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
  }
  if (RUN_DIR_PATTERN.test(raw)) {
    return path.join(REPO_ROOT, '.qa-runs', raw);
  }
  // Unsafe characters: treat as run-id but warn.
  process.stderr.write(
    `[report] note: interpreting QA_RUN_DIR='${raw}' as a run id under .qa-runs/. ` +
      `Pass a full path or a run-id matching [a-z0-9._-]+ to suppress this note.\n`,
  );
  return path.join(REPO_ROOT, '.qa-runs', raw);
}

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  INFO: 0,
};

function cmpSeverityDesc(a: Severity, b: Severity): number {
  return SEVERITY_ORDER[b] - SEVERITY_ORDER[a];
}

function maxSeverity(severities: Severity[]): Severity {
  if (severities.length === 0) return 'INFO';
  return severities.reduce(
    (best, s) => (SEVERITY_ORDER[s] > SEVERITY_ORDER[best] ? s : best),
    'INFO' as Severity,
  );
}

// ---------------------------------------------------------------------------
// Screenshot path normalization
// ---------------------------------------------------------------------------

function normalizeScreenshotPath(p: string | undefined): string {
  if (!p) return 'none';
  if (!path.isAbsolute(p)) return p;
  const cwd = process.cwd();
  if (p.startsWith(cwd + path.sep) || p.startsWith(cwd + '/')) {
    return p.slice(cwd.length).replace(/^[/\\]/, '');
  }
  return p;
}

// ---------------------------------------------------------------------------
// Markdown inline escape helper
// ---------------------------------------------------------------------------

/**
 * Escape user- or model-controlled strings before interpolating them into a
 * markdown heading, bullet line, or table cell.
 *
 * Newlines break heading/bullet structure and allow heading injection.
 * This helper collapses CR/LF runs to a single space, then trims.
 * Apply this BEFORE the pipe-escape used in table cells.
 *
 * Also strips forbidden dash glyphs (AGENTS.md style rule):
 *   - em-dash (U+2014) → ", "
 *   - en-dash (U+2013) → ", "
 *   - double-hyphen surrounded by whitespace (casual separator) → ", "
 *     (only replaces " -- " patterns, not embedded flags like --flag)
 *
 * Note: multi-paragraph model judgments will appear as one line in bullet
 * output. That is intentional; block-level injection is not allowed.
 */
function escapeMarkdownInline(s: string): string {
  return s
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/—/g, ', ')   // em-dash → ", "
    .replace(/–/g, ', ')   // en-dash → ", "
    .replace(/\s--\s/g, ', ')   // space-surrounded double-hyphen → ", "
    .trim();
}

// ---------------------------------------------------------------------------
// Sentence helper
// ---------------------------------------------------------------------------

function firstSentence(text: string): string {
  // Split on first period followed by space or end-of-string (avoids e.g. "e.g." or decimals)
  const match = text.match(/^(.*?\.)\s/);
  if (match && match[1]) return match[1];
  // Fallback: if no such split, take up to 120 chars
  if (text.length <= 120) return text;
  return text.slice(0, 117) + '...';
}

// ---------------------------------------------------------------------------
// Truncation helper
// ---------------------------------------------------------------------------

const MAX_INLINE = 10;

function truncationNote(remaining: number): string {
  return `\n...and ${remaining} more (see \`findings.deduped.json\` for the full list)`;
}

// ---------------------------------------------------------------------------
// Finding body renderer (shared between unanimous and partial sections)
// ---------------------------------------------------------------------------

function renderFindingBody(
  f: DedupedFinding,
  opts: { partial?: boolean; compact?: boolean },
): string[] {
  const lines: string[] = [];

  if (opts.compact) {
    return lines; // compact sections handled inline
  }

  lines.push(`- Step: ${f.step_id} (${f.journey_id})`);
  lines.push(`- Project: ${escapeMarkdownInline(f.project ?? 'unknown')}`);
  lines.push(`- Action: ${escapeMarkdownInline(f.action)}`);
  lines.push(`- Screenshot: ${normalizeScreenshotPath(f.screenshot_path)}`);

  if (f.console_errors.length > 0) {
    lines.push(`- Console errors: ${f.console_errors.map(escapeMarkdownInline).join('; ')}`);
  } else {
    lines.push('- Console errors: none');
  }

  if (f.network_failures.length > 0) {
    lines.push(`- Network failures: ${f.network_failures.map(escapeMarkdownInline).join('; ')}`);
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
    f.axe_top3.length > 0 ? ` (${f.axe_top3.slice(0, 3).map(escapeMarkdownInline).join(', ')})` : '';
  lines.push(`- Axe: ${axeLabel}${top3str}`);

  // Consensus judgment: use first non-erroring model's judgment
  const sortedModels = Object.keys(f.model_judgments).sort();
  const firstOk = sortedModels.find((m) => !f.model_judgments[m]?.error);
  if (firstOk) {
    const j = f.model_judgments[firstOk]!;
    lines.push(`- Consensus judgment: ${escapeMarkdownInline(j.judgment)} (${firstOk})`);
  }

  if (opts.partial) {
    // Find the N-1 dissenting model
    const failCount = f.fail_count;
    const totalCount = f.total_count;
    const majorityFail = failCount > totalCount / 2;

    // Dissenter is the one not in the majority
    const dissenters = sortedModels.filter((m) => {
      const j = f.model_judgments[m];
      if (!j || j.error) return false;
      return majorityFail ? j.pass === true : j.pass === false;
    });

    if (dissenters.length > 0) {
      for (const d of dissenters) {
        const dj = f.model_judgments[d]!;
        lines.push(`- Dissenting model: ${d} | ${escapeMarkdownInline(dj.judgment)}`);
      }
    }

    lines.push(`- Majority verdict: ${majorityFail ? 'fail' : 'pass'}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Disagreement renderer
// ---------------------------------------------------------------------------

function renderDisagreementEntry(f: DedupedFinding): string[] {
  const lines: string[] = [];
  lines.push('', `### ${f.severity}: ${escapeMarkdownInline(f.title)}`);
  lines.push(`- Step: ${f.step_id} (${f.journey_id})`);
  lines.push(`- Project: ${escapeMarkdownInline(f.project ?? 'unknown')}`);
  lines.push(`- Action: ${escapeMarkdownInline(f.action)}`);
  lines.push(`- Screenshot: ${normalizeScreenshotPath(f.screenshot_path)}`);

  // Model verdicts table
  lines.push('- Model verdicts:');
  lines.push('  | model | pass | confidence | judgment (first sentence) |');
  lines.push('  |-------|------|------------|---------------------------|');
  for (const model of Object.keys(f.model_judgments).sort()) {
    const j = f.model_judgments[model]!;
    const passStr = j.error ? 'error' : j.pass ? 'yes' : 'no';
    const confStr = j.error ? 'n/a' : j.confidence.toFixed(2);
    const rawSnippet = j.error ? `error: ${j.error}` : firstSentence(j.judgment);
    const judgSnippet = escapeMarkdownInline(rawSnippet).replace(/\|/g, '\\|');
    lines.push(`  | ${model} | ${passStr} | ${confStr} | ${judgSnippet} |`);
  }

  // Full judgments
  lines.push('- Full judgments:');
  for (const model of Object.keys(f.model_judgments).sort()) {
    const j = f.model_judgments[model]!;
    if (j.error) {
      lines.push(`  - ${model}: error: ${escapeMarkdownInline(j.error)}`);
    } else {
      lines.push(`  - ${model}: ${escapeMarkdownInline(j.judgment)}`);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Section renderer for severity buckets
// ---------------------------------------------------------------------------

function renderSeveritySection(
  label: string,
  findings: DedupedFinding[],
  emptyMsg: string,
  compact: boolean,
  partial: boolean,
): string[] {
  const lines: string[] = ['', `## ${label}`];

  if (findings.length === 0) {
    lines.push('', emptyMsg);
    return lines;
  }

  const sorted = [...findings].sort((a, b) => {
    const si = a.step_id.localeCompare(b.step_id);
    if (si !== 0) return si;
    return a.title.localeCompare(b.title);
  });

  const shown = sorted.slice(0, MAX_INLINE);
  const remaining = sorted.length - MAX_INLINE;

  for (const f of shown) {
    if (compact) {
      // One-liner per finding
      const failInfo =
        partial
          ? ` (${f.fail_count}/${f.total_count} models failed)`
          : f.fail_count === f.total_count && f.total_count > 0
            ? ` (${f.total_count}/${f.total_count} models failed)`
            : ` (all pass)`;
      const projectTag = ` [${escapeMarkdownInline(f.project ?? 'unknown')}]`;
      lines.push(`- ${f.step_id}${projectTag}: ${escapeMarkdownInline(f.title)}${failInfo}`);
    } else {
      const headLabel = partial ? `${f.severity} (N-1 dissent)` : f.severity;
      lines.push('', `### ${headLabel}: ${escapeMarkdownInline(f.title)}`);
      lines.push(...renderFindingBody(f, { partial, compact: false }));
    }
  }

  if (remaining > 0) {
    lines.push(truncationNote(remaining));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Raw findings JSON shape (for axe_surfaces and results)
// ---------------------------------------------------------------------------

interface RawJourneyResult {
  id: string;
  status: string;
  durationMs: number;
  finding_count: number;
  /** Playwright project this journey ran under. Absent on pre-ADR-016 artifacts. */
  project?: string;
}

interface RawRunJson {
  axe_surfaces?: AxeSurface[];
  results?: RawJourneyResult[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Parse env
  const runDir = await resolveRunDir(process.env.QA_RUN_DIR);

  // 2. Load input
  const dedupedPath = path.join(runDir, 'findings.deduped.json');
  let run: DedupedRun;
  try {
    const text = await fs.readFile(dedupedPath, 'utf-8');
    run = JSON.parse(text) as DedupedRun;
  } catch (err) {
    console.error(
      `Failed to read ${dedupedPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // 3. Optionally load axe_surfaces and journey results from upstream findings.json
  let axeSurfaces: AxeSurface[] = [];
  let axeFallback = false;
  let rawJourneyResults: RawJourneyResult[] | null = null;
  const rawFindingsPath = path.join(runDir, 'findings.json');
  try {
    const rawText = await fs.readFile(rawFindingsPath, 'utf-8');
    const raw = JSON.parse(rawText) as RawRunJson;
    if (Array.isArray(raw.axe_surfaces) && raw.axe_surfaces.length > 0) {
      axeSurfaces = raw.axe_surfaces as AxeSurface[];
    } else {
      axeFallback = true;
    }
    if (Array.isArray(raw.results) && raw.results.length > 0) {
      rawJourneyResults = raw.results;
    }
  } catch {
    // findings.json is optional; fallback to aggregation from deduped findings below
    axeFallback = true;
    process.stderr.write(
      `note: findings.json not found alongside findings.deduped.json; summary may omit zero-finding journeys.\n`,
    );
  }

  const { meta, unanimous_findings, partial_findings, disagreements, stats, dispatch_errors } = run;

  const allFindings = [...unanimous_findings, ...partial_findings, ...disagreements];

  // 4. Build axe_surfaces from deduped findings if not from upstream
  if (axeSurfaces.length === 0) {
    // Aggregate unique routes from all findings that have axe violations or scan failures.
    // axe_violations === -1 means scan failed (not zero violations); include those distinctly.
    // axe_violations === null means axe was not run on that step (ADR-013); skip those:
    // they are not "scanned and clean", they were simply never attempted.
    const routeMap = new Map<string, { violations: number; top3: string[] }>();
    for (const f of allFindings) {
      if (f.axe_violations === null || f.axe_violations === 0) continue;
      const violations = f.axe_violations;
      const route = f.step_id; // use step_id as route key since route is not available
      const existing = routeMap.get(route);
      if (!existing) {
        routeMap.set(route, { violations, top3: f.axe_top3 });
      } else if (violations > existing.violations) {
        // Keep the higher signal: a positive count beats a prior -1 (scan
        // failure); a higher count beats a lower count. The zero case is
        // never reached because zero is filtered out above.
        routeMap.set(route, { violations, top3: f.axe_top3 });
      }
    }
    axeSurfaces = [...routeMap.entries()].map(([route, data]) => ({
      route,
      project: 'aggregated',
      violations: data.violations,
      top3: data.top3,
    }));
  }

  // 5. Compute journey summaries, keyed by (journey_id, project).
  // A multi-project run has the same journey_id under two projects (ADR-016);
  // keying on the pair keeps their rows distinguishable instead of collapsing
  // desktop and mobile into one. Seed the pairs from findings.json results
  // (captures zero-finding journeys) and from the deduped findings themselves.
  // project is absent on pre-ADR-016 artifacts, so it defaults to 'unknown'.
  const projectOf = (p: string | undefined): string => p ?? 'unknown';
  // Map key is JSON.stringify([id, project]): text-safe and collision-proof
  // (no delimiter char can appear inside a real id or project name, unlike a
  // raw separator).
  const journeyKeys = new Map<string, { id: string; project: string }>();
  const addJourneyKey = (id: string, project: string | undefined): void => {
    const p = projectOf(project);
    journeyKeys.set(JSON.stringify([id, p]), { id, project: p });
  };
  if (rawJourneyResults) {
    for (const r of rawJourneyResults) addJourneyKey(r.id, r.project);
  }
  for (const f of allFindings) addJourneyKey(f.journey_id, f.project);

  const journeySummaries: Array<{
    id: string;
    project: string;
    status: 'ok' | 'issues';
    findingCount: number;
    agreementPct: number;
    highestSeverity: Severity;
  }> = [];

  const sortedJourneyKeys = [...journeyKeys.values()].sort(
    (a, b) => a.id.localeCompare(b.id) || a.project.localeCompare(b.project),
  );

  for (const { id: jid, project } of sortedJourneyKeys) {
    const inScope = (f: DedupedFinding): boolean =>
      f.journey_id === jid && projectOf(f.project) === project;
    const jFindings = allFindings.filter(inScope);
    const findingCount = jFindings.length;

    // status: "issues" if ANY of:
    //   1. Any unanimous finding for this journey has all models failing (original logic).
    //   2. Any partial_findings entry for this journey has majority fail (fail_count > total_count/2).
    //   3. Any disagreement entry for this journey is at HIGH severity.
    const hasUnanimousIssue = unanimous_findings
      .filter(inScope)
      .some((f) => f.fail_count === f.total_count && f.total_count > 0);

    const hasMajorityFailPartial = partial_findings
      .filter(inScope)
      .some((f) => f.fail_count > f.total_count / 2);

    const hasHighDisagreement = disagreements
      .filter(inScope)
      .some((f) => f.severity === 'HIGH');

    const status: 'ok' | 'issues' =
      hasUnanimousIssue || hasMajorityFailPartial || hasHighDisagreement ? 'issues' : 'ok';

    // agreement: average of majority agreement across this journey's findings
    let agreedPairs = 0;
    let totalPairs = 0;
    for (const f of jFindings) {
      const n = f.total_count;
      const fc = f.fail_count;
      totalPairs += n;
      agreedPairs += Math.max(fc, n - fc);
    }
    const agreementPct =
      totalPairs === 0 ? 0 : Math.round((agreedPairs / totalPairs) * 1000) / 10;

    const highestSeverity = maxSeverity(jFindings.map((f) => f.severity));

    journeySummaries.push({ id: jid, project, status, findingCount, agreementPct, highestSeverity });
  }

  // 6. Separate findings by severity and type
  const severities: Severity[] = ['HIGH', 'MEDIUM', 'LOW', 'INFO'];

  // Sort disagreements by severity desc, then step_id
  const sortedDisagreements = [...disagreements].sort((a, b) => {
    const sc = cmpSeverityDesc(a.severity, b.severity);
    if (sc !== 0) return sc;
    return a.step_id.localeCompare(b.step_id);
  });

  // 7. Render report
  const lines: string[] = [];

  // Header
  lines.push(`# QA run: ${meta.timestamp}`);
  lines.push('');
  lines.push(`Target: ${meta.target}`);
  lines.push(`Target deployment: ${formatTargetDeploymentLine(meta.target_deployment ?? null)}`);
  lines.push(`Harness SHA: ${meta.harness_sha}`);
  lines.push(`Run dir: ${runDir}`);
  lines.push(`Models: ${meta.models.length > 0 ? meta.models.join(', ') : '(none)'}`);

  // Summary
  lines.push('', '## Summary', '');
  if (journeySummaries.length === 0) {
    lines.push('No journeys in this run.');
  } else {
    for (const j of journeySummaries) {
      const label = `${j.id} [${escapeMarkdownInline(j.project)}]`;
      if (j.findingCount === 0) {
        lines.push(`- ${label}: ${j.status} (0 findings)`);
      } else {
        lines.push(
          `- ${label}: ${j.status} (${j.findingCount} findings, ${j.agreementPct.toFixed(1)}% agreement, ${j.highestSeverity})`,
        );
      }
    }
  }

  // Disagreements (AP#4: first)
  lines.push('', '## Disagreements', '');
  if (sortedDisagreements.length === 0) {
    lines.push('No disagreements between models.');
  } else {
    const shown = sortedDisagreements.slice(0, MAX_INLINE);
    const remaining = sortedDisagreements.length - MAX_INLINE;
    for (const f of shown) {
      lines.push(...renderDisagreementEntry(f));
    }
    if (remaining > 0) {
      lines.push(truncationNote(remaining));
    }
  }

  // Per-severity sections (unanimous + partial)
  for (const sev of severities) {
    const compact = sev === 'INFO';

    const unanFindings = unanimous_findings.filter((f) => f.severity === sev);
    const partFindings = partial_findings.filter((f) => f.severity === sev);

    // Unanimous
    lines.push(
      ...renderSeveritySection(
        `${sev} unanimous findings`,
        unanFindings,
        `No ${sev} unanimous findings.`,
        compact,
        false,
      ),
    );

    // Partial
    lines.push(
      ...renderSeveritySection(
        `${sev} partial findings (N-1 dissent)`,
        partFindings,
        `No ${sev} partial findings.`,
        compact,
        true,
      ),
    );
  }

  // Axe a11y summary
  lines.push('', '## Axe a11y summary (per surface)', '');
  if (axeSurfaces.length === 0) {
    lines.push('No axe surfaces recorded.');
  } else {
    if (axeFallback) {
      lines.push(
        '> Note: `axe_surfaces` not present in upstream `findings.json`; rendering per-step axe data instead.',
        '',
      );
    }
    lines.push('| route | violations | top issue |');
    lines.push('|-------|------------|-----------|');
    for (const s of axeSurfaces) {
      const violLabel = s.violations < 0 ? 'scan failed' : String(s.violations);
      const topIssue = escapeMarkdownInline(s.top3.length > 0 ? (s.top3[0] ?? '') : 'none').replace(/\|/g, '\\|');
      const safeRoute = escapeMarkdownInline(s.route).replace(/\|/g, '\\|');
      lines.push(`| ${safeRoute} | ${violLabel} | ${topIssue} |`);
    }
  }

  // Stats
  lines.push('', '## Stats', '');

  const agreementDisplay =
    stats.total_raw === 0
      ? 'no findings to evaluate'
      : `${(stats.agreement_rate * 100).toFixed(1)}%`;

  lines.push(`- Total raw findings: ${stats.total_raw}`);
  lines.push(`- After dedup: ${stats.after_dedup}`);
  lines.push(`- Agreement rate: ${agreementDisplay}`);

  // Skipped placeholder findings (auth-blocked etc). Defensive read so the
  // report does not crash on a findings.deduped.json predating this field.
  const skipped = meta.skipped ?? [];
  if (skipped.length > 0) {
    lines.push(`- Skipped placeholder findings: ${skipped.length} (auth-blocked, not dispatched)`);
  }

  const perModelStr = Object.entries(stats.per_model_finding_counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, c]) => `${m} (${c})`)
    .join(', ');
  lines.push(`- Per-model fail counts: ${perModelStr || 'none'}`);

  // Per-model parse-error counts. Annotate '(degraded)' when a model's
  // parse-error rate exceeds 20% of judgments the model actually returned.
  // The denominator is per_model_total_judgments[m] (valid + errored),
  // populated by the dedup pass. This excludes (finding, model) pairs
  // where the model had no entry at all (e.g. matrix-level dispatch_errors),
  // so the rate reflects "of the judgments that came back, what fraction
  // failed to parse" rather than "of the dispatches attempted".
  // Defensive read with ?? {} so the report does not crash on an older
  // findings.deduped.json that predates these stats fields.
  const parseErrorCounts = stats.per_model_parse_error_counts ?? {};
  const totalJudgments = stats.per_model_total_judgments ?? {};
  const parseErrorEntries = Object.entries(parseErrorCounts).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const parseErrorStr = parseErrorEntries
    .map(([m, errs]) => {
      const denom = totalJudgments[m] ?? 0;
      const rate = denom > 0 ? errs / denom : 0;
      const degraded = rate > 0.2 ? ' (degraded)' : '';
      return `${m} (${errs}/${denom})${degraded}`;
    })
    .join(', ');
  lines.push(`- Per-model parse-error counts: ${parseErrorStr || 'none'}`);

  if (stats.dispatch_error_count > 0) {
    lines.push(`- Dispatch errors: ${stats.dispatch_error_count}`);
    const firstFive = dispatch_errors.slice(0, 5);
    for (const e of firstFive) {
      lines.push(`  - ${escapeMarkdownInline(e.model)}: ${escapeMarkdownInline(e.step_id ?? 'matrix-level')}: ${escapeMarkdownInline(e.message)}`);
    }
  } else {
    lines.push('- Dispatch errors: 0');
  }

  if (stats.warning) {
    lines.push(`- Warning: ${stats.warning}`);
  }

  // Write output
  const reportPath = path.join(runDir, 'REPORT.final.md');
  const content = lines.join('\n') + '\n';
  await fs.writeFile(reportPath, content);

  const findingCount = allFindings.length;
  const disCount = disagreements.length;
  const chars = content.length;
  console.log(`report: ${chars} chars, ${findingCount} findings, ${disCount} disagreements, ${runDir}`);
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
