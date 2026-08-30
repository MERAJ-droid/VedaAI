/**
 * answer-segmenter.ts
 *
 * Hybrid OCR + Gemini Vision pipeline for handwritten answer segmentation.
 *
 * Pipeline:
 *   Step 1a: OCR regex-based label detection  (existing, fast)
 *   Step 1b: Gemini Vision label detection    (new, semantic)
 *   Step 1c: Fusion → BoundaryCandidate[]    (confidence-scored, MCQ-aware)
 *   Step 1d: Convert to DetectedLabel[]      (feeds existing slice engine)
 *   Steps 2–8: unchanged slice / region / MCQ-option logic
 */

import type {
  ProcessedPage,
  OCRLine,
  Answer,
  AnswerRegion,
  NormalizedBox,
  BoundingBox,
  DetectedLabel,
  Question,
  PageImage,
} from '@/lib/types';
import { detectLabels, formatDisplayLabel } from '@/lib/extraction/label-detector';
import { detectLabelsWithGeminiVision, type GeminiVisionLabel } from '@/lib/extraction/gemini-vision-segmenter';
import {
  unionNormalizedBoxes,
  computeWeightedOCRConfidence,
  alignToDisplayPage,
} from '@/lib/ocr/coordinate-utils';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface LabeledSlice {
  label: DetectedLabel;
  pageIndex: number;
  lines: OCRLine[];
}

/**
 * A candidate answer-boundary after fusion of OCR + Gemini signals.
 *
 * classification:
 *   confirmed_question — confidence >= 0.70 → becomes an answer boundary
 *   possible_question  — confidence >= 0.40 → becomes an answer boundary (flagged)
 *   body_content       — confidence <  0.40 → discarded (no boundary)
 */
interface BoundaryCandidate {
  normalizedLabel: string;
  displayLabel: string;
  pageIndex: number;
  /** Best OCR line found for this boundary — provides authoritative geometry */
  ocrLine: OCRLine | null;
  /** Fallback vertical position if ocrLine is null */
  approximateY: number;
  confidence: number;
  classification: 'confirmed_question' | 'possible_question' | 'body_content';
  signals: string[];
  geminiSource: GeminiVisionLabel | null;
  ocrSource: DetectedLabel | null;
}

// MCQ selected-option pattern: answer text is a single option letter
// Matches: "C", "(C)", "c", "(c)", "[C]", "C." — flexible for OCR noise
const MCQ_SELECTED_OPTION = /^\s*[(\[]?\s*([A-Da-d])\s*[)\].]?\s*$/;

// ─── Fix B: standalone sub-part guard ────────────────────────────────────────
// Labels that are pure Roman numerals (i, ii, iii...xii) or single lowercase
// letters (a, b, c...) are NEVER answer boundaries unless they explicitly appear
// in the known question schema. This prevents answer body list items such as:
//   (i) deforestation  (ii) pollution  (iii) climate change
// from being treated as question boundaries.

/** Matches Roman numeral labels only (covers i–xii which are common in exams). */
const PURE_ROMAN_NUMERAL = /^(i{1,3}|iv|vi{0,3}|ix|x|xi{0,3}|xii)$/;

/** Matches a single lowercase letter label (a–z). */
const SINGLE_LOWERCASE_LETTER = /^[a-z]$/;

/**
 * Returns true if the normalized label is an answer-body sub-part that should
 * be rejected unless it appears explicitly in the known question schema.
 *
 * Catches:
 *  - Pure Roman numerals: i, ii, iii, iv … xii
 *  - Single lowercase letters: a, b, c … z
 *  - "?" + roman: OCR artifact from label-detector.ts when currentMain is empty
 *    and a standalone "(ii)" is seen.  actualMain = currentMain || '?' → "?ii"
 *
 * Does NOT catch "?" alone or "?"+letter — those may be blurry real labels.
 *
 * true:  "i", "ii", "iv", "a", "b", "?i", "?ii"
 * false: "1i", "1ii", "3a", "1", "2", "?", "?a"
 */
function isStandaloneSubpart(label: string): boolean {
  if (PURE_ROMAN_NUMERAL.test(label)) return true;
  if (SINGLE_LOWERCASE_LETTER.test(label)) return true;
  if (/^\?[ivxlcdm]+$/.test(label)) return true;
  return false;
}


// ─────────────────────────────────────────────────────────────────────────────
// Main export
/**
 * Segments handwritten answers from OCR pages using a hybrid
 * OCR-regex + Gemini Vision pipeline.
 *
 * @param pages               - Processed OCR pages (text + spatial geometry)
 * @param knownQuestionLabels - Question IDs from the question paper
 * @param questions           - Full Question objects (MCQ schema, etc.)
 * @param pageImages          - Original answer-sheet page images (for Gemini Vision)
 */
