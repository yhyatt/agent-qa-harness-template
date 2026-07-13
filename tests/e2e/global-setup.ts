import { clearRunOutputs } from './journeys/helpers.js';

export default async function globalSetup(): Promise<void> {
  // Clear the prior run's generated output before any project runs, so a rerun
  // that reuses RUN_DIR (default minute-granularity timestamp, or a fixed
  // QA_RUN_DIR) never serves stale results: stale sidecars are not merged into
  // this run's report, and a zero-sidecar rerun does not leave the prior run's
  // findings.json / REPORT.md lingering as if current.
  clearRunOutputs();
}
