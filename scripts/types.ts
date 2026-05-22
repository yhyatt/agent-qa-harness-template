/**
 * Dispatcher types for multi-model-dispatch.ts.
 *
 * StepFinding, Severity, and Bucket are imported by reference only;
 * this module does not re-export them. See ADR-003: schema is locked.
 */

import type { StepFinding, Severity, Bucket } from '../tests/e2e/journeys/helpers.js';

// Re-export the imported types so callers can use them from one place
// without pulling in the Playwright-laden helpers module.
export type { Severity, Bucket };

export interface ModelJudgment {
  step_id: string;
  model: string;
  pass: boolean;
  severity: Severity;
  bucket: Bucket;
  /** ~150 words target. No em-dashes. */
  judgment: string;
  /** Each entry is one actionable specific concern. */
  concerns: string[];
  /** 0..1, reflecting confidence in the verdict given available evidence. */
  confidence: number;
  /** Populated when both dispatch retries failed. */
  error?: string;
  /** Raw model output preserved when error is set, for triage. */
  raw?: string;
}

/**
 * A finding augmented with per-model judgments.
 *
 * ADR-003: StepFinding is not extended. DispatchedFinding composes it.
 * Do not extend StepFinding directly.
 */
export interface DispatchedFinding extends StepFinding {
  model_judgments: Record<string, ModelJudgment>;
}

export interface DispatchError {
  model: string;
  /** null means a matrix-level error (e.g. provider 5xx before any step). */
  step_id: string | null;
  message: string;
}

/**
 * A finding that the dispatcher chose not to send to any model.
 *
 * Today this only covers auth-blocked placeholder findings (INFO/pass with a
 * title indicating the journey bailed because the auth fixture was absent).
 * Skipped findings flow through dedup and report rendering as a count in
 * meta.skipped; they never become DispatchedFinding entries.
 */
/**
 * Reason a finding was skipped from dispatch. Today only one literal value
 * is in use; future skip rules add new literals here so consumers can
 * narrow on them exhaustively.
 */
export type SkipReason = 'auth-blocked-placeholder';

export interface SkippedFinding {
  step_id: string;
  title: string;
  reason: SkipReason;
}

/**
 * Runtime-captured identity of the deployment a journey actually hit.
 *
 * Introduced in ADR-015 (B-HARNESS-8/9). Both pairs of fields are populated
 * by independent capture paths:
 *   - vercel_id / deployment_url: Playwright response listener on the first
 *     navigation, reading x-vercel-id and x-vercel-deployment-url.
 *   - build_commit / deployed_at: optional GET /__build fetch off the target
 *     URL (consumer-side convention; see docs/CUSTOMIZATION.md).
 *
 * Any individual field may be null on a non-Vercel host or when the target
 * app does not expose /__build. The outer field itself is null only when no
 * journey ran AND no headers were captured. Consumers MUST use `??`
 * defensively on every sub-field.
 */
export interface TargetDeployment {
  vercel_id: string | null;
  deployment_url: string | null;
  /** ISO 8601 timestamp of when the headers were captured. */
  captured_at: string;
  /** From /__build response body; null if endpoint absent or unreadable. */
  build_commit: string | null;
  /** ISO 8601 from /__build response body; null if endpoint absent. */
  deployed_at: string | null;
}

/**
 * Renders a TargetDeployment as a single markdown header line. Shared by the
 * journey-runtime sidecar (helpers.ts writeReport) and the post-dispatch
 * report (generate-report.ts), so the two stay in sync as fields are added.
 * Emits "unknown" when the field is null (older artifacts, or no journey
 * ran). Otherwise composes a comma-separated description of every non-null
 * sub-field, always including captured_at so the orchestration-time stamp
 * disambiguates capture from build and deploy timestamps.
 */