export async function segmentAnswers(
  pages: ProcessedPage[],
  knownQuestionLabels: string[],
  questions?: Question[],
  pageImages?: PageImage[]
): Promise<Answer[]> {


  // ── Reference sets ─────────────────────────────────────────────────────────
  const knownSet = new Set(knownQuestionLabels.map(l => l.toLowerCase().trim()));

  const maxKnownNumber = Math.max(
    0,
    ...knownQuestionLabels.map(l => parseInt(l.replace(/\D/g, '') || '0', 10))
  );

  /** MCQ question IDs — option labels on the answer sheet are NOT boundaries */
  const mcqIds = new Set(
    (questions ?? [])
      .filter(q => q.type === 'mcq')
      .map(q => q.id.toLowerCase().trim())
  );

  // ── Step 1a: OCR regex-based label detection ───────────────────────────────
  // Each page starts with fresh currentMain — no cross-page propagation.
  // Gemini Vision handles cross-page label identification semantically.
  // Within a single page, currentMain still works (e.g. "3." then "(a)" → "3a").
  const rawOCRLabels: DetectedLabel[] = pages.flatMap(page =>
    detectLabels(page.lines, page.pageIndex, knownQuestionLabels)
  );


  console.log(`[segmentAnswers] Step 1a: ${rawOCRLabels.length} raw OCR labels detected`);

  // ── Step 1b: Gemini Vision label detection (if images available) ───────────
  let geminiLabels: GeminiVisionLabel[] = [];
  if (pageImages && pageImages.length > 0) {
    console.log(`[segmentAnswers] Step 1b: Running Gemini Vision on ${pageImages.length} page(s)...`);
    try {
      geminiLabels = await detectLabelsWithGeminiVision(pageImages, knownQuestionLabels, mcqIds);
    } catch (err) {
      console.warn('[segmentAnswers] Gemini Vision failed — continuing with OCR-only:', err);
    }
  } else {
    console.log('[segmentAnswers] Step 1b: No page images — skipping Gemini Vision');
  }


  // ── Step 1c: Fusion (Gemini=WHAT, OCR=WHERE) ──────────────────────────────
  const candidates = fuseLabels(
    geminiLabels, rawOCRLabels, pages, knownSet, mcqIds, maxKnownNumber
  );

  // ── Per-candidate debug trace ─────────────────────────────────────────────
  // Log the full pipeline for each candidate AFTER fusion, BEFORE guards.
  for (const c of candidates) {
    const ocrPart = c.ocrSource
      ? `OCR: "${c.ocrSource.rawText}" → "${c.ocrSource.normalizedLabel}"`
      : 'OCR: (none)';
    const geminiPart = c.geminiSource
      ? `Gemini: "${c.geminiSource.anchorText}" → "${c.geminiSource.normalizedLabel}" conf=${c.geminiSource.confidence.toFixed(2)}`
      : 'Gemini: (none)';
    const scorePart = `Score: ${c.confidence.toFixed(2)} ${c.classification}`;
    const signalsPart = `[${c.signals.join(', ')}]`;
    console.log(
      `[fusion] Page ${c.pageIndex} y=${c.approximateY.toFixed(2)} | ` +
      `${ocrPart} | ${geminiPart} | Final: "${c.normalizedLabel}" | ` +
      `${scorePart} | ${signalsPart}`
    );
  }

  // ── Step 1c½: Parent context correction ───────────────────────────────────
  // When Gemini sees a standalone sub-part like "(ii)" on a later page, it may:
  //   a) Default to parent "1" (→ "1ii") when it should be "2ii"
  //   b) Return bare "ii" with no parent at all
  // By looking at what came before, we can correct the parent.
  //
  // SAFEGUARD: Only reparent when Gemini INFERRED the parent (anchor text is a
  // bare sub-part like "(ii)"). When Gemini explicitly named the parent (e.g.
  // "2.(i)"), trust it — don't reparent.
  const sortedForContext = [...candidates].sort((a, b) =>
    a.pageIndex !== b.pageIndex
      ? a.pageIndex - b.pageIndex
      : a.approximateY - b.approximateY
  );
  let lastConfirmedParent = '';
  for (const c of sortedForContext) {
    if (c.classification === 'body_content') continue;

    // Case A: Bare sub-part with no parent (e.g. "ii", "iii", "v")
    // parseLabel can't decompose these (no leading digits). Handle first.
    if (isStandaloneSubpart(c.normalizedLabel) && lastConfirmedParent) {
      const correctedLabel = lastConfirmedParent + c.normalizedLabel;
      if (knownSet.has(correctedLabel)) {
        const anchorText = (c.geminiSource?.anchorText ?? '').trim();
        console.log(
          `[fusion] Parent correction (bare sub-part): "${c.normalizedLabel}" → "${correctedLabel}" ` +
          `(context parent="${lastConfirmedParent}", anchor="${anchorText}", page ${c.pageIndex})`
        );
        c.normalizedLabel = correctedLabel;
        const { main: newMain, sub: newSub } = parseLabel(correctedLabel);
        c.displayLabel = formatDisplayLabel(newMain, newSub || undefined);
      }
      // Don't update lastConfirmedParent — sub-parts don't change the parent
      continue;
    }

    // Case B: Label with leading digits (parseLabel can decompose)
    const { main, sub } = parseLabel(c.normalizedLabel);
    if (!sub) {
      // Bare number (e.g. "3", "4") — update context
      lastConfirmedParent = main;
      continue;
    }

    // Has a sub-part. Check if Gemini explicitly included the parent number
    // in its anchor text. If so, trust it and update context.
    const anchorText = (c.geminiSource?.anchorText ?? '').trim();
    const anchorHasExplicitParent = /^\d/.test(anchorText);
    if (anchorHasExplicitParent) {
      // Gemini explicitly wrote e.g. "2.(i)" → parent "2" is trustworthy
      lastConfirmedParent = main;
      continue;
    }

    // Gemini inferred the parent from a standalone sub-part like "(ii)".
    // Check if the previous context suggests a different parent.
    if (main === lastConfirmedParent || !lastConfirmedParent) {
      lastConfirmedParent = main;
      continue;
    }

    // The parent differs from context. Check if reparenting makes a valid label.
    const correctedLabel = lastConfirmedParent + sub;
    if (knownSet.has(correctedLabel)) {
      console.log(
        `[fusion] Parent correction: "${c.normalizedLabel}" → "${correctedLabel}" ` +
        `(context parent="${lastConfirmedParent}", anchor="${anchorText}", page ${c.pageIndex})`
      );
      c.normalizedLabel = correctedLabel;
      const { main: newMain, sub: newSub } = parseLabel(correctedLabel);
      c.displayLabel = formatDisplayLabel(newMain, newSub || undefined);
    }

    lastConfirmedParent = parseLabel(c.normalizedLabel).main;
  }

  // ── Step 1d: Guards (applied AFTER fusion — Gemini has already corrected labels) ─
  const activeCandidates: typeof candidates = [];
  const usedBoundaryLabels = new Set<string>();

  for (const c of candidates) {
    // Guard 1 — MCQ option guard:
    // If the leading digits belong to an MCQ question AND the full label ≠ those digits
    // (e.g. "3a" where Q3 is MCQ), the suffix is an option letter, not a boundary.
    const leadingDigits = c.normalizedLabel.match(/^(\d+)/)?.[1];
    if (leadingDigits && mcqIds.has(leadingDigits) && c.normalizedLabel !== leadingDigits) {
      console.log(`[guard] REJECTED "${c.normalizedLabel}" — Guard 1: MCQ option (Q${leadingDigits} is MCQ)`);
      continue;
    }

    // Guard 2 — Standalone sub-part guard:
    // Pure Roman numerals (i, ii, iii...) and single lowercase letters (a, b, c...)
    // that appear without a parent number prefix are answer-body list items,
    // NOT question boundaries — UNLESS the label exists explicitly in knownSet.
    if (isStandaloneSubpart(c.normalizedLabel) && !knownSet.has(c.normalizedLabel)) {
      console.log(`[guard] REJECTED "${c.normalizedLabel}" — Guard 2: standalone sub-part, not in known schema`);
      continue;
    }

    // Guard 3 — Confidence threshold:
    if (c.classification === 'body_content') {
      console.log(`[guard] REJECTED "${c.normalizedLabel}" — Guard 3: body_content (score ${c.confidence.toFixed(2)} < 0.40)`);
      continue;
    }

    // Guard 4 — Duplicate label:
    // Each question label can appear at most once as a boundary. A second "1ii" is
    // either a list item inside another answer or a continuation (handled by the
    // continuation logic, not by creating a new boundary).
    if (usedBoundaryLabels.has(c.normalizedLabel)) {
      console.log(`[guard] REJECTED "${c.normalizedLabel}" — Guard 4: duplicate (already accepted on earlier page)`);
      continue;
    }
    usedBoundaryLabels.add(c.normalizedLabel);

    // Guard 5 — Out-of-range number:
    // If the candidate's main number exceeds the highest question number in the
    // paper, it MAY be a page number, roll number, or marks notation (phantom).
    // BUT: if the candidate is high-confidence (confirmed_question), it's likely
    // a real boundary the student wrote for a question that doesn't exist in the
    // paper -- let it through so it becomes an unmatched answer in mapping.
    // Only reject low-confidence out-of-range labels (phantoms).
    const { main: guardMain } = parseLabel(c.normalizedLabel);
    const guardMainNum = parseInt(guardMain, 10);
    if (!isNaN(guardMainNum) && maxKnownNumber > 0 && guardMainNum > maxKnownNumber) {
      if (c.classification === 'confirmed_question') {
        console.log(`[guard] PASSED "${c.normalizedLabel}" -- Guard 5: out-of-range (${guardMainNum} > ${maxKnownNumber}) but confirmed (score ${c.confidence.toFixed(2)}) -- will be unmatched`);
      } else {
        console.log(`[guard] REJECTED "${c.normalizedLabel}" -- Guard 5: main number ${guardMainNum} > maxKnownNumber ${maxKnownNumber} (${c.classification})`);
        continue;
      }
    }

    console.log(`[guard] ACCEPTED "${c.normalizedLabel}" — ${c.classification} (score ${c.confidence.toFixed(2)})`);
    activeCandidates.push(c);
  }



  console.log(
    `[segmentAnswers] Step 1c/d: ${candidates.length} candidates → ` +
    `${activeCandidates.length} active boundaries ` +
    `(${activeCandidates.filter(c => c.classification === 'confirmed_question').length} confirmed, ` +
    `${activeCandidates.filter(c => c.classification === 'possible_question').length} possible)`
  );


  // Convert BoundaryCandidate → DetectedLabel (feeds existing slice engine unchanged)
  const allLabels: DetectedLabel[] = activeCandidates.map(c =>
    candidateToDetectedLabel(c, pages)
  );

  // Sort: page first, then Y
  allLabels.sort((a, b) =>
    a.pageIndex !== b.pageIndex
      ? a.pageIndex - b.pageIndex
      : (a.normalized?.y ?? 0) - (b.normalized?.y ?? 0)
  );

  // ── Step 2: Build per-page line list ───────────────────────────────────────
  const pageLines: Map<number, OCRLine[]> = new Map();
  for (const page of pages) {
    const sorted = [...page.lines]
      .sort((a, b) => a.normalized.y - b.normalized.y)
      .map(l => ({ ...l, _pageIndex: page.pageIndex }));
    pageLines.set(page.pageIndex, sorted);
  }

  // ── Step 3: Slice lines between consecutive labels ─────────────────────────
  const slices: LabeledSlice[] = [];

  for (let i = 0; i < allLabels.length; i++) {
    const label = allLabels[i];
    const nextLabel = allLabels[i + 1];

    const lines = pageLines.get(label.pageIndex) ?? [];
    const labelY = label.normalized?.y ?? 0;
    const cutoffY = (nextLabel && nextLabel.pageIndex === label.pageIndex)
      ? (nextLabel.normalized?.y ?? 1) - 0.001
      : 1.0;

    const sliceLines = lines.filter(l =>
      l.normalized.y >= labelY - 0.005 &&
      l.normalized.y < cutoffY
    );

    slices.push({ label, pageIndex: label.pageIndex, lines: sliceLines });
  }

  // ── Step 3b: Rescue 0-line MCQ slices ──────────────────────────────────────
  // MCQ answers are tiny (single letter like "(C)") written right next to the
  // label. When two MCQ labels are very close (e.g. y=0.30 and y=0.34), the
  // answer content falls AT or past the next boundary's Y → captured by the
  // next slice. Fix: expand the range slightly to include the first line from
  // the adjacent slice's territory.
  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    if (slice.lines.length > 0) continue;

    // Only for MCQ labels
    const labelNorm = slice.label.normalizedLabel?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
    if (!labelNorm || !mcqIds.has(labelNorm)) continue;

    // Look for the first OCR line from the label's Y to slightly past the next boundary
    const lines = pageLines.get(slice.pageIndex) ?? [];
    const labelY = slice.label.normalized?.y ?? 0;
    const nextSlice = slices[i + 1];
    const expandedCutoff = (nextSlice && nextSlice.pageIndex === slice.pageIndex)
      ? (nextSlice.label.normalized?.y ?? 1) + 0.02  // look 2% past next boundary
      : 1.0;

    const rescueLines = lines.filter(l =>
      l.normalized.y >= labelY - 0.02 &&
      l.normalized.y < expandedCutoff
    );

    if (rescueLines.length > 0) {
      // Take only the first line — it likely has the MCQ answer
      slice.lines.push(rescueLines[0]);
      console.log(
        `[segmentAnswers] Rescued MCQ slice "${slice.label.displayLabel}": ` +
        `added line at y=${rescueLines[0].normalized.y.toFixed(2)} text="${rescueLines[0].text.substring(0, 30)}"`
      );
    }
  }

  // ── Step 4: Cross-page continuation ───────────────────────────────────────
  const continuedPages = new Set<number>();  // pages whose lines were fully consumed by continuation
  for (let pageIdx = 1; pageIdx < pages.length; pageIdx++) {
    const labelsOnPage = allLabels.filter(l => l.pageIndex === pageIdx);
    const firstLabelY = labelsOnPage.length > 0
      ? Math.min(...labelsOnPage.map(l => l.normalized?.y ?? 1))
      : 1.0;

    if (firstLabelY > 0.12) {
      const lines = pageLines.get(pageIdx) ?? [];
      const continuationLines = lines.filter(l => l.normalized.y < firstLabelY - 0.005);

      if (continuationLines.length > 0 && slices.length > 0) {
        const prevPageSlice = [...slices].reverse().find(s => s.pageIndex === pageIdx - 1);
        if (prevPageSlice) {
          prevPageSlice.lines.push(...continuationLines);
          console.log(
            `[segmentAnswers] Continued answer "${prevPageSlice.label.displayLabel}" ` +
            `with ${continuationLines.length} lines from page ${pageIdx}`
          );
          // If ALL lines on this page were consumed (no labels on page),
          // mark it so gap-based fallback doesn't create a duplicate segment.
          if (labelsOnPage.length === 0 && continuationLines.length === lines.length) {
            continuedPages.add(pageIdx);
          }
        }
      }
    }
  }

  // ── Step 5: Fallback for pages with no labels ──────────────────────────────
  const coveredPages = new Set(allLabels.map(l => l.pageIndex));
  for (const page of pages) {
    if (!coveredPages.has(page.pageIndex) && !continuedPages.has(page.pageIndex) && page.lines.length > 0) {
      console.log(`[segmentAnswers] Page ${page.pageIndex} has no labels — using gap-based fallback`);
      const gapBlocks = gapBasedSplit(page);
      for (const lines of gapBlocks) {
        if (lines.length === 0) continue;
        slices.push({
          label: {
            rawText: '',
            normalizedLabel: '',
            displayLabel: '',
            confidence: 0,
            pageIndex: page.pageIndex,
            bbox: lines[0].bbox,
            normalized: lines[0].normalized,
            lineIndex: 0,
          },
          pageIndex: page.pageIndex,
          lines,
        });
      }
    }
  }

  // ── Step 6: Build Answer objects ───────────────────────────────────────────
  // Keep 0-line segments for MCQ questions — the answer (e.g. "(C)") is often
  // on the same line as the label or marked non-textually (circled etc.).
  // Dropping them causes the MCQ question to go unmatched and potentially
  // steal content from other answers via fallback mapping.
  console.log(`[segmentAnswers] Step 6: ${slices.length} slices before filtering: ${slices.map(s => `${s.label.normalizedLabel || 'null'}(${s.lines.length}L)`).join(', ')}`);
  const answers: Answer[] = slices
    .filter(s => {
      if (s.lines.length > 0) return true;
      // Keep 0-line slice if it's a known MCQ question.
      // mcqIds contains full question IDs like "1i", "1ii", etc.
      const labelNorm = s.label.normalizedLabel?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
      if (labelNorm && mcqIds.has(labelNorm)) {
        console.log(`[segmentAnswers] Keeping 0-line MCQ segment "${s.label.displayLabel}" (id "${labelNorm}" is MCQ)`);
        return true;
      }
      return false;
    })
    .map(slice => {
      const linesByPage = new Map<number, OCRLine[]>();
      for (const line of slice.lines) {
        const pageIdx = (line as any)._pageIndex ?? slice.pageIndex;
        if (!linesByPage.has(pageIdx)) linesByPage.set(pageIdx, []);
        linesByPage.get(pageIdx)!.push(line);
      }

      const regions: AnswerRegion[] = [];
      for (const [pageIdx, pLines] of linesByPage.entries()) {
        const page = pages.find(p => p.pageIndex === pageIdx);
        const normalizedBoxes: NormalizedBox[] = pLines.map(l => l.normalized);
        const unionedNormalized = unionNormalizedBoxes(normalizedBoxes);

        const aligned = page
          ? alignToDisplayPage(unionedNormalized, page.transforms ?? [], page.orientation)
          : { aligned: unionedNormalized, useFallbackImage: false };

        regions.push({
          pageIndex: pageIdx,
          normalized: aligned.aligned,
          bbox: normalizedToBBox(aligned.aligned, page?.width ?? 0, page?.height ?? 0),
        });
      }

      regions.sort((a, b) => a.pageIndex - b.pageIndex);

      const text = slice.lines.map(l => l.text).join('\n');
      const ocrConfidence = computeWeightedOCRConfidence(
        slice.lines.map(l => ({ text: l.text, confidence: l.confidence }))
      );

      const hasLabel = !!slice.label.normalizedLabel;
      const segmentationConfidence = Math.max(0.1, hasLabel ? slice.label.confidence : 0.4);

      return {
        id: uuidv4(),
        studentLabel: hasLabel ? slice.label.displayLabel : null,
        rawStudentLabel: hasLabel ? slice.label.rawText : null,
        text,
        regions,
        ocrConfidence,
        segmentationConfidence,
      };
    });

  // ── Step 7: Sort answers by page then Y ───────────────────────────────────
  answers.sort((a, b) => {
    const aPage = a.regions[0]?.pageIndex ?? 0;
    const bPage = b.regions[0]?.pageIndex ?? 0;
    if (aPage !== bPage) return aPage - bPage;
    return (a.regions[0]?.normalized.y ?? 0) - (b.regions[0]?.normalized.y ?? 0);
  });

  // ── Step 8: Extract selectedOption for MCQ answers ────────────────────────
  for (const answer of answers) {
    const labelNorm = answer.studentLabel?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
    const labelDigits = labelNorm.match(/^(\d+)/)?.[1] ?? '';
    if (!labelDigits || !mcqIds.has(labelDigits)) continue;

    const lines = answer.text.split('\n');
    for (const line of lines) {
      const m = line.trim().match(MCQ_SELECTED_OPTION);
      if (m) {
        answer.selectedOption = m[1].toUpperCase();
        break;
      }
    }

    if (answer.selectedOption) {
      console.log(`[segmentAnswers] MCQ answer: Q${labelDigits} → option ${answer.selectedOption}`);
    }
  }

  console.log(`[segmentAnswers] Built ${answers.length} answer segments`);
  answers.forEach(a =>
    console.log(
      `  label="${a.studentLabel}" lines=${a.text.split('\n').length} ` +
      `segConf=${a.segmentationConfidence.toFixed(2)}` +
      `${a.selectedOption ? ` MCQ-opt=${a.selectedOption}` : ''}`
    )
  );

  return answers;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fusion engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fuse Gemini Vision labels with OCR regex labels into confidence-scored
 * BoundaryCandidate objects.
 *
 * Strategy:
 *   1. For each Gemini label, find the best-matching OCR label (same page,
 *      Y proximity ± 0.15, text anchor similarity).
 *   2. Compute confidence from multiple signals (see computeConfidence).
 *   3. For unclaimed OCR labels, compute confidence from OCR signals alone.
 *   4. Deduplicate candidates at the same page + close Y + same label.
 */
