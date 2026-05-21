/**
 * Provider abstraction for the multi-model dispatcher.
 *
 * Single real dispatch path: OpenRouter chat-completions over plain fetch.
 * All real models (Anthropic, Google, OpenAI, etc.) are addressed by their
 * provider-prefixed OpenRouter id (e.g. 'anthropic/claude-sonnet-4-6',
 * 'google/gemini-3.5-flash', 'openai/gpt-5').
 *
 * Mock provider stays. Used by MOCK_DISPATCH=1 and by the canonical
 * mock-a / mock-b / mock-c model names for offline tests.
 *
 * See docs/DECISIONS.md ADR-012 for the rationale.
 */

import type { StepFinding } from '../../tests/e2e/journeys/helpers.js';
import type { ModelJudgment, Severity, Bucket } from '../types.js';
import { renderStep } from './prompt.js';

const VALID_SEVERITIES = ['HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
const VALID_BUCKETS = ['pass', 'blocking', 'cosmetic', 'flake'] as const;

export interface Provider {
  family: 'openrouter' | 'mock';
  dispatch(
    model: string,
    finding: StepFinding,
    screenshotB64: string | null,
    systemPrompt: string,
  ): Promise<ModelJudgment>;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseJudgment(text: string, finding: StepFinding, model: string): ModelJudgment {
  // Strip markdown code fences if the model wrapped the JSON
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  if (typeof parsed['pass'] !== 'boolean') {
    throw new Error(`invalid pass: ${String(parsed['pass'])}`);
  }
  if (!VALID_SEVERITIES.includes(parsed['severity'] as Severity)) {
    throw new Error(`invalid severity: ${String(parsed['severity'])}`);
  }
  if (!VALID_BUCKETS.includes(parsed['bucket'] as Bucket)) {
    throw new Error(`invalid bucket: ${String(parsed['bucket'])}`);
  }
  const severity = parsed['severity'] as Severity;
  const bucket = parsed['bucket'] as Bucket;

  // Preserve the model's step_id echo; the dispatcher validates and coerces it.
  const stepId =
    typeof parsed['step_id'] === 'string' && parsed['step_id'].length > 0
      ? parsed['step_id']
      : finding.step_id;

  return {
    step_id: stepId,
    model,
    pass: parsed['pass'] as boolean,
    severity,
    bucket,
    judgment: String(parsed['judgment'] ?? ''),
    concerns: Array.isArray(parsed['concerns'])
      ? (parsed['concerns'] as string[]).map(String)
      : [],
    confidence: typeof parsed['confidence'] === 'number'
      ? Math.max(0, Math.min(1, parsed['confidence']))
      : 0.5,
  };
}

function syntheticError(
  model: string,
  finding: StepFinding,
  reason: string,
  raw: string,
): ModelJudgment {
  return {
    step_id: finding.step_id,
    model,
    pass: true,
    severity: 'INFO',
    bucket: 'flake',
    judgment: `Dispatch parse error: ${reason}. The step could not be judged. Treat as inconclusive.`,
    concerns: ['parse failed after retry'],
    confidence: 0,
    error: reason,
    raw,
  };
}

// ---------------------------------------------------------------------------
// OpenRouter provider (single dispatch path for all real models)
// ---------------------------------------------------------------------------

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterChoice {
  message?: { content?: string };
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  error?: { message?: string };
}

export function makeOpenRouterProvider(): Provider {
  return {
    family: 'openrouter',
    async dispatch(model, finding, screenshotB64, systemPrompt) {
      type ContentPart =
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } };

      const userContent: ContentPart[] = [{ type: 'text', text: renderStep(finding) }];

      if (screenshotB64 !== null) {
        userContent.push({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${screenshotB64}` },
        });
      }

      const callModel = async (extraInstruction?: string): Promise<string> => {
        const systemContent = extraInstruction
          ? systemPrompt + '\n\n' + extraInstruction
          : systemPrompt;

        const resp = await fetch(OPENROUTER_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            messages: [
              { role: 'system', content: systemContent },
              { role: 'user', content: userContent },
            ],
          }),
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(`OpenRouter ${resp.status} ${resp.statusText}: ${body.slice(0, 500)}`);
        }

        const data = (await resp.json()) as OpenRouterResponse;
        if (data.error?.message) {
          throw new Error(`OpenRouter error: ${data.error.message}`);
        }
        return data.choices?.[0]?.message?.content ?? '';
      };

      // callModel throws are network/5xx errors: let them propagate to the dispatcher.
      // Only parseJudgment failures (malformed JSON) trigger the retry/synthetic path.
      const rawText = await callModel();

      let retryRaw = '';
      try {
        return parseJudgment(rawText, finding, model);
      } catch {
        // Parse failed on first attempt. Retry with stricter instruction.
        retryRaw = await callModel(
          'IMPORTANT: Return ONLY the JSON object. No prose, no code fences, no explanation. Start your response with { and end with }.',
        );
        try {
          return parseJudgment(retryRaw, finding, model);
        } catch (parseErr) {
          const reason =
            parseErr instanceof Error ? parseErr.message : String(parseErr);
          return syntheticError(model, finding, `parse failed after retry: ${reason}`, retryRaw);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

/**
 * Deterministic hash of two strings. Simple djb2 variant.
 * Returns a stable positive integer.
 */
function hashStrings(a: string, b: string): number {
  const s = `${a}::${b}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // convert to uint32
  }
  return h;
}

export function makeMockProvider(): Provider {
  return {
    family: 'mock',
    async dispatch(model, finding, _screenshotB64, _systemPrompt): Promise<ModelJudgment> {
      const h = hashStrings(model, finding.step_id);

      // mock-a: passes everything with high confidence
      if (model === 'mock-a' || model.startsWith('mock-a-')) {
        return {
          step_id: finding.step_id,
          model,
          pass: true,
          severity: finding.severity,
          bucket: finding.bucket === 'blocking' ? 'blocking' : 'pass',
          judgment:
            `Mock model A judgment for step ${finding.step_id}. ` +
            `The step appears to be functioning correctly based on the captured data. ` +
            `No user-visible failures detected in the locale snapshot or console output. ` +
            `The action completed without observable errors. ` +
            `Axe violations, if any, were noted but not conclusive without screenshot context. ` +
            `Overall assessment: the step meets the acceptance bar for a clean run.`,
          concerns: [],
          confidence: 0.9,
        };
      }

      // mock-b: fails on INFO severity findings (keeps severity, sets pass: false, bucket: cosmetic)
      if (model === 'mock-b' || model.startsWith('mock-b-')) {
        const isInfo = finding.severity === 'INFO';
        return {
          step_id: finding.step_id,
          model,
          pass: !isInfo,
          severity: finding.severity,
          bucket: isInfo ? 'cosmetic' : finding.bucket,
          judgment:
            `Mock model B judgment for step ${finding.step_id}. ` +
            (isInfo
              ? `This step carries an INFO severity finding. Model B flags INFO findings for closer review. ` +
                `The captured data includes a tentative pass bucket that model B overrides to cosmetic. ` +
                `Specific concerns are noted below. The locale snapshot shows no critical failures. ` +
                `Console output is clean. This is a soft flag, not a blocker.`
              : `Mock model B finds no issues with this step. The action completed as expected. ` +
                `No console errors. No network failures. Locale snapshot appears nominal. ` +
                `Axe violations are within acceptable range. Confidence is moderate given mock context.`),
          concerns: isInfo
            ? [`Step has INFO severity: review whether the tentative bucket is accurate`]
            : [],
          confidence: 0.75,
        };
      }

      // mock-c: passes everything but lowers confidence when axe_violations > 0
      // Uses hash to produce slight variation in judgment text
      const hasAxe = finding.axe_violations > 0;
      const confidenceBase = hasAxe ? 0.55 : 0.85;
      // Deterministic variation: use low bit of hash to shift confidence slightly
      const confidenceVariation = ((h % 10) - 5) * 0.01;
      const confidence = Math.max(
        0.1,
        Math.min(0.99, confidenceBase + confidenceVariation),
      );

      return {
        step_id: finding.step_id,
        model,
        pass: true,
        severity: finding.severity,
        bucket: finding.bucket,
        judgment:
          `Mock model C judgment for step ${finding.step_id}. ` +
          `The step is assessed as passing. ` +
          (hasAxe
            ? `However, ${finding.axe_violations} axe violation(s) were detected. ` +
              `Without a live screenshot, confidence is reduced. ` +
              `The violations listed are: ${finding.axe_top3.slice(0, 2).join('; ') || 'see axe_top3 field'}. ` +
              `Recommend a manual review of accessibility issues before shipping.`
            : `No axe violations detected. The locale snapshot and console output look clean. ` +
              `The action completed without observed failures. Confidence is high.`),
        concerns: hasAxe
          ? [
              `${finding.axe_violations} axe violation(s) present: verify user impact before closing`,
            ]
          : [],
        confidence,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/** Returns true if the model name indicates the mock provider. */
export function isMockModel(model: string): boolean {
  return model.startsWith('mock-');
}

/** Returns true if the model name is one of the canonical mock names. */
function isCanonicalMockModel(model: string): boolean {
  return model === 'mock-a' || model === 'mock-b' || model === 'mock-c' ||
    model.startsWith('mock-a-') || model.startsWith('mock-b-') || model.startsWith('mock-c-');
}

/**
 * Resolves the correct provider for a model.
 * When MOCK_DISPATCH=1, all models use the mock provider.
 * When a model is a canonical mock name (mock-a, mock-b, mock-c, or their mock-X-... variants),
 * it uses the mock provider. Any other mock-* name is rejected.
 * All other models dispatch through OpenRouter.
 */
export function resolveProvider(model: string, mockDispatch: boolean): Provider {
  if (mockDispatch) {
    return makeMockProvider();
  }
  if (isMockModel(model)) {
    if (!isCanonicalMockModel(model)) {
      throw new Error(
        `unknown mock model: '${model}'. Supported: mock-a, mock-b, mock-c, or MOCK_DISPATCH=1 with any model name.`,
      );
    }
    return makeMockProvider();
  }
  return makeOpenRouterProvider();
}
