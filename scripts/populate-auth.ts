/**
 * Auth fixture populator - one-time browser capture of storageState.
 *
 * Three modes:
 *
 *   1. Ephemeral (default)
 *      Launches a fresh bundled Chromium context. Fast setup, no state on disk.
 *      Use for email/password, magic-link, or any auth that does not trigger
 *      anti-bot detection.
 *
 *   2. Persistent (QA_AUTH_PERSIST=1)
 *      Launches bundled Chromium with a persistent profile directory. Cookies
 *      and localStorage survive between runs; the browser fingerprint is closer
 *      to a real user. Use for auth flows that benefit from a returning-user
 *      profile. Less reliable than CDP for Google/Microsoft OAuth.
 *
 *   3. CDP attach (QA_AUTH_CDP=1)  -- recommended for OAuth
 *      Connects to the user's already-running real Chrome via Chrome DevTools
 *      Protocol. Real Chrome is not flagged as automated. Sign into the app
 *      normally, then run populate-auth; it attaches, finds the session, saves
 *      state, and exits. Chrome stays open.
 *      See docs/CUSTOMIZATION.md for step-by-step setup.
 *
 * Precedence: QA_AUTH_CDP takes priority over QA_AUTH_PERSIST if both are set.
 *
 * Usage:
 *   npm run populate-auth                           # ephemeral (default)
 *   QA_AUTH_PERSIST=1 npm run populate-auth         # persistent profile
 *   QA_AUTH_CDP=1 TEST_TARGET_URL=https://my-app.com npm run populate-auth
 *   ROLE=admin npm run populate-auth                # label for the prompt
 *   QA_AUTH_FIXTURE_PATH=tests/e2e/fixtures/admin-auth.json npm run populate-auth
 *
 * Env vars:
 *   TEST_TARGET_URL          base URL of the running app
 *   QA_AUTH_FIXTURE_PATH     where to save storageState (default: tests/e2e/fixtures/host-auth.json)
 *   ROLE                     informational label for the prompt (default: "primary user")
 *   QA_AUTH_ENTRY_PATH       the path to navigate to (default: /). Useful for apps where
 *                            the sign-in flow lives at a specific URL like /auth/login.
 *   QA_AUTH_PERSIST          set to "1" to use launchPersistentContext.
 *   QA_AUTH_PROFILE_DIR      directory for the persistent profile (default: .qa-runs/userDataDir).
 *                            Gitignored by default. Treat as a SECRET; it contains live cookies.
 *   QA_AUTH_CDP              set to "1" to attach to a running Chrome via CDP.
 *   QA_AUTH_CDP_URL          Chrome DevTools endpoint (default: http://localhost:9222).
 *
 * Provider-specific tweaks (Clerk Captcha bypass, Supabase OAuth callback handling)
 * live in tests/e2e/adapters/<stack>.ts and are wired by scripts/scaffold.sh.
 *
 * Treat the resulting fixture file as a SECRET. It contains a live session cookie.
 * The .gitignore in this repo excludes tests/e2e/fixtures/*.json by default. Do not
 * disable that.
 */

import { chromium, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const TARGET = process.env.TEST_TARGET_URL ?? 'http://localhost:3000';
const ENTRY = process.env.QA_AUTH_ENTRY_PATH ?? '/';
const ROLE = process.env.ROLE ?? 'primary user';
const STATE_FILE =
  process.env.QA_AUTH_FIXTURE_PATH ??
  path.resolve('tests/e2e/fixtures/host-auth.json');

const CDP = process.env.QA_AUTH_CDP === '1';
const CDP_URL = process.env.QA_AUTH_CDP_URL ?? 'http://localhost:9222';
const PERSIST = process.env.QA_AUTH_PERSIST === '1';
const PROFILE_DIR =
  process.env.QA_AUTH_PROFILE_DIR ?? path.resolve('.qa-runs/userDataDir');

// Threshold below which the fixture is considered suspiciously small.
// A real Supabase/Clerk session storageState is typically 1-10 KB.
// 200 bytes captures the empty-object case: {"cookies":[],"origins":[]} is 36 bytes.
const SUSPICIOUSLY_SMALL = 200;

function printSizeSummary(stateFile: string): void {
  const size = fs.statSync(stateFile).size;
  console.log('');
  console.log(`Saved auth state to: ${stateFile} (${size} bytes)`);
  if (size < SUSPICIOUSLY_SMALL) {
    console.log('');
    console.log('WARNING: fixture is suspiciously small. The browser context captured no');
    console.log('cookies. Possible causes:');
    console.log('  - sign-in did not complete in this browser window');
    console.log('  - URL bar was still on accounts.google.com when Enter was pressed');
    console.log('  - Google flagged the bundled Chromium and silently blocked sign-in');
    console.log('  - try QA_AUTH_CDP=1 to use your real Chrome (avoids automation detection)');
  } else {
    console.log('Treat this file as a secret. It is gitignored by default.');
  }
}

async function runCdpMode(): Promise<void> {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`cannot connect to Chrome at ${CDP_URL}: ${reason}`);
    console.error('Start Chrome with: google-chrome --remote-debugging-port=9222');
    process.exit(1);
  }

  try {
    // Find the BrowserContext that has a page at the target URL.
    const contexts = browser.contexts();
    let targetCtx: BrowserContext | undefined;
    for (const ctx of contexts) {
      const pages = ctx.pages();
      const match = pages.some((p) => p.url().startsWith(TARGET));
      if (match) {
        targetCtx = ctx;
        break;
      }
    }

    if (!targetCtx) {
      console.error(
        `No browser context found with a page at ${TARGET}. ` +
          `Open ${TARGET} in your Chrome (signed in) and re-run.`,
      );
      process.exit(1);
    }

    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    await targetCtx.storageState({ path: STATE_FILE });
    printSizeSummary(STATE_FILE);
  } finally {
    // In CDP-connected mode, browser.close() disconnects from the remote browser
    // without terminating the Chrome process. The user's Chrome stays open.
    await browser.close();
  }
}

async function runInteractiveMode(): Promise<void> {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  let ctx: BrowserContext;
  let close: () => Promise<void>;

  if (PERSIST) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 900 },
      // Reduces the automation fingerprint that Google et al check for.
      args: ['--disable-blink-features=AutomationControlled'],
    });
    close = () => ctx.close();
  } else {
    const browser = await chromium.launch({ headless: false });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    close = () => browser.close();
  }

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${TARGET}${ENTRY}`);

  const modeLabel = PERSIST ? `persistent (profile: ${PROFILE_DIR})` : 'ephemeral';
  console.log('');
  console.log(`Browser is open at: ${TARGET}${ENTRY}`);
  console.log(`Mode: ${modeLabel}`);
  console.log(`Sign in as: ${ROLE}`);
  console.log('When you reach the authed entry page, return here and press Enter.');
  console.log('Tip: verify the URL bar shows the post-auth route (not accounts.google.com).');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((res) =>
    rl.question('Press Enter when authed... ', () => {
      rl.close();
      res();
    }),
  );

  await ctx.storageState({ path: STATE_FILE });
  printSizeSummary(STATE_FILE);

  await close();
}

async function main(): Promise<void> {
  // CDP takes priority over PERSIST if both are set.
  if (CDP) {
    await runCdpMode();
  } else {
    await runInteractiveMode();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