function fuseLabels(
  geminiLabels: GeminiVisionLabel[],
  ocrLabels: DetectedLabel[],
  pages: ProcessedPage[],
  knownSet: Set<string>,
  mcqIds: Set<string>,
  maxKnownNumber: number
): BoundaryCandidate[] {

  // Pre-compute OCR lines sorted by Y per page (for vertical gap signal)
  const sortedLinesByPage = new Map<number, OCRLine[]>();
  for (const page of pages) {
    sortedLinesByPage.set(
      page.pageIndex,
      [...page.lines].sort((a, b) => a.normalized.y - b.normalized.y)
    );
  }

  const claimedOCRIndices = new Set<number>();
  const candidates: BoundaryCandidate[] = [];

  // ── Pass 1: Gemini-driven candidates ──────────────────────────────────────
  for (const gl of geminiLabels) {
    // Find matching OCR label on the same page within Y ± 0.15
    let bestOCRIdx = -1;
    let bestOCRScore = 0;
    ocrLabels.forEach((ol, idx) => {
      if (ol.pageIndex !== gl.pageIndex) return;
      const yDiff = Math.abs((ol.normalized?.y ?? 0) - gl.approximateY);
      if (yDiff > 0.15) return;

      const textSim = textSimilarity(gl.anchorText, ol.rawText);
      const yScore = 1 - yDiff / 0.15;
      const score = 0.6 * textSim + 0.4 * yScore;

      if (score > bestOCRScore) {
        bestOCRScore = score;
        bestOCRIdx = idx;
      }
    });

    const ocrSource = bestOCRIdx >= 0 && bestOCRScore >= 0.3 ? ocrLabels[bestOCRIdx] : null;
    if (ocrSource) claimedOCRIndices.add(bestOCRIdx);

    // Resolve the authoritative OCR line for geometry
    const ocrLine = ocrSource
      ? findOCRLine(ocrSource, pages)
      : findOCRLineByY(gl.pageIndex, gl.approximateY, gl.anchorText, pages);

    // Normalised label: prefer Gemini's interpretation; fall back to OCR if Gemini returns "?"
    const normalizedLabel = gl.normalizedLabel === '?'
      ? (ocrSource?.normalizedLabel ?? '?')
      : gl.normalizedLabel;

    const { main, sub } = parseLabel(normalizedLabel);
    const displayLabel = formatDisplayLabel(main, sub || undefined);

    const signals: string[] = [];
    const confidence = computeConfidence({
      geminiConfidence: gl.confidence,
      geminiIsAmbiguous: gl.isAmbiguous ?? false,
      geminiSilent: false,  // Gemini detected this → not silent
      hasOCRPattern: !!ocrSource,
      normalizedLabel,
      ocrLine,
      knownSet,
      maxKnownNumber,
      signals,
    });

    candidates.push({
      normalizedLabel,
      displayLabel,
      pageIndex: gl.pageIndex,
      ocrLine,
      approximateY: gl.approximateY,
      confidence,
      classification: classifyByConfidence(confidence),
      signals,
      geminiSource: gl,
      ocrSource,
    });
  }

  // ── Pass 2: Unclaimed OCR-only candidates ──────────────────────────────────
  // Pre-compute which pages Gemini processed and what labels it found
  const geminiPageLabels = new Map<number, Set<string>>();
  for (const gl of geminiLabels) {
    if (!geminiPageLabels.has(gl.pageIndex)) {
      geminiPageLabels.set(gl.pageIndex, new Set());
    }
    geminiPageLabels.get(gl.pageIndex)!.add(gl.normalizedLabel);
  }

  ocrLabels.forEach((ol, idx) => {
    if (claimedOCRIndices.has(idx)) return;

    const ocrLine = findOCRLine(ol, pages);
    const { main, sub } = parseLabel(ol.normalizedLabel);
    const displayLabel = formatDisplayLabel(main, sub || undefined);

    // Gemini silence: Gemini processed this page but didn't detect this label.
    // Only apply to BARE DIGIT labels (e.g. "3", "5") — these are commonly
    // false positives from math content. Sub-part labels like "1ii" are specific
    // enough to be trustworthy even without Gemini confirmation.
    const geminiProcessedPage = geminiPageLabels.has(ol.pageIndex);
    const geminiDetectedLabel = geminiPageLabels.get(ol.pageIndex)?.has(ol.normalizedLabel) ?? false;
    const { sub: olSub } = parseLabel(ol.normalizedLabel);
    const isSilent = geminiProcessedPage && !geminiDetectedLabel && !olSub;

    const signals: string[] = [];
    const confidence = computeConfidence({
      geminiConfidence: null,
      geminiIsAmbiguous: false,
      geminiSilent: isSilent,
      hasOCRPattern: true,
      normalizedLabel: ol.normalizedLabel,
      ocrLine,
      knownSet,
      maxKnownNumber,
      signals,
    });

    candidates.push({
      normalizedLabel: ol.normalizedLabel,
      displayLabel,
      pageIndex: ol.pageIndex,
      ocrLine,
      approximateY: ol.normalized?.y ?? 0,
      confidence,
      classification: classifyByConfidence(confidence),
      signals,
      geminiSource: null,
      ocrSource: ol,
    });
  });

  // ── Deduplication: merge candidates at the same page + label + nearby Y ───
  return deduplicateCandidates(candidates);
}



