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

export interface DispatchedRun {
  meta: {
    run_id: string;
    timestamp: string;
    target: string;
    build: string;
    models: string[];
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
  /** pass-through from DispatchedRun; preserves run_id, timestamp, target, build, models. */
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
    /** pass-through from DispatchedRun. */
    dispatch_error_count: number;
    /** set to 'single-model run' when meta.models.length === 1. */
    warning?: string;
  };
  dispatch_errors: DispatchedRun['dispatch_errors'];
}
