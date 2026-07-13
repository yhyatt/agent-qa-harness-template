import { clearPartials } from './journeys/helpers.js';

export default async function globalSetup(): Promise<void> {
  // Clear stale per-project sidecars before any project runs, so a rerun that
  // reuses RUN_DIR (default minute-granularity timestamp, or a fixed
  // QA_RUN_DIR) does not merge a prior run's sidecars into this run's report.
  clearPartials();
}