// ─────────────────────────────────────────────────────────────────────────────
// Confidence computation
// ─────────────────────────────────────────────────────────────────────────────

interface ConfidenceInputs {
  /** Gemini's own confidence (null if no Gemini source) */
  geminiConfidence: number | null;
  /** True if Gemini flagged this candidate as ambiguous (isAmbiguous=true) */
  geminiIsAmbiguous: boolean;
  /** True if Gemini processed this page but did NOT detect this label at all.
   *  Gemini's silence is negative evidence — suppress known_exact boost. */
  geminiSilent: boolean;
  hasOCRPattern: boolean;
  normalizedLabel: string;
  ocrLine: OCRLine | null;
  knownSet: Set<string>;
  maxKnownNumber: number;
  signals: string[];
}

/**
 * Multi-signal confidence computation.
 *
 * Signals (independent, additive):
 *   Gemini Vision confirmation   +0.25 base + 0.25 × gemini.confidence  [primary]
 *   OCR pattern match            +0.15
 *   Exact match in knownSet      +0.30
 *   Left-margin x-position       +0.08 (x < 0.20) / +0.03 (x < 0.35)  [boost only]
 *   High OCR line confidence     +0.06 (line.confidence > 0.70)
 *   Numeric range compatible     +0.04 (number in [1, maxKnownNumber])   [boost only]
 *
 * When Gemini flags isAmbiguous=true:
 *   Gemini contribution = 0 (Gemini itself is uncertain, don't boost)
 *   known_exact = 0 (coincidental knownSet match shouldn't override Gemini's uncertainty)
 *
 * Thresholds:
 *   >= 0.70 → confirmed_question
 *   >= 0.40 → possible_question
 *    < 0.40 → body_content
 *
 * Design notes:
 *   - Sequence order is NOT a signal (answers may be out of order).
 *   - x-position is a CONFIDENCE BOOST, not a hard filter.
 *   - Numeric range is a CONFIDENCE BOOST, not a rejection rule.
 *   - Unknown numbers (> maxKnownNumber) can still reach possible_question
 *     if Gemini confirms them — they flow to unmatchedAnswers in mapping.
 */
