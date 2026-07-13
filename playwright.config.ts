import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Shared run ID across all worker processes.
//
// Without this, each Playwright project (chromium-desktop, mobile-iphone-13)
// computes its own timestamp and lands findings in separate .qa-runs/<id>/
// directories that the dispatcher cannot collate. Set once in the parent
// process; workers inherit via env.
// ---------------------------------------------------------------------------
if (!process.env.QA_RUN_DIR) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  process.env.QA_RUN_DIR = stamp;
}

// Write .qa-runs/latest.txt so the dispatcher scripts can find the most recent
// run without scanning and sorting the directory. Falls back to scan+sort if
// the file is absent or unreadable.
try {
  const qaRunsDir = path.resolve(__dirname, '.qa-runs');
  fs.mkdirSync(qaRunsDir, { recursive: true });
  fs.writeFileSync(path.join(qaRunsDir, 'latest.txt'), process.env.QA_RUN_DIR, 'utf-8');
} catch {
  // Non-fatal: dispatcher scripts fall back to scan+sort.
}

/**
 * Playwright config for the journey harness.
 *
 * Two projects by default:
 *   chromium-desktop    1280x900, primary locale
 *   mobile-iphone-13    iPhone 13 emulation, primary locale
 *
 * Override the target URL with TEST_TARGET_URL.
 * Override the locale by editing the `locale` field on both projects
 * (the scaffolder does this at setup time).
 *
 * Reports land in `.qa-runs/<timestamp>/` via helpers.ts. The Playwright
 * JSON reporter writes raw test results separately to playwright-output/.
 *
 * Run:
 *   npm run test:e2e
 *   TEST_TARGET_URL=http://localhost:3000 npm run test:e2e
 */
const TARGET = process.env.TEST_TARGET_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests/e2e/journeys',
  outputDir: '.qa-runs/playwright-output',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  timeout: 60_000,
  retries: 0,
  // Journeys can share state across tests (join code from J1 -> J2).
  // Workers stays at 1 to keep that ordering deterministic. If your
  // journeys are independent, you can raise this safely.
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: '.qa-runs/playwright-output/results.json' }],
  ],
  use: {
    baseURL: TARGET,
    // SCAFFOLDER: replace this locale with the consuming app's primary locale.
    locale: 'en-US',
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
      },
    },
    {
      name: 'mobile-iphone-13',
      use: {
        ...devices['iPhone 13'],
        // SCAFFOLDER: replace 'en-US' below with the chosen primary locale
        locale: 'en-US',
      },
    },
  ],
});
