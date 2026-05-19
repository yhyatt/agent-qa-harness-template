/**
 * Locale-aware text snapshot helper.
 *
 * Captures user-visible text from the current page state. Locale-agnostic:
 * works for any language the app renders. The snapshot is used for two things:
 *
 *   1. Per-step JSON `locale_snapshot` field (input to multi-model dispatch).
 *   2. Run-over-run diffing (catch missing translations, accidental string changes).
 *
 * Generalized from Ballpark's Hebrew-specific snapshot; Hebrew-specific logic
 * (RTL handling, hebrewCopy comparison) is intentionally removed here. If
 * an app has locale-specific concerns (e.g. RTL bidi marks, CJK width),
 * extend this in the consuming repo, not in the template.
 */

import { type Page } from '@playwright/test';

export interface LocaleSnapshotOptions {
  /** CSS selector to scope the snapshot. Defaults to body. */
  scope?: string;
  /** Max characters per captured string (truncates long bodies). */
  maxLength?: number;
  /** Max number of strings returned. */
  maxStrings?: number;
}

/**
 * Captures visible text from the page.
 *
 * Returns deduplicated, trimmed user-visible strings in DOM order.
 * Skips text inside <script>, <style>, <noscript>.
 */
export async function captureLocaleSnapshot(
  page: Page,
  options: LocaleSnapshotOptions = {},
): Promise<string[]> {
  const { scope = 'body', maxLength = 200, maxStrings = 100 } = options;

  return await page.evaluate(
    ({ scopeSel, max, maxLen }) => {
      const root = document.querySelector(scopeSel) ?? document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
            return NodeFilter.FILTER_REJECT;
          }
          const text = node.textContent?.trim() ?? '';
          if (text.length === 0) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      const seen = new Set<string>();
      const out: string[] = [];
      let node = walker.nextNode();
      while (node && out.length < max) {
        const text = (node.textContent ?? '').trim();
        if (text.length > 0 && !seen.has(text)) {
          seen.add(text);
          out.push(text.length > maxLen ? text.slice(0, maxLen) + '...' : text);
        }
        node = walker.nextNode();
      }
      return out;
    },
    { scopeSel: scope, max: maxStrings, maxLen: maxLength },
  );
}

/**
 * Diff two locale snapshots. Returns added, removed, and changed strings.
 * Useful for run-over-run regression detection on translation drift.
 */
export function diffSnapshots(
  before: string[],
  after: string[],
): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((s) => !beforeSet.has(s)),
    removed: before.filter((s) => !afterSet.has(s)),
  };
}
