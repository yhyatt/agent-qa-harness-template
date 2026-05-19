/**
 * Auth fixture populator - one-time headed-browser capture of storageState.
 *
 * Combines two recipes that previously coexisted in the Ballpark seed:
 *   - The orchestrator's `.audit-2026-05-19/playwright/capture-auth-state.js`
 *     (custom headed-browser script with stdin handoff)
 *   - The W3 worktree's `npx playwright codegen --save-storage=...` recipe
 *
 * This is the canonical merged version. It uses Playwright's chromium
 * directly (no codegen UI), prompts via stdin, and saves storageState
 * to the configured fixture path.
 *
 * Usage:
 *   npm run populate-auth                      # uses TEST_TARGET_URL + default role
 *   ROLE=admin npm run populate-auth           # capture an admin fixture
 *   QA_AUTH_FIXTURE_PATH=tests/e2e/fixtures/admin-auth.json npm run populate-auth
 *
 * Env vars:
 *   TEST_TARGET_URL          base URL of the running app
 *   QA_AUTH_FIXTURE_PATH     where to save storageState (default: tests/e2e/fixtures/host-auth.json)
 *   ROLE                     informational label for the prompt (default: "primary user")
 *   QA_AUTH_ENTRY_PATH       the path to navigate to (default: /). Useful for apps where
 *                            the sign-in flow lives at a specific URL like /auth/login.
 *
 * STUB STATUS:
 *   The skeleton below works for the common case (visit URL, sign in, save state).
 *   Provider-specific tweaks (Clerk Captcha bypass, Supabase OAuth callback handling)
 *   live in tests/e2e/adapters/<stack>.ts and are wired by scripts/scaffold.sh.
 *
 * Treat the resulting fixture file as a SECRET. It contains a live session cookie.
 * The .gitignore in this repo excludes tests/e2e/fixtures/*.json by default. Do not
 * disable that.
 */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const TARGET = process.env.TEST_TARGET_URL ?? 'http://localhost:3000';
const ENTRY = process.env.QA_AUTH_ENTRY_PATH ?? '/';
const ROLE = process.env.ROLE ?? 'primary user';
const STATE_FILE =
  process.env.QA_AUTH_FIXTURE_PATH ??
  path.resolve('tests/e2e/fixtures/host-auth.json');

async function main() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${TARGET}${ENTRY}`);

  console.log('');
  console.log(`Browser is open at: ${TARGET}${ENTRY}`);
  console.log(`Sign in as: ${ROLE}`);
  console.log('When you reach the authed entry page, return here and press Enter.');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((res) =>
    rl.question('Press Enter when authed... ', () => {
      rl.close();
      res();
    }),
  );

  await ctx.storageState({ path: STATE_FILE });
  console.log('');
  console.log(`Saved auth state to: ${STATE_FILE}`);
  console.log('Treat this file as a secret. It is gitignored by default.');

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