function computeConfidence(inputs: ConfidenceInputs): number {
  const {
    geminiConfidence, geminiIsAmbiguous, hasOCRPattern, normalizedLabel, ocrLine,
    knownSet, maxKnownNumber, signals,
  } = inputs;

  let score = 0;

  // ── Primary: Gemini Vision ─────────────────────────────────────────────────
  // When isAmbiguous=true, Gemini itself says "I don't think this is a real
  // boundary." Treat its contribution as 0 — don't positively boost.
  if (geminiConfidence !== null && !geminiIsAmbiguous) {
    const contribution = 0.25 + 0.25 * geminiConfidence;
    score += contribution;
    signals.push(`gemini(${geminiConfidence.toFixed(2)}):+${contribution.toFixed(2)}`);
  } else if (geminiConfidence !== null && geminiIsAmbiguous) {
    signals.push(`gemini(${geminiConfidence.toFixed(2)}):AMBIGUOUS→+0.00`);
  }

  // ── OCR pattern match ──────────────────────────────────────────────────────
  if (hasOCRPattern) {
    score += 0.15;
    signals.push('ocr_pattern:+0.15');
  }

  // ── Known label exact match ────────────────────────────────────────────────
  // Suppressed when:
  //   - Gemini flags ambiguous — coincidental match shouldn't override Gemini
  //   - Gemini is silent — Gemini processed the page but didn't detect this label,
  //     so the OCR detection is likely noise (e.g. number in math content)
  const suppressKnown = geminiIsAmbiguous || inputs.geminiSilent;
  if (knownSet.has(normalizedLabel) && !suppressKnown) {
    score += 0.30;
    signals.push('known_exact:+0.30');
  } else if (knownSet.has(normalizedLabel) && geminiIsAmbiguous) {
    signals.push('known_exact:SUPPRESSED(ambiguous)');
  } else if (knownSet.has(normalizedLabel) && inputs.geminiSilent) {
    signals.push('known_exact:SUPPRESSED(gemini_silent)');
  }

  if (ocrLine) {
    // ── Spatial: left-margin proximity (confidence boost, not hard filter) ───
    const x = ocrLine.normalized.x;
    if (x < 0.20) {
      score += 0.08;
      signals.push(`margin(x=${x.toFixed(2)}):+0.08`);
    } else if (x < 0.35) {
      score += 0.03;
      signals.push(`near-margin(x=${x.toFixed(2)}):+0.03`);
    }

    // ── High OCR confidence ──────────────────────────────────────────────────
    if (ocrLine.confidence > 0.70) {
      score += 0.06;
      signals.push(`ocr-conf(${ocrLine.confidence.toFixed(2)}):+0.06`);
    }
  }

  // ── Numeric range compatibility (confidence boost, not rejection rule) ─────
  const numericPart = parseInt(normalizedLabel.replace(/\D/g, '') || '0', 10);
  if (numericPart > 0 && numericPart <= maxKnownNumber) {
    score += 0.04;
    signals.push(`in-range(${numericPart}/${maxKnownNumber}):+0.04`);
  }

  return Math.min(1.0, score);
}

