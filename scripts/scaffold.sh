#!/usr/bin/env bash
# Interactive scaffolder. Run once after cloning the template.
#
# STUB STATUS:
#   The skeleton below is a structural shell. Implementation is the
#   next-session work after Ballpark slice-14 ships and the adapter
#   patterns harden. Today this script prints the prompts and exits.
#
# When implemented, the script will:
#
#   1. Detect or prompt for:
#        - Framework         (next | sveltekit | astro | nuxt)
#        - Auth provider     (supabase | clerk | auth0)
#        - Database          (postgres | d1 | mongo)
#        - Hosting           (vercel | cloudflare)
#        - Primary locale    (ISO code, e.g. en-US)
#        - App URL           (used as TEST_TARGET_URL default)
#
#   2. Generate adapter files in tests/e2e/adapters/:
#        - <stack>.ts with captureAuthState + captureDbState + requiredEnvVars
#        - Based on docs/CUSTOMIZATION.md adapter pattern
#
#   3. Patch playwright.config.ts:
#        - Set locale on both projects (chromium-desktop + mobile-iphone-13)
#        - Update the TEST_TARGET_URL default
#
#   4. Patch tests/e2e/journeys/journeys.spec.ts:
#        - Replace BASE default URL
#        - Replace example route lists in J4 with placeholders fitting the framework
#
#   5. Patch tests/e2e/journeys/README.md:
#        - Fill in the framework-specific commands
#
#   6. Patch .github/workflows/ci.yml:
#        - Set the TEST_TARGET_URL placeholder to match the chosen host
#
#   7. Append a section to README.md noting which adapter was generated
#
#   8. Print the next-step checklist:
#        - npm install
#        - npm run populate-auth
#        - npm run test:e2e -- --grep "J4"
#        - "Fill in the J1-J3 TODOs in tests/e2e/journeys/journeys.spec.ts"
#
# Implementation tactic: sed/awk substitutions are fragile across stacks.
# Prefer generating new files in tests/e2e/adapters/ and leaving the
# template files unchanged except for documented placeholders.

set -euo pipefail

cat <<'MSG'
agent-qa-harness-template scaffolder

This script is a stub. The interactive substitution is not yet implemented.

For now, follow the manual recipe in docs/CUSTOMIZATION.md:

  1. Pick your stack (framework, auth, db, host)
  2. Copy or write the adapter file at tests/e2e/adapters/<stack>.ts
     (template patterns in docs/CUSTOMIZATION.md)
  3. Edit playwright.config.ts to set your primary locale
  4. Set TEST_TARGET_URL in your shell or .env
  5. Run: npm run populate-auth   (one-time)
  6. Run: npm run test:e2e -- --grep "J4"
  7. Fill in J1-J3 TODOs in tests/e2e/journeys/journeys.spec.ts

See docs/JOURNEY-CATALOG-GUIDE.md for catalog design.
MSG

exit 0
