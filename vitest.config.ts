import { defineConfig } from 'vitest/config';

/**
 * Minimal Vitest config. The template does not currently ship Vitest tests,
 * but if the consuming project adds them, this config excludes the e2e
 * directory so `vitest` and `playwright test` do not collide.
 */
export default defineConfig({
  test: {
    exclude: ['node_modules', 'dist', '.qa-runs', 'tests/e2e/**'],
  },
});
