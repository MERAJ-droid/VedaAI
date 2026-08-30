import type { OCRLine, BoundingBox, NormalizedBox, DetectedLabel } from '@/lib/types';

export type { DetectedLabel };

/**
 * Regex patterns applied to the START of a line to detect question labels.
 * Ordered from most specific to least specific.
 */
const LABEL_PATTERNS: Array<{
  pattern: RegExp;
  extractor: (match: RegExpMatchArray) => { main: string; sub?: string };
}> = [
  // "11(a)", "11(ii)" — lowercase sub-part only (NO /i — uppercase (A) is NOT a sub-question)
  { pattern: /^(\d+)\s*\(([a-z]|[ivxlcdm]+)\)/, extractor: m => ({ main: m[1], sub: m[2].toLowerCase() }) },
  // "11a)", "11b)" — lowercase sub-part only (NO /i)
  { pattern: /^(\d+)\s*([a-z])\)/, extractor: m => ({ main: m[1], sub: m[2].toLowerCase() }) },
  // "11." or "11:" or "11 -"
  { pattern: /^(\d+)\s*[.:\-]\s*/, extractor: m => ({ main: m[1] }) },
  // Standalone "11" at beginning of line (only if short enough to be a label, not a year)
  { pattern: /^(\d{1,2})\s*$/, extractor: m => ({ main: m[1] }) },
  // "Q.11", "Q11", "Q 11"
  { pattern: /^Q\.?\s*(\d+)/i, extractor: m => ({ main: m[1] }) },
  // "Ans.11", "Ans 11", "Answer 11"
  { pattern: /^Ans(?:wer)?\.?\s*(\d+)/i, extractor: m => ({ main: m[1] }) },
  // "(a)", "(ii)" — lowercase sub-part only (NO /i — MCQ options are uppercase and must NOT match)
  { pattern: /^\(([a-z]|[ivxlcdm]+)\)/, extractor: m => ({ main: '', sub: m[1].toLowerCase() }) },
  // "a)", "b)" — lowercase sub-part only (NO /i)
  { pattern: /^([a-z])\)\s/, extractor: m => ({ main: '', sub: m[1].toLowerCase() }) },
];

/**
 * Common OCR misread substitution table applied before pattern matching.
 */
const OCR_CHAR_SUBSTITUTIONS: Array<[string | RegExp, string]> = [
  [/[lI|]/g, '1'],      // l, I, | → 1
  [/[oO]/g, '0'],       // o, O → 0
  [/[sS](?=\d)/g, '5'], // S before digit → 5
  [/[zZ](?=\d)/g, '2'], // Z before digit → 2
];

export function normalizeText(raw: string): string {
  let text = raw.trim();
  for (const [pattern, replacement] of OCR_CHAR_SUBSTITUTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ');
}

export function formatDisplayLabel(main: string, sub?: string): string {
  if (!sub) return main;
  return `${main} (${sub})`;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

export function fuzzyMatchLabel(
  text: string,
  knownLabels: string[]
): { label: string; confidence: number } | null {
  const threshold = 0.6;
  const token = text.split(/\s+/)[0];
  let best: { label: string; confidence: number } | null = null;

  for (const label of knownLabels) {
    const score = similarity(token, label);
    if (score >= threshold && (!best || score > best.confidence)) {
      best = { label, confidence: score };
    }
  }
  return best;
}

/**
 * Mutable context threaded across multiple `detectLabels` calls.
 * Allows the "current main question number" to persist between pages,
 * so a standalone "(ii)" on page 2 correctly inherits the "1" seen on page 1.
 */
export interface LabelContext {
  /** The last main question number seen across all processed pages. */
  currentMain: string;
}

/**
 * Detects answer labels in OCR lines.
 *
 * Strategy:
 * 1. Run each line through LABEL_PATTERNS (most-specific first).
 * 2. If no pattern matches, check if the FIRST WORD/TOKEN is a near-exact
 *    match to a known question label (fuzzy match).
 * 3. Standalone sub-parts (a), (b) inherit the preceding main question number,
 *    first from within the same page, then from `context.currentMain` if provided.
 *
 * @param lines - OCR lines from a single page
 * @param pageIndex - page index
 * @param knownQuestionLabels - optional list of known labels from question paper
 * @param context - optional mutable context that threads currentMain across pages.
 *                  Pass the same object for every page to get cross-page inheritance.
 */
export function detectLabels(
  lines: OCRLine[],
  pageIndex: number,
  knownQuestionLabels?: string[],
  context?: LabelContext
): DetectedLabel[] {
  const detected: DetectedLabel[] = [];
  // Seed currentMain from cross-page context (if provided), otherwise start fresh
  let currentMain = context?.currentMain ?? '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const raw = line.text.trim();
    if (!raw) continue;

    // Only check the first ~30 chars for a label — labels are always at the start
    const prefix = raw.substring(0, 30);
    const normalized = normalizeText(prefix);

    let matched = false;

    for (const { pattern, extractor } of LABEL_PATTERNS) {
      const match = normalized.match(pattern);
      if (match) {
        const { main, sub } = extractor(match);
        let actualMain = main;

        if (actualMain === '' && sub) {
          // Sub-part only — inherit context (now includes cross-page context)
          actualMain = currentMain || '?';
        } else if (actualMain) {
          currentMain = actualMain;
        }

        const normalizedLabel = sub ? `${actualMain}${sub}` : actualMain;
        const displayLabel = formatDisplayLabel(actualMain, sub);

        detected.push({
          rawText: match[0].trim(),
          normalizedLabel,
          displayLabel,
          confidence: 1.0,
          pageIndex,
          bbox: line.bbox,
          normalized: line.normalized,
          lineIndex: i,
        });

        matched = true;
        break;
      }
    }

    // Fallback: fuzzy match against known question labels
    if (!matched && knownQuestionLabels && knownQuestionLabels.length > 0) {
      const fuzzy = fuzzyMatchLabel(normalized, knownQuestionLabels);
      if (fuzzy) {
        const parts = fuzzy.label.match(/^(\d+)([a-z]*)$/i);
        if (parts?.[1]) currentMain = parts[1];

        detected.push({
          rawText: normalized.split(/\s+/)[0],
          normalizedLabel: fuzzy.label,
          displayLabel: fuzzy.label,
          confidence: fuzzy.confidence,
          pageIndex,
          bbox: line.bbox,
          normalized: line.normalized,
          lineIndex: i,
        });
      }
    }
  }

  // Write the final currentMain back to the shared context so the next page starts where this one left off
  if (context) {
    context.currentMain = currentMain;
  }

  // Sort by vertical position
  detected.sort((a, b) => (a.normalized?.y ?? 0) - (b.normalized?.y ?? 0));

  return detected;
}