function classifyByConfidence(confidence: number): BoundaryCandidate['classification'] {
  if (confidence >= 0.70) return 'confirmed_question';
  if (confidence >= 0.40) return 'possible_question';
  return 'body_content';
}

// ─────────────────────────────────────────────────────────────────────────────
// Text similarity (for OCR anchor matching)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Text similarity (for OCR anchor matching)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
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

function textSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  if (na.startsWith(nb) || nb.startsWith(na)) return 0.85;
  const dist = levenshtein(na, nb);
  return Math.max(0, 1 - dist / Math.max(na.length, nb.length));
}

// ─────────────────────────────────────────────────────────────────────────────
// OCR line lookup helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Find the OCR line referenced by a DetectedLabel (by lineIndex on its page) */
function findOCRLine(label: DetectedLabel, pages: ProcessedPage[]): OCRLine | null {
  const page = pages.find(p => p.pageIndex === label.pageIndex);
  return page?.lines[label.lineIndex] ?? null;
}

/**
 * For a Gemini label with no OCR match, try to find the closest OCR line on the page
 * using Y-proximity and text anchor similarity.
 */
function findOCRLineByY(
  pageIndex: number,
  approximateY: number,
  anchorText: string,
  pages: ProcessedPage[]
): OCRLine | null {
  const page = pages.find(p => p.pageIndex === pageIndex);
  if (!page) return null;

  // Search within ± 0.10 of the approximate Y
  const candidates = page.lines.filter(l =>
    Math.abs(l.normalized.y - approximateY) < 0.10
  );

  if (candidates.length > 0) {
    // Score by combined Y-distance + text similarity
    let best: OCRLine | null = null;
    let bestScore = -1;
    for (const line of candidates) {
      const yDist = Math.abs(line.normalized.y - approximateY);
      const sim = textSimilarity(anchorText, line.text);
      const score = 0.5 * sim + 0.5 * (1 - yDist / 0.10);
      if (score > bestScore) {
        bestScore = score;
        best = line;
      }
    }
    return best;
  }

  // Fallback: when approximateY >= 0.90 (likely unreliable / "position unknown"),
  // search ALL lines on the page for text that matches the anchor.
  // This handles Gemini returning y=1.00 as a default when it can't
  // estimate position, preventing the continuation logic from swallowing
  // entire pages into the previous answer.
  if (approximateY >= 0.90) {
    let best: OCRLine | null = null;
    let bestSim = 0.3; // minimum threshold for a text match
    for (const line of page.lines) {
      const sim = textSimilarity(anchorText, line.text);
      if (sim > bestSim) {
        bestSim = sim;
        best = line;
      }
    }
    if (best) {
      console.log(
        `[fusion] Fixed unreliable Gemini y=${approximateY.toFixed(2)} → ` +
        `OCR line y=${best.normalized.y.toFixed(2)} (text match "${best.text.substring(0, 30)}")`
      );
    }
    return best;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge candidates that represent the same boundary (same page, same label, Y within 0.05).
 * The highest-confidence candidate wins; its confidence is bumped slightly by agreement.
 */
function deduplicateCandidates(candidates: BoundaryCandidate[]): BoundaryCandidate[] {
  const result: BoundaryCandidate[] = [];

  for (const c of candidates) {
    const existing = result.find(r =>
      r.pageIndex === c.pageIndex &&
      r.normalizedLabel === c.normalizedLabel &&
      Math.abs(r.approximateY - c.approximateY) < 0.05
    );

    if (existing) {
      // Merge: keep the higher-confidence one, slightly boost confidence for agreement
      if (c.confidence > existing.confidence) {
        existing.confidence = Math.min(1.0, c.confidence + 0.05);
        existing.ocrLine = c.ocrLine ?? existing.ocrLine;
        existing.geminiSource = c.geminiSource ?? existing.geminiSource;
        existing.ocrSource = c.ocrSource ?? existing.ocrSource;
        existing.signals = [...existing.signals, ...c.signals, 'merged:+0.05'];
      } else {
        existing.confidence = Math.min(1.0, existing.confidence + 0.05);
        existing.signals.push('merged:+0.05');
      }
      existing.classification = classifyByConfidence(existing.confidence);
    } else {
      result.push({ ...c });
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion: BoundaryCandidate → DetectedLabel (for slice engine)
// ─────────────────────────────────────────────────────────────────────────────

function candidateToDetectedLabel(c: BoundaryCandidate, pages: ProcessedPage[]): DetectedLabel {
  const ocrLine = c.ocrLine;
  const page = pages.find(p => p.pageIndex === c.pageIndex);
  const pageHeight = page?.height ?? 1000;

  // Fallback geometry if no OCR line was found
  const fallbackNormalized: NormalizedBox = {
    x: 0.02,
    y: c.approximateY,
    width: 0.10,
    height: 0.02,
  };
  const fallbackBbox: BoundingBox = {
    x: 0,
    y: Math.round(c.approximateY * pageHeight),
    width: 80,
    height: 20,
  };

  const rawText = c.ocrSource?.rawText ?? c.geminiSource?.anchorText ?? c.normalizedLabel;
  const lineIndex = c.ocrSource?.lineIndex ?? 0;

  return {
    rawText,
    normalizedLabel: c.normalizedLabel,
    displayLabel: c.displayLabel,
    confidence: c.confidence,
    pageIndex: c.pageIndex,
    bbox: ocrLine?.bbox ?? fallbackBbox,
    normalized: ocrLine?.normalized ?? fallbackNormalized,
    lineIndex,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Label parsing helper
// ─────────────────────────────────────────────────────────────────────────────

/** Split "3a" → { main: "3", sub: "a" } or "3" → { main: "3", sub: "" } */
function parseLabel(norm: string): { main: string; sub: string } {
  const m = norm.match(/^(\d+)([a-z]*)$/);
  return m ? { main: m[1], sub: m[2] } : { main: norm, sub: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (unchanged from original)
// ─────────────────────────────────────────────────────────────────────────────

function gapBasedSplit(page: ProcessedPage): OCRLine[][] {
  const lines = [...page.lines].sort((a, b) => a.normalized.y - b.normalized.y);
  if (lines.length === 0) return [];

  const heights = lines.map(l => l.normalized.height).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 0.02;
  const gapThreshold = 2.5 * medianH;

  const groups: OCRLine[][] = [[lines[0]]];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const curr = lines[i];
    const gap = curr.normalized.y - (prev.normalized.y + prev.normalized.height);
    if (gap > gapThreshold) {
      groups.push([curr]);
    } else {
      groups[groups.length - 1].push(curr);
    }
  }
  return groups;
}

function normalizedToBBox(n: NormalizedBox, pageWidth: number, pageHeight: number): BoundingBox {
  return {
    x: Math.round(n.x * pageWidth),
    y: Math.round(n.y * pageHeight),
    width: Math.round(n.width * pageWidth),
    height: Math.round(n.height * pageHeight),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug export — exposes intermediate fusion data for the /debug/document UI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A boundary candidate in debug-serializable form.
 * All fields are plain JSON — no Buffers, no OCRLine objects.
 */
export interface DebugBoundary {
  normalizedLabel: string;
  displayLabel: string;
  pageIndex: number;
  /** Authoritative bbox from OCR (null if no OCR line was matched) */
  ocrNormalized: NormalizedBox | null;
  /** Gemini Vision approximate Y (0–1) */
  approximateY: number;
  confidence: number;
  classification: 'confirmed_question' | 'possible_question' | 'body_content';
  signals: string[];
  /** Verbatim OCR text on the label line */
  ocrRawText: string | null;
  /** Gemini's verbatim reading of the label */
  geminiAnchorText: string | null;
  /** Gemini's own confidence for this boundary */
  geminiConfidence: number | null;
  /** Gemini's one-sentence reasoning */
  geminiReasoning: string | null;
  isGeminiAmbiguous: boolean;
  /** Which pipeline(s) detected this boundary */
  source: 'gemini+ocr' | 'gemini-only' | 'ocr-only';
}

/**
 * Run only the boundary-identification phase (Steps 1a–1c of segmentAnswers)
 * and return all three intermediate layers for the debug UI.
 *
 * Does NOT run the slice / answer-build / MCQ logic (Steps 2–8).
 * Call this from the debug API route instead of the full segmentAnswers.
 *
 * @param pages               - OCR pages of the answer sheet
 * @param knownQuestionLabels - Known question IDs (e.g. ["1","2","3a"])
 * @param pageImages          - Answer sheet page images (enables Gemini Vision)
 */
export async function debugSegmentation(
  pages: ProcessedPage[],
  knownQuestionLabels: string[],
  pageImages?: PageImage[]
): Promise<{
  ocrLabels: DetectedLabel[];
  geminiLabels: GeminiVisionLabel[];
  boundaries: DebugBoundary[];
}> {
  const knownSet = new Set(knownQuestionLabels.map(l => l.toLowerCase().trim()));
  const maxKnownNumber = Math.max(
    0,
    ...knownQuestionLabels.map(l => parseInt(l.replace(/\D/g, '') || '0', 10))
  );
  const mcqIds = new Set<string>(); // no question schema in debug mode

  // Step 1a: OCR regex labels (per-page, no cross-page context)
  const ocrLabels: DetectedLabel[] = pages.flatMap(page =>
    detectLabels(page.lines, page.pageIndex, knownQuestionLabels)
  );

  // Step 1b: Gemini Vision labels (only if images are available)
  let geminiLabels: GeminiVisionLabel[] = [];
  if (pageImages && pageImages.length > 0) {
    try {
      geminiLabels = await detectLabelsWithGeminiVision(pageImages, knownQuestionLabels, mcqIds);
    } catch (err) {
      console.warn('[debugSegmentation] Gemini Vision failed:', err);
    }
  }

  // Step 1c: Fusion
  const candidates = fuseLabels(
    geminiLabels, ocrLabels, pages, knownSet, mcqIds, maxKnownNumber
  );

  const boundaries: DebugBoundary[] = candidates.map(c => ({
    normalizedLabel: c.normalizedLabel,
    displayLabel: c.displayLabel,
    pageIndex: c.pageIndex,
    ocrNormalized: c.ocrLine?.normalized ?? null,
    approximateY: c.approximateY,
    confidence: c.confidence,
    classification: c.classification,
    signals: c.signals,
    ocrRawText: c.ocrSource?.rawText ?? null,
    geminiAnchorText: c.geminiSource?.anchorText ?? null,
    geminiConfidence: c.geminiSource?.confidence ?? null,
    geminiReasoning: c.geminiSource?.reasoning ?? null,
    isGeminiAmbiguous: c.geminiSource?.isAmbiguous ?? false,
    source: (c.geminiSource && c.ocrSource)
      ? 'gemini+ocr'
      : c.geminiSource
        ? 'gemini-only'
        : 'ocr-only',
  }));

  return { ocrLabels, geminiLabels, boundaries };
}
