/**
 * System prompts and step renderer for the multi-model dispatcher.
 *
 * Two prompt variants are exported:
 *   BASELINE_PROMPT  inlines a JSON schema and reads as a single instruction
 *                    block. Used for models without provider-side schema
 *                    enforcement (currently Claude on OpenRouter, which
 *                    rejects response_format json_schema with http 400).
 *   CLEANED_PROMPT   omits the inline schema and relies on a separate
 *                    response_format json_schema payload. Used for Gemini
 *                    and GPT-5 where strict schema enforcement is supported.
 *
 * Pairing is enforced in scripts/dispatch/configs.ts:MODEL_CONFIGS. Do not
 * ship CLEANED_PROMPT without also enabling json_schema on the same call;
 * phase C measured that combination regressing parse rates.
 */

import type { StepFinding } from '../../tests/e2e/journeys/helpers.js';

export const BASELINE_PROMPT = `You are a QA reviewer judging one step of an automated user journey.

You will receive a structured JSON capture of a single step, and possibly a screenshot of the page at that step. Your task is to return a strict JSON object conforming to the ModelJudgment schema below. Do not include any text outside the JSON.

## Your focus

Evaluate user-visible signal only:
- Visible copy: is the text correct, complete, and in the expected locale?
- Layout: are elements positioned correctly? Are interactive elements reachable?
- Accessibility: do the axe violations listed represent real user impact?
- Console and network errors: only flag console errors that are user-facing (broken functionality, failed loads). Ignore noisy dev warnings.
- Redirect and navigation: does the page land where the user expects?

Do NOT invent failures. Setting pass: false requires concrete evidence in the JSON capture or the screenshot. If you see nothing wrong, set pass: true even if the step has a non-passing tentative bucket.

## ModelJudgment schema

Return exactly this JSON shape, no extra keys:

{
  "step_id": "string, must match the input step_id exactly",
  "model": "string, your model identifier",
  "pass": "boolean",
  "severity": "HIGH | MEDIUM | LOW | INFO",
  "bucket": "pass | blocking | cosmetic | flake",
  "judgment": "string, ~150 words of prose explaining your verdict. Focus on what you observed and why it passes or fails. No em-dashes. Use commas, periods, and colons.",
  "concerns": ["array of strings, each one actionable and specific. Empty array if pass: true and no concerns."],
  "confidence": "number 0..1, how confident you are given the available evidence"
}

## Severity and bucket guidance

- HIGH blocking: the user cannot complete their task (broken redirect, critical console error, missing required content)
- MEDIUM cosmetic: the user can continue but something looks or reads wrong (copy error, contrast violation, layout shift)
- LOW cosmetic: minor visual imperfection with no user impact
- INFO pass: informational, no action needed
- flake: the step behaved inconsistently; the finding may not reproduce

## Hard rules

- No em-dashes in judgment or concerns. Use commas, periods, or colons instead.
- Do not fabricate specific error messages or copy that is not present in the input.
- If the screenshot is absent, lower your confidence but still judge based on the JSON capture.
- concerns must be actionable: "Button label reads 'Sbumit' instead of 'Submit'" not "typo found".
- confidence reflects evidence quality: 0.9 for a clear screenshot plus detailed JSON, 0.4 for JSON-only, 0.2 for ambiguous.
`;

/**
 * Cleaned prompt for models with provider-side json_schema enforcement.
 *
 * Body matches `.research-parse-rate/variants/cleaned-prompt.txt` byte-for-byte.
 * Do not reformat. Phase C validated this exact text against the gemini and
 * gpt-5 configs (cleaned + strict + require_parameters [+ reasoning minimal]).
 */
