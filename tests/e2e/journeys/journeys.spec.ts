/**
 * Stub journey catalog - fill in per-project flows here.
 *
 * The four journey IDs (J1-J4) are the template defaults. The mapping from
 * ID to journey name is:
 *
 *   J1  primary-user happy path (auth-gated)
 *   J2  secondary-user join or guest flow (no auth required)
 *   J3  secondary primary-user flow (auth-gated, publish or settings)
 *   J4  static surface walk (no auth required; covers landing, 404, terms, etc.)
 *
 * See docs/JOURNEY-CATALOG-GUIDE.md for how to enumerate journeys per app type.
 * See docs/PHILOSOPHY.md for the per-step JSON schema each step should emit.
 *
 * Pattern:
 *   1. attachListeners(page) early to capture console + network
 *   2. screenshot(page, journeyId, stepName) at every state transition
 *   3. runAxe(page) on each significant render
 *   4. captureLocaleSnapshot(page) for user-visible text
 *   5. Push StepFinding objects into a local findings[] array
 *   6. Push a JourneyResult into the shared journeyResults at the end
 *   7. expect(status).not.toBe('fail') propagates exit code
 *
 * The writeReport call in test.afterAll picks up the shared arrays automatically.
 */

import { test, expect } from '@playwright/test';
import {
  screenshot,
  attachListeners,
  runAxe,
  hasAuthFixture,
  writeReport,
  makeFinding,
  AUTH_FIXTURE_PATH,
  type JourneyResult,
  type AxeSurface,
  type StepFinding,
} from './helpers.js';
import { captureLocaleSnapshot } from './locale-snapshot.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE = process.env.TEST_TARGET_URL ?? 'http://localhost:3000';

// Shared state written by an earlier journey, read by a later one within
// the same worker. Safe because workers=1 in playwright.config.ts.
let sharedJoinCode: string | null = null;

// Optional fallback when J1 is auth-blocked but J2 still wants to run end-to-end.
// TODO: set this to a known dormant test session slug if your app supports it.
const FALLBACK_JOIN_CODE: string | null = null;

// Accumulated results written to the report after all tests finish.
const journeyResults: JourneyResult[] = [];
const axeSurfaces: AxeSurface[] = [];

// convention: tag auth-gated describes by suffixing the title with " @auth"
//   test.describe('host flow @auth', ...) is caught by test:e2e:auth, skipped by test:e2e:no-auth.
// the stub J1/J3 blocks below are auth-gated in spirit but tag is omitted on the stubs;
// add @auth to the describe title once you replace the stub body with a real flow.

// ---------------------------------------------------------------------------
// J1 - primary-user happy path (auth-gated)
// ---------------------------------------------------------------------------

