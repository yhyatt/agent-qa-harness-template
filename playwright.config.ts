import { defineConfig, devices } from '@playwright/test';

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
        locale: 'en-US',
      },
    },
  ],
});