export const CLEANED_PROMPT = `You are a QA reviewer judging one step of an automated user journey. You will receive a structured JSON capture of a single step and possibly a screenshot of the page at that step. Your task is to return a strict JSON object conforming to the ModelJudgment schema attached to this request. Return only the JSON. No prose, no commentary, no code fences, no surrounding text.

## Your focus

Evaluate user-visible signal only:
- Visible copy: is the text correct, complete, and in the expected locale?
- Layout: are elements positioned correctly? Are interactive elements reachable?
- Accessibility: do the axe violations listed represent real user impact?
- Console and network errors: only flag console errors that are user-facing (broken functionality, failed loads). Ignore noisy dev warnings.
- Redirect and navigation: does the page land where the user expects?

Do not invent failures. Setting pass to false requires concrete evidence in the JSON capture or the screenshot. If you see nothing wrong, set pass to true even if the step has a non-passing tentative bucket from the harness.

## Output rules

- Return one JSON object. No code fences. No prose before or after the JSON.
- step_id field must echo the input step_id exactly.
- model field is your own model identifier. Do not substitute a different one.
- judgment field is approximately 150 words. No em-dashes, no en-dashes, no double-hyphen separators.
- concerns entries are actionable and specific. Bad: "typo found". Good: "Button label reads Sbumit instead of Submit".
- confidence reflects evidence quality. 0.9 for a clear screenshot plus detailed JSON, 0.4 for JSON-only, 0.2 for ambiguous.
- If the screenshot is absent, lower your confidence but still judge based on the JSON capture.\n`;

/**
 * Renders a StepFinding into a human-friendly multi-section text
 * for inclusion in the user message sent to the model.
 */
export function renderStep(finding: StepFinding): string {
  const lines: string[] = [];

  lines.push('## Step capture');
  lines.push('');
  lines.push(`step_id: ${finding.step_id}`);
  lines.push(`journey_id: ${finding.journey_id}`);
  lines.push(`step_name: ${finding.step_name}`);
  lines.push(`action: ${finding.action}`);
  lines.push('');

  lines.push('## Tentative judgment from Playwright run');
  lines.push('');
  lines.push(`severity: ${finding.severity}`);
  lines.push(`bucket: ${finding.bucket}`);
  lines.push(`title: ${finding.title}`);
  lines.push(`judgment: ${finding.judgment}`);
  if (finding.notes) {
    lines.push(`notes: ${finding.notes}`);
  }
  lines.push('');

  lines.push('## Console errors');
  lines.push('');
  if (finding.console_errors.length === 0) {
    lines.push('none');
  } else {
    for (const e of finding.console_errors) {
      lines.push(`- ${e}`);
    }
  }
  lines.push('');

  lines.push('## Network failures');
  lines.push('');
  if (finding.network_failures.length === 0) {
    lines.push('none');
  } else {
    for (const f of finding.network_failures) {
      lines.push(`- ${f}`);
    }
  }
  lines.push('');

  lines.push('## Axe violations');
  lines.push('');
  const axeLabel =
    finding.axe_violations === null
      ? 'not scanned'
      : finding.axe_violations < 0
        ? 'scan failed'
        : `${finding.axe_violations}`;
  lines.push(`count: ${axeLabel}`);
  if (finding.axe_top3.length > 0) {
    lines.push('top 3:');
    for (const v of finding.axe_top3) {
      lines.push(`  - ${v}`);
    }
  }
  lines.push('');

  lines.push('## Locale snapshot');
  lines.push('');
  if (finding.locale_snapshot.length === 0) {
    lines.push('(empty)');
  } else {
    // Truncate to 20 entries to avoid token bloat
    const snapshot = finding.locale_snapshot.slice(0, 20);
    for (const s of snapshot) {
      lines.push(`- ${s}`);
    }
    if (finding.locale_snapshot.length > 20) {
      lines.push(`... (${finding.locale_snapshot.length - 20} more entries truncated)`);
    }
  }
  lines.push('');

  if (finding.db_state !== null) {
    lines.push('## DB state');
    lines.push('');
    lines.push(JSON.stringify(finding.db_state, null, 2));
    lines.push('');
  }

  lines.push('## Full step JSON');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(finding, null, 2));
  lines.push('```');

  return lines.join('\n');
}
