/**
 * Per-model dispatch configuration.
 *
 * The phase C empirical run (.research-parse-rate/C-summary.md) measured
 * three model + variant winners that the dispatcher should send. Each model
 * gets a baseline or cleaned prompt, a max_tokens ceiling, and, where the
 * provider supports it, response_format json_schema plus a
 * provider.require_parameters anchor. GPT-5 also takes reasoning.effort
 * minimal which cut latency from roughly 26 seconds to 4 seconds and lifted
 * parse rate from 37.5% to 100%.
 *
 * See:
 *   .research-parse-rate/DECISION.md            spec
 *   .research-parse-rate/A-secondary.md         the why for each knob
 *   .research-parse-rate/variants/model-judgment-schema.json   JUDGMENT_SCHEMA source
 *
 * Hardcoded for v1. Externalising to env or JSON is a future slice.
 */

/**
 * JSON Schema (draft 2020-12) for the ModelJudgment object.
 *
 * Mirrors `.research-parse-rate/variants/model-judgment-schema.json` byte-for-byte
 * in shape: same required fields, same enum values, same additionalProperties.
 * Used as the `json_schema.schema` payload on response_format calls for gemini
 * and gpt-5. Claude is excluded from json_schema in this slice because
 * OpenRouter's Anthropic backend returns http 400 on every json_schema call
 * today (phase C, all 16 Claude/json-schema cells failed). Tracked as a
 * followup ticket.
 */
export const JUDGMENT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['step_id', 'model', 'pass', 'severity', 'bucket', 'judgment', 'concerns', 'confidence'],
  properties: {
    step_id: {
      type: 'string',
      description: 'Echo the step_id from the input verbatim. Do not modify.',
    },
    model: {
      type: 'string',
      description: 'Your model identifier as supplied at request time. Do not invent or substitute.',
    },
    pass: {
      type: 'boolean',
      description:
        'true if the step represents acceptable user-visible behavior. false if a real user-impacting defect is present.',
    },
    severity: {
      type: 'string',
      enum: ['HIGH', 'MEDIUM', 'LOW', 'INFO'],
      description:
        'HIGH: user cannot complete the task. MEDIUM: user can continue but something is wrong. LOW: minor visual nit. INFO: pass-level signal, no defect.',
    },
    bucket: {
      type: 'string',
      enum: ['pass', 'blocking', 'cosmetic', 'flake'],
      description:
        'pass: no defect. blocking: hard failure. cosmetic: real defect that does not block the flow. flake: behaved inconsistently and the finding may not reproduce.',
    },
    judgment: {
      type: 'string',
      description:
        'Prose explanation of your verdict, approximately 150 words. State what you observed and why it passes or fails. No em-dashes, no en-dashes, no double-hyphen separators. Use commas, periods, and colons.',
    },
    concerns: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Each entry is one actionable, specific concern. Empty array when pass is true and no concerns exist. Bad: 'typo found'. Good: 'Button label reads Sbumit instead of Submit'.",
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        '0..1, reflecting confidence in the verdict given available evidence. 0.9 for clear screenshot plus detailed JSON, 0.4 for JSON-only, 0.2 for ambiguous evidence.',
    },
  },
} as const;

/**
 * Per-model dispatch config.
 *
 * systemPrompt        'baseline' selects BASELINE_PROMPT (Claude path).
 *                     'cleaned' selects CLEANED_PROMPT (gemini, gpt-5 path).
 * maxTokens           OpenRouter chat-completions max_tokens.
 * responseFormat      when 'json_schema', adds response_format with JUDGMENT_SCHEMA.
 * requireParameters   when true, sets provider.require_parameters in the
 *                     OpenRouter body. Load-bearing for gemini and gpt-5;
 *                     without it OpenRouter may route to a backend that
 *                     silently drops the schema constraint.
 * reasoning           when present, sets reasoning.effort. GPT-5 ships with
 *                     'minimal' per phase C.
 */
export interface ModelConfig {
  systemPrompt: 'baseline' | 'cleaned';
  maxTokens: number;
  responseFormat?: 'json_schema';
  requireParameters?: boolean;
  reasoning?: { effort: 'minimal' | 'low' | 'medium' | 'high' };
}

export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  'anthropic/claude-sonnet-4-6': {
    systemPrompt: 'baseline',
    maxTokens: 1024,
  },
  'google/gemini-3.5-flash': {
    systemPrompt: 'cleaned',
    maxTokens: 4096,
    responseFormat: 'json_schema',
    requireParameters: true,
  },
  'openai/gpt-5': {
    systemPrompt: 'cleaned',
    maxTokens: 4096,
    responseFormat: 'json_schema',
    requireParameters: true,
    reasoning: { effort: 'minimal' },
  },
};

/**
 * Default fallback for unknown model ids: Claude-style baseline path.
 *
 * Rationale: baseline + no response_format is the lowest-common-denominator
 * shape that every OpenRouter backend accepts. response_format json_schema
 * is opt-in per model because some backends (notably Anthropic via
 * OpenRouter) reject it outright. Picking the most permissive default keeps
 * unknown ids dispatching instead of failing fast at the provider, while
 * the unknown-id stderr warning ensures the gap is visible.
 */
const DEFAULT_MODEL_CONFIG: ModelConfig = {
  systemPrompt: 'baseline',
  maxTokens: 1024,
};

/** Tracks model ids we have already warned about, to avoid stderr spam. */
const warnedUnknownModels = new Set<string>();

/**
 * Returns the dispatch config for a model id.
 *
 * Known ids (the three in MODEL_CONFIGS) return their hardcoded config.
 * Unknown ids return DEFAULT_MODEL_CONFIG and emit a one-time stderr
 * warning so the operator can see the gap and add a config if needed.
 * The warning is intentionally loud: silent fallbacks are how a parse-rate
 * regression hides in production.
 */
export function getModelConfig(model: string): ModelConfig {
  const known = MODEL_CONFIGS[model];
  if (known) return known;

  if (!warnedUnknownModels.has(model)) {
    warnedUnknownModels.add(model);
    process.stderr.write(
      `note: no MODEL_CONFIGS entry for '${model}'. Falling back to baseline prompt, ` +
        `1024 max_tokens, no response_format. Add an entry to scripts/dispatch/configs.ts ` +
        `to enable per-model knobs (json_schema, reasoning, require_parameters).\n`,
    );
  }
  return DEFAULT_MODEL_CONFIG;
}
