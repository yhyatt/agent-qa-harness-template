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
