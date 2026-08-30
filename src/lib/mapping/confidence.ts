import type { AnswerMapping, ConfidenceThresholds } from '@/lib/types';
import { DEFAULT_CONFIDENCE_THRESHOLDS, getConfidenceLevel } from '@/lib/types';

/**
 * Compute mapping confidence level from numeric confidence.
 * Uses configurable thresholds (default: high >= 0.85, medium >= 0.5).
 */
export function computeMappingConfidenceLevel(
  confidence: number,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS
): 'high' | 'medium' | 'low' {
  return getConfidenceLevel(confidence, thresholds);
}

/**
 * Compute simple label similarity score between two normalized label strings.
 * Returns 0–1 where 1 = identical.
 */
export function labelSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  // Levenshtein-based similarity
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - dist / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}
