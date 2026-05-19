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
import type { Severity, AxeSurface } from '../tests/e2e/journeys/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Find latest run directory (copied from dedup-findings.ts; not exported there)
// ---------------------------------------------------------------------------

const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}$/;

async function findLatestRunDir(): Promise<string> {
  const base = path.resolve(REPO_ROOT, '.qa-runs');
  let entries: string[];
  try {
    entries = await fs.readdir(base);
  } catch {
    throw new Error(
      `No .qa-runs/ directory found at ${base}. ` +
        'Run the Playwright harness first, or set QA_RUN_DIR.',
    );
  }
  const valid = entries.filter((e) => RUN_DIR_PATTERN.test(e));
  if (valid.length === 0) {
    throw new Error(
      `.qa-runs/ has no valid run directories (expected YYYY-MM-DD-HHmm format).`,
    );
  }
  const sorted = valid.sort();
  return path.join(base, sorted[sorted.length - 1]!);
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
 * Note: multi-paragraph model judgments will appear as one line in bullet
 * output. That is intentional — block-level injection is not allowed.
 */
function escapeMarkdownInline(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
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
    f.axe_violations < 0 ? 'scan failed' : `${f.axe_violations} violations`;
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
      lines.push(`- ${f.step_id}: ${escapeMarkdownInline(f.title)}${failInfo}`);
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
// Raw findings JSON shape (for axe_surfaces)
// ---------------------------------------------------------------------------

interface RawRunJson {
  axe_surfaces?: AxeSurface[];
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

  // 3. Optionally load axe_surfaces from upstream findings.json
  let axeSurfaces: AxeSurface[] = [];
  let axeFallback = false;
  const rawFindingsPath = path.join(runDir, 'findings.json');
  try {
    const rawText = await fs.readFile(rawFindingsPath, 'utf-8');
    const raw = JSON.parse(rawText) as RawRunJson;
    if (Array.isArray(raw.axe_surfaces) && raw.axe_surfaces.length > 0) {
      axeSurfaces = raw.axe_surfaces as AxeSurface[];
    } else {
      axeFallback = true;
    }
  } catch {
    // findings.json is optional; fallback to aggregation from deduped findings below
    axeFallback = true;
  }

  const { meta, unanimous_findings, partial_findings, disagreements, stats, dispatch_errors } = run;

  const allFindings = [...unanimous_findings, ...partial_findings, ...disagreements];

  // 4. Build axe_surfaces from deduped findings if not from upstream
  if (axeSurfaces.length === 0) {
    // Aggregate unique routes from all findings that have axe violations
    const routeMap = new Map<string, { violations: number; top3: string[] }>();
    for (const f of allFindings) {
      if (f.axe_violations > 0) {
        const route = f.step_id; // use step_id as route key since route is not available
        const existing = routeMap.get(route);
        if (!existing || f.axe_violations > existing.violations) {
          routeMap.set(route, { violations: f.axe_violations, top3: f.axe_top3 });
        }
      }
    }
    axeSurfaces = [...routeMap.entries()].map(([route, data]) => ({
      route,
      project: 'aggregated',
      violations: data.violations,
      top3: data.top3,
    }));
  }

  // 5. Compute journey summaries
  const journeyIds = new Set(allFindings.map((f) => f.journey_id));
  const journeySummaries: Array<{
    id: string;
    status: 'ok' | 'issues';
    findingCount: number;
    agreementPct: number;
    highestSeverity: Severity;
  }> = [];

  for (const jid of [...journeyIds].sort()) {
    const jFindings = allFindings.filter((f) => f.journey_id === jid);
    const findingCount = jFindings.length;

    // status: "issues" if any unanimous finding for this journey has all models failing
    const hasUnanimousIssue = unanimous_findings
      .filter((f) => f.journey_id === jid)
      .some((f) => f.fail_count === f.total_count && f.total_count > 0);
    const status: 'ok' | 'issues' = hasUnanimousIssue ? 'issues' : 'ok';

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

    journeySummaries.push({ id: jid, status, findingCount, agreementPct, highestSeverity });
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
  lines.push(`Build: ${meta.build}`);
  lines.push(`Run dir: ${runDir}`);
  lines.push(`Models: ${meta.models.length > 0 ? meta.models.join(', ') : '(none)'}`);

  // Summary
  lines.push('', '## Summary', '');
  if (journeySummaries.length === 0) {
    lines.push('No journeys in this run.');
  } else {
    for (const j of journeySummaries) {
      lines.push(
        `- ${j.id}: ${j.status} (${j.findingCount} findings, ${j.agreementPct.toFixed(1)}% agreement, ${j.highestSeverity})`,
      );
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

  const perModelStr = Object.entries(stats.per_model_finding_counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, c]) => `${m} (${c})`)
    .join(', ');
  lines.push(`- Per-model fail counts: ${perModelStr || 'none'}`);

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