test.describe('J1: primary-user happy path', () => {
  test('J1: primary-user happy path', async ({ browser }, testInfo) => {
    // TODO: if J1 is desktop-specific, gate by project name here:
    //   test.skip(testInfo.project.name !== 'chromium-desktop', 'J1 runs on chromium-desktop only');

    const startMs = Date.now();
    const findings: StepFinding[] = [];
    const authAvailable = hasAuthFixture();

    if (!authAvailable) {
      // Auth-blocked branch: visit the auth-gated entry, screenshot, document, return.
      // This is a passing state - the harness should not fail just because
      // the fixture has not been populated.
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const listeners = attachListeners(page);
      try {
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const ss = await screenshot(page, 'J1', '01-auth-gate');
        findings.push(
          makeFinding({
            step_id: 'J1/01',
            journey_id: 'J1',
            step_name: '01-auth-gate',
            action: 'visit home page without auth',
            severity: 'INFO',
            bucket: 'pass',
            title: 'J1 auth-blocked: no fixture',
            screenshot_path: ss,
            console_errors: listeners.errors,
            network_failures: listeners.networkFailures,
            judgment: 'Auth fixture not present. Run npm run populate-auth to enable full J1.',
            notes: `Fixture expected at: ${AUTH_FIXTURE_PATH}`,
          }),
        );
      } finally {
        await ctx.close();
      }
      journeyResults.push({
        id: 'J1',
        status: 'auth-blocked',
        durationMs: Date.now() - startMs,
        findings,
      });
      return;
    }

    // Authed branch.
    const ctx = await browser.newContext({ storageState: AUTH_FIXTURE_PATH });
    const page = await ctx.newPage();
    const listeners = attachListeners(page);

    let status: 'pass' | 'fail' = 'pass';

    try {
      // TODO: replace with the actual happy-path steps for your app.
      // Below is a structural skeleton; remove or adapt per app.

      // STEP 01: land on authed entry
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      const ss01 = await screenshot(page, 'J1', '01-landed');
      const snap01 = await captureLocaleSnapshot(page);
      const axe01 = await runAxe(page);
      axeSurfaces.push({
        route: '/',
        project: testInfo.project.name,
        violations: axe01.count,
        top3: axe01.top3,
      });
      findings.push(
        makeFinding({
          step_id: 'J1/01',
          journey_id: 'J1',
          step_name: '01-landed',
          action: 'navigate to authed home',
          severity: 'INFO',
          bucket: 'pass',
          title: 'J1/01 authed landing rendered',
          screenshot_path: ss01,
          locale_snapshot: snap01,
          console_errors: listeners.errors,
          network_failures: listeners.networkFailures,
          axe_violations: axe01.count,
          axe_top3: axe01.top3,
          judgment: `Page rendered. ${snap01.length} strings captured.`,
        }),
      );

      // TODO: STEP 02 - the user creates the primary thing (session, project, doc).
      //   Use page.click(), page.fill(), etc.
      //   Capture screenshot at the post-create state.
      //   If a join code or share token is generated, set sharedJoinCode.

      // TODO: STEP 03 - verify the post-create state via the locale snapshot.

      // TODO: STEP 04+ - continue until the happy path is complete.

      if (listeners.networkFailures.some((f: string) => /^5\d\d/.test(f))) {
        status = 'fail';
      }
    } catch (err) {
      status = 'fail';
      findings.push(
        makeFinding({
          step_id: 'J1/FATAL',
          journey_id: 'J1',
          step_name: 'fatal',
          action: 'journey errored',
          severity: 'HIGH',
          bucket: 'blocking',
          title: 'J1 errored unexpectedly',
          console_errors: listeners.errors,
          network_failures: listeners.networkFailures,
          judgment: String(err),
        }),
      );
    } finally {
      await ctx.close();
    }

    journeyResults.push({
      id: 'J1',
      status,
      durationMs: Date.now() - startMs,
      findings,
    });

    expect(status, 'J1 failed: see findings').not.toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// J2 - secondary-user join / guest flow (no auth)
// ---------------------------------------------------------------------------

test.describe('J2: secondary-user join', () => {
  test('J2: secondary-user join', async ({ browser }, testInfo) => {
    // TODO: gate by project if mobile-only:
    //   test.skip(testInfo.project.name !== 'mobile-iphone-13', 'J2 runs on mobile only');

    const startMs = Date.now();
    const findings: StepFinding[] = [];
    let status: 'pass' | 'fail' | 'auth-blocked' = 'pass';

    const code = sharedJoinCode ?? FALLBACK_JOIN_CODE;
    if (!code) {
      // No join code available (J1 was auth-blocked and no fallback set).
      // Report as auth-blocked rather than fail.
      findings.push(
        makeFinding({
          step_id: 'J2/00',
          journey_id: 'J2',
          step_name: '00-no-code',
          action: 'no join code available',
          severity: 'INFO',
          bucket: 'pass',
          title: 'J2 auth-blocked: no join code available',
          judgment: 'Set FALLBACK_JOIN_CODE or populate the auth fixture to enable J2.',
        }),
      );
      journeyResults.push({
        id: 'J2',
        status: 'auth-blocked',
        durationMs: Date.now() - startMs,
        findings,
      });
      return;
    }

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const listeners = attachListeners(page);

    try {
      // TODO: STEP 01 - visit the join entry with the code.
      // TODO: STEP 02 - verify the redirect or lobby render.
      // TODO: STEP 03 - verify the user can take their first action (submit, vote, etc).

      if (listeners.networkFailures.some((f: string) => /^5\d\d/.test(f))) {
        status = 'fail';
      }
    } catch (err) {
      status = 'fail';
      findings.push(
        makeFinding({
          step_id: 'J2/FATAL',
          journey_id: 'J2',
          step_name: 'fatal',
          action: 'journey errored',
          severity: 'HIGH',
          bucket: 'blocking',
          title: 'J2 errored unexpectedly',
          console_errors: listeners.errors,
          network_failures: listeners.networkFailures,
          judgment: String(err),
        }),
      );
    } finally {
      await ctx.close();
    }

    journeyResults.push({
      id: 'J2',
      status,
      durationMs: Date.now() - startMs,
      findings,
    });

    expect(status, 'J2 failed: see findings').not.toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// J3 - primary-user secondary flow (auth-gated; e.g. publish, share, settings)
// ---------------------------------------------------------------------------

test.describe('J3: primary-user secondary flow', () => {
  test('J3: primary-user secondary flow', async ({ browser }, testInfo) => {
    const startMs = Date.now();
    const findings: StepFinding[] = [];
    const authAvailable = hasAuthFixture();

    if (!authAvailable) {
      findings.push(
        makeFinding({
          step_id: 'J3/00',
          journey_id: 'J3',
          step_name: '00-auth-blocked',
          action: 'no auth fixture',
          severity: 'INFO',
          bucket: 'pass',
          title: 'J3 auth-blocked: no fixture',
          judgment: 'Run npm run populate-auth to enable J3.',
        }),
      );
      journeyResults.push({
        id: 'J3',
        status: 'auth-blocked',
        durationMs: Date.now() - startMs,
        findings,
      });
      return;
    }

    // TODO: implement against the actual secondary primary-user flow.
    // Typical examples:
    //   - publish a draft
    //   - share a record by link
    //   - change account settings
    //   - export data

    journeyResults.push({
      id: 'J3',
      status: 'pass',
      durationMs: Date.now() - startMs,
      findings,
    });
  });
});

// ---------------------------------------------------------------------------
// J4 - static surface walk (no auth, both projects)
// ---------------------------------------------------------------------------

test.describe('J4: static surface walk', () => {
  test('J4: static surface walk', async ({ page }, testInfo) => {
    const startMs = Date.now();
    const findings: StepFinding[] = [];
    const listeners = attachListeners(page);

    // TODO: list the static routes you want to walk. These are the routes
    // that should always render without auth and without errors.
    // SCAFFOLDER: replace the route list below with framework-specific routes for the consuming app
    const routes = ['/', '/about', '/terms', '/nonexistent-slug-smoke-test'];

    let status: 'pass' | 'fail' = 'pass';

    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const stepNum = String(i + 1).padStart(2, '0');
      try {
        const resp = await page.goto(`${BASE}${route}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        const isExpected404 = route.includes('nonexistent');
        const httpStatus = resp?.status() ?? 0;

        const ss = await screenshot(page, 'J4', `${stepNum}-${route.replace(/[/]/g, '_')}`);
        const snap = await captureLocaleSnapshot(page);
        const axe = await runAxe(page);

        axeSurfaces.push({
          route,
          project: testInfo.project.name,
          violations: axe.count,
          top3: axe.top3,
        });

        const severity: 'INFO' | 'MEDIUM' | 'HIGH' =
          axe.count > 0 ? 'MEDIUM' : 'INFO';

        findings.push(
          makeFinding({
            step_id: `J4/${stepNum}`,
            journey_id: 'J4',
            step_name: `${stepNum}-${route.replace(/[/]/g, '_')}`,
            action: `GET ${route}`,
            severity,
            bucket: 'pass',
            title: `J4 ${route} (${testInfo.project.name})`,
            screenshot_path: ss,
            locale_snapshot: snap,
            console_errors: [...listeners.errors],
            network_failures: [...listeners.networkFailures],
            axe_violations: axe.count,
            axe_top3: axe.top3,
            judgment: `HTTP ${httpStatus}. ${snap.length} strings captured. expected404=${isExpected404}`,
          }),
        );

        if (!isExpected404 && httpStatus >= 500) {
          status = 'fail';
        }

        // Reset listener buffers between routes for cleaner per-step capture.
        listeners.errors.length = 0;
        listeners.networkFailures.length = 0;
      } catch (err) {
        status = 'fail';
        findings.push(
          makeFinding({
            step_id: `J4/${stepNum}`,
            journey_id: 'J4',
            step_name: `${stepNum}-${route.replace(/[/]/g, '_')}`,
            action: `GET ${route}`,
            severity: 'HIGH',
            bucket: 'blocking',
            title: `J4 ${route} threw`,
            judgment: String(err),
          }),
        );
      }
    }

    journeyResults.push({
      id: 'J4',
      status,
      durationMs: Date.now() - startMs,
      findings,
    });

    expect(status, 'J4 failed: see findings').not.toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// Report writer - runs once after all tests in the file
// ---------------------------------------------------------------------------

test.afterAll(async () => {
  writeReport(journeyResults, axeSurfaces, BASE);
});
