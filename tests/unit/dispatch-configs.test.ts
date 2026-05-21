/**
 * Unit tests for scripts/dispatch/configs.ts.
 *
 * Covers:
 *   - the three hardcoded MODEL_CONFIGS entries have the shape phase C
 *     specified in DECISION.md
 *   - getModelConfig returns the known config for known ids
 *   - getModelConfig returns a sensible baseline default for unknown ids
 *     and emits a one-time stderr warning
 *   - JUDGMENT_SCHEMA matches the structural contract from
 *     .research-parse-rate/variants/model-judgment-schema.json
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MODEL_CONFIGS,
  getModelConfig,
  JUDGMENT_SCHEMA,
} from '../../scripts/dispatch/configs.js';

describe('MODEL_CONFIGS', () => {
  it('claude config: baseline prompt, 1024 max_tokens, no response_format, no reasoning', () => {
    const c = MODEL_CONFIGS['anthropic/claude-sonnet-4-6'];
    expect(c).toBeDefined();
    expect(c!.systemPrompt).toBe('baseline');
    expect(c!.maxTokens).toBe(1024);
    expect(c!.responseFormat).toBeUndefined();
    expect(c!.requireParameters).toBeUndefined();
    expect(c!.reasoning).toBeUndefined();
  });

  it('gemini config: cleaned prompt, 4096 max_tokens, json_schema + require_parameters, no reasoning', () => {
    const c = MODEL_CONFIGS['google/gemini-3.5-flash'];
    expect(c).toBeDefined();
    expect(c!.systemPrompt).toBe('cleaned');
    expect(c!.maxTokens).toBe(4096);
    expect(c!.responseFormat).toBe('json_schema');
    expect(c!.requireParameters).toBe(true);
    expect(c!.reasoning).toBeUndefined();
  });

  it('gpt-5 config: cleaned prompt, 4096 max_tokens, json_schema + require_parameters + reasoning minimal', () => {
    const c = MODEL_CONFIGS['openai/gpt-5'];
    expect(c).toBeDefined();
    expect(c!.systemPrompt).toBe('cleaned');
    expect(c!.maxTokens).toBe(4096);
    expect(c!.responseFormat).toBe('json_schema');
    expect(c!.requireParameters).toBe(true);
    expect(c!.reasoning).toEqual({ effort: 'minimal' });
  });

  it('exactly three known entries', () => {
    expect(Object.keys(MODEL_CONFIGS).sort()).toEqual([
      'anthropic/claude-sonnet-4-6',
      'google/gemini-3.5-flash',
      'openai/gpt-5',
    ]);
  });
});

describe('getModelConfig', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the hardcoded config for a known id', () => {
    expect(getModelConfig('openai/gpt-5')).toEqual(MODEL_CONFIGS['openai/gpt-5']);
  });

  it('returns the baseline default for an unknown id and warns once on stderr', () => {
    // Use a unique id per run to avoid the "warn-once" cache from previous test runs.
    const unknown = `mistralai/unknown-${Math.random().toString(36).slice(2, 10)}`;
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const c1 = getModelConfig(unknown);
    expect(c1.systemPrompt).toBe('baseline');
    expect(c1.maxTokens).toBe(1024);
    expect(c1.responseFormat).toBeUndefined();
    expect(c1.requireParameters).toBeUndefined();
    expect(c1.reasoning).toBeUndefined();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const msg = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain(unknown);
    expect(msg).toContain('baseline prompt');

    // Calling again with the same id should not produce a second warning.
    const c2 = getModelConfig(unknown);
    expect(c2).toEqual(c1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('JUDGMENT_SCHEMA', () => {
  it('matches the structural contract from .research-parse-rate/variants/model-judgment-schema.json', () => {
    expect(JUDGMENT_SCHEMA.type).toBe('object');
    expect(JUDGMENT_SCHEMA.additionalProperties).toBe(false);
    expect([...JUDGMENT_SCHEMA.required].sort()).toEqual(
      [
        'bucket',
        'concerns',
        'confidence',
        'judgment',
        'model',
        'pass',
        'severity',
        'step_id',
      ].sort(),
    );

    // Enum shapes
    expect([...JUDGMENT_SCHEMA.properties.severity.enum].sort()).toEqual(
      ['HIGH', 'INFO', 'LOW', 'MEDIUM'].sort(),
    );
    expect([...JUDGMENT_SCHEMA.properties.bucket.enum].sort()).toEqual(
      ['blocking', 'cosmetic', 'flake', 'pass'].sort(),
    );

    // Confidence numeric bounds
    expect(JUDGMENT_SCHEMA.properties.confidence.type).toBe('number');
    expect(JUDGMENT_SCHEMA.properties.confidence.minimum).toBe(0);
    expect(JUDGMENT_SCHEMA.properties.confidence.maximum).toBe(1);

    // Concerns is an array of strings
    expect(JUDGMENT_SCHEMA.properties.concerns.type).toBe('array');
    expect(JUDGMENT_SCHEMA.properties.concerns.items.type).toBe('string');
  });
});
