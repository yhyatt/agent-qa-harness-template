/**
 * Unit tests for the target-deployment identity slice (Slice 6, ADR-015):
 *
 *   - parseVercelHeaders: pure header-bag parser. Reads x-vercel-id and
 *     x-vercel-deployment-url, returns both with nulls for missing fields.
 *   - parseBuildEndpointResponse: pure JSON-body parser. Returns commit and
 *     deployed_at, both nullable, never throws on bad input.
 *
 * The runtime listener and the fetchBuildEndpoint network path are exercised
 * implicitly through helpers.ts integration in journeys; here we cover only
 * the pure pieces so the tests stay fast and offline.
 */

import { describe, expect, it } from 'vitest';
import {
  parseVercelHeaders,
  parseBuildEndpointResponse,
} from '../e2e/journeys/helpers.js';

describe('parseVercelHeaders', () => {
  it('returns both fields when both Vercel headers are present', () => {
    const out = parseVercelHeaders(
      {
        'x-vercel-id': 'iad1::abc123-1700000000000-deadbeef',
        'x-vercel-deployment-url': 'app-xyz.vercel.app',
      },
      '2026-05-22T12:00:00.000Z',
    );
    expect(out.vercel_id).toBe('iad1::abc123-1700000000000-deadbeef');
    expect(out.deployment_url).toBe('app-xyz.vercel.app');
    expect(out.captured_at).toBe('2026-05-22T12:00:00.000Z');
  });

  it('returns vercel_id and a null deployment_url when deployment header is missing', () => {
    const out = parseVercelHeaders({
      'x-vercel-id': 'iad1::abc',
    });
    expect(out.vercel_id).toBe('iad1::abc');
    expect(out.deployment_url).toBe(null);
  });

  it('returns deployment_url and a null vercel_id when id header is missing', () => {
    const out = parseVercelHeaders({
      'x-vercel-deployment-url': 'app-xyz.vercel.app',
    });
    expect(out.vercel_id).toBe(null);
    expect(out.deployment_url).toBe('app-xyz.vercel.app');
  });

  it('returns both nulls on an empty headers bag', () => {
    const out = parseVercelHeaders({});
    expect(out.vercel_id).toBe(null);
    expect(out.deployment_url).toBe(null);
  });

  it('treats an empty-string header value as missing', () => {
    const out = parseVercelHeaders({
      'x-vercel-id': '',
      'x-vercel-deployment-url': '',
    });
    expect(out.vercel_id).toBe(null);
    expect(out.deployment_url).toBe(null);
  });

  it('stamps captured_at with an ISO timestamp by default', () => {
    const before = Date.now();
    const out = parseVercelHeaders({});
    const after = Date.now();
    const t = Date.parse(out.captured_at);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});

describe('parseBuildEndpointResponse', () => {
  it('returns the parsed shape for a valid body', () => {
    const out = parseBuildEndpointResponse({
      commit: 'abc1234',
      deployedAt: '2026-05-22T12:00:00.000Z',
    });
    expect(out.commit).toBe('abc1234');
    expect(out.deployed_at).toBe('2026-05-22T12:00:00.000Z');
  });

  it('nulls only the commit field when commit is missing', () => {
    const out = parseBuildEndpointResponse({ deployedAt: '2026-05-22T12:00:00.000Z' });
    expect(out.commit).toBe(null);
    expect(out.deployed_at).toBe('2026-05-22T12:00:00.000Z');
  });

  it('nulls only the deployed_at field when deployedAt is missing', () => {
    const out = parseBuildEndpointResponse({ commit: 'abc1234' });
    expect(out.commit).toBe('abc1234');
    expect(out.deployed_at).toBe(null);
  });

  it('tolerates extra fields without complaint', () => {
    const out = parseBuildEndpointResponse({
      commit: 'abc1234',
      deployedAt: '2026-05-22T12:00:00.000Z',
      branch: 'main',
      environment: 'production',
    });
    expect(out.commit).toBe('abc1234');
    expect(out.deployed_at).toBe('2026-05-22T12:00:00.000Z');
  });

  it('nulls only the commit field when commit is a number, not a string', () => {
    const out = parseBuildEndpointResponse({
      commit: 12345,
      deployedAt: '2026-05-22T12:00:00.000Z',
    });
    expect(out.commit).toBe(null);
    expect(out.deployed_at).toBe('2026-05-22T12:00:00.000Z');
  });

  it('nulls only the deployed_at field when deployedAt is a number, not a string', () => {
    const out = parseBuildEndpointResponse({
      commit: 'abc1234',
      deployedAt: 1700000000,
    });
    expect(out.commit).toBe('abc1234');
    expect(out.deployed_at).toBe(null);
  });

  it('treats an empty-string commit as missing (nulls the commit field only)', () => {
    const out = parseBuildEndpointResponse({ commit: '', deployedAt: '2026-05-22T12:00:00.000Z' });
    expect(out.commit).toBe(null);
  });

  it('returns both nulls when the input is not an object', () => {
    expect(parseBuildEndpointResponse('not json')).toEqual({ commit: null, deployed_at: null });
    expect(parseBuildEndpointResponse(null)).toEqual({ commit: null, deployed_at: null });
    expect(parseBuildEndpointResponse(undefined)).toEqual({ commit: null, deployed_at: null });
    expect(parseBuildEndpointResponse(42)).toEqual({ commit: null, deployed_at: null });
    expect(parseBuildEndpointResponse([])).toEqual({ commit: null, deployed_at: null });
  });
});