export function formatTargetDeploymentLine(td: TargetDeployment | null): string {
  if (td === null) return 'unknown';
  const parts: string[] = [];
  if (td.build_commit !== null) parts.push(td.build_commit);
  if (td.vercel_id !== null) parts.push(`Vercel ${td.vercel_id}`);
  if (td.deployment_url !== null) parts.push(td.deployment_url);
  if (td.deployed_at !== null) parts.push(`deployed ${td.deployed_at}`);
  parts.push(`captured ${td.captured_at}`);
  return parts.join(', ');
}

export interface DispatchedRun {
  meta: {
    run_id: string;
    timestamp: string;
    target: string;
    /**
     * Short git SHA of the consuming repo at harness run time (the QA harness
     * itself, NOT the target app). Renamed from `build` in ADR-015 after a
     * downstream validator confused it for the target app's deployed commit.
     * For target-app identity, see target_deployment.
     */
    harness_sha: string;
    /**
     * Identity of the deployment the journey hit. Optional on the type so
     * older artifacts written before ADR-015 (Slice 6) deserialize cleanly;
     * the harness always writes the field on fresh runs. Consumers MUST use
     * `meta.target_deployment ?? null` defensively when reading from disk.
     */
    target_deployment?: TargetDeployment | null;
    models: string[];
    /**
     * Findings the dispatcher chose not to send to any model. Sorted by
     * step_id for determinism. Pass-through into DedupedRun so the final
     * report can surface a count. Optional so older artifacts written
     * before Slice 2 deserialize cleanly; consumers MUST use `meta.skipped
     * ?? []` defensively when reading from disk.
     */
    skipped?: SkippedFinding[];
  };
  findings: DispatchedFinding[];
  dispatch_errors: DispatchError[];
}

// ---------------------------------------------------------------------------
// Dedup output types (produced by dedup-findings.ts)
// ---------------------------------------------------------------------------

export interface DedupedFinding extends DispatchedFinding {
  /** sha1 hash, 12 hex chars. Derived from journey_id|step_id|severityBucket|normalizedTitle. */
  dedup_key: string;
  /** count of models that returned pass=false (excluding errored judgments). */
  fail_count: number;
  /** count of models that returned a valid judgment (excluding errored judgments). */
  total_count: number;
  /** sibling dedup_keys at different severity buckets for the same step. */
  cross_severity_warning?: string[];
}

export interface DedupedRun {
  /**
   * Pass-through from DispatchedRun; preserves run_id, timestamp, target,
   * harness_sha, target_deployment, models, and skipped.
   */
  meta: DispatchedRun['meta'];
  unanimous_findings: DedupedFinding[];
  partial_findings: DedupedFinding[];
  disagreements: DedupedFinding[];
  stats: {
    /** count of non-errored model_judgment entries across all findings. */
    total_raw: number;
    /** count of DedupedFinding objects (equals the input finding count). */
    after_dedup: number;
    /** 0..1; share of (finding, model) pairs that agreed with majority. */
    agreement_rate: number;
    /** per-model count of pass=false judgments (excluding errors); sorted alphabetically. */
    per_model_finding_counts: Record<string, number>;
    /**
     * per-model count of judgments whose `error` field is set, i.e. parse
     * failures surfaced by the dispatcher's syntheticError path. Sorted
     * alphabetically and seeded to 0 for every model in meta.models.
     */
    per_model_parse_error_counts: Record<string, number>;
    /**
     * per-model total count of model_judgments entries actually returned
     * for that model (valid plus errored). Excludes findings where the
     * model had no entry at all (e.g. matrix-level dispatch_errors). Used
     * as the honest denominator for parse-error rate annotations. Sorted
     * alphabetically and seeded to 0 for every model in meta.models.
     */
    per_model_total_judgments: Record<string, number>;
    /** pass-through from DispatchedRun. */
    dispatch_error_count: number;
    /** set to 'single-model run' when meta.models.length === 1. */
    warning?: string;
  };
  dispatch_errors: DispatchedRun['dispatch_errors'];
}
