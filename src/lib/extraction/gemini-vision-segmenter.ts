/**
 * gemini-vision-segmenter.ts
 *
 * Identifies answer-start boundaries in handwritten answer sheet images using
 * Gemini Vision. This is the semantic layer of the hybrid OCR + Vision pipeline.
 *
 * Design:
 *  - Each page is sent as a SEPARATE Gemini Vision call (controlled concurrency).
 *  - Images are resized to max GEMINI_IMAGE_MAX_WIDTH before encoding — OCR images
 *    are never touched (fix C).
 *  - Concurrency is controlled via GEMINI_VISION_CONCURRENCY env var (default 1).
 *  - If a page call fails (rate limit, etc.), it returns [] for that page —
 *    the answer-segmenter falls back to OCR-only for boundaries not confirmed by Gemini.
 */

import type { PageImage } from '@/lib/types';
import { geminiVisionStructuredRequest } from '@/lib/gemini';
import sharp from 'sharp';

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Maximum pixel width for images sent to Gemini Vision.
 * Source images for OCR are NEVER resized — only the Gemini copy.
 * Configurable via GEMINI_IMAGE_MAX_WIDTH env var.
 */
const GEMINI_IMAGE_MAX_WIDTH = Math.max(
  400,
  parseInt(process.env.GEMINI_IMAGE_MAX_WIDTH || '1200', 10)
);

/**
 * Max pages processed in parallel per Gemini Vision batch.
 * concurrency=1 means strictly sequential (recommended for free tier).
 * concurrency=0 DISABLES Gemini Vision entirely — OCR-only mode.
 * Configurable via GEMINI_VISION_CONCURRENCY env var.
 */
const _RAW_CONCURRENCY = parseInt(process.env.GEMINI_VISION_CONCURRENCY || '1', 10);
const GEMINI_VISION_ENABLED = _RAW_CONCURRENCY !== 0;
const GEMINI_VISION_CONCURRENCY = Math.max(1, _RAW_CONCURRENCY);


/** Inter-batch delay in ms to ease rate-limit pressure between page batches. */
const INTER_BATCH_DELAY_MS = 600;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single answer-boundary detection from Gemini Vision.
 * These are SEMANTIC identifications — geometry comes from OCR, not from here.
 */
export interface GeminiVisionLabel {
  /** Gemini's interpretation of the question number, normalised lowercase (e.g. "1", "3a", "1i") */
  normalizedLabel: string;
  /** The verbatim text Gemini sees at this boundary */
  anchorText: string;
  /** 0.0–1.0: Gemini's own confidence this is a question-answer boundary */
  confidence: number;
  /** 0.0–1.0: approximate vertical position (top=0, bottom=1) */
  approximateY: number;
  /** 0-based global page index */
  pageIndex: number;
  /** One-sentence explanation */
  reasoning: string;
  /** true if Gemini is uncertain whether this is a boundary or body text */
  isAmbiguous: boolean;
}

// ─── Image resize (Fix C) ─────────────────────────────────────────────────────

interface GeminiImage {
  buffer: Buffer;
  mimeType: 'image/png';
  sentWidth: number;
  sentHeight: number;
}

/**
 * Resize a page image to at most GEMINI_IMAGE_MAX_WIDTH wide.
 * Never modifies the source PageImage — always returns a new buffer.
 * Logs original vs sent dimensions.
 */
async function resizeForGemini(pi: PageImage): Promise<GeminiImage> {
  const { buffer, width, height, pageIndex } = pi;

  if (width <= GEMINI_IMAGE_MAX_WIDTH) {
    console.log(`[GeminiVision] Page ${pageIndex}: ${width}×${height}px → sending as-is (≤${GEMINI_IMAGE_MAX_WIDTH}px)`);
    return { buffer, mimeType: 'image/png', sentWidth: width, sentHeight: height };
  }

  const scale = GEMINI_IMAGE_MAX_WIDTH / width;
  const newH  = Math.round(height * scale);

  const resized = await sharp(buffer)
    .resize(GEMINI_IMAGE_MAX_WIDTH, newH, { fit: 'fill' })
    .png({ compressionLevel: 6 })
    .toBuffer();

  console.log(
    `[GeminiVision] Page ${pageIndex}: ${width}×${height}px → resized to ${GEMINI_IMAGE_MAX_WIDTH}×${newH}px ` +
    `(scale=${scale.toFixed(3)}, OCR image unchanged)`
  );
  return { buffer: resized, mimeType: 'image/png', sentWidth: GEMINI_IMAGE_MAX_WIDTH, sentHeight: newH };
}

// ─── Single-page detection (Fix D) ───────────────────────────────────────────

/**
 * Detect answer-start boundaries on ONE page using Gemini Vision.
 * Returns the detected labels with the page's GLOBAL pageIndex.
 * Returns [] on any error — caller falls back to OCR-only for this page.
 */
async function detectLabelsOnPage(
  pageImage: PageImage,
  knownQuestionLabels: string[],
  mcqIds: Set<string>
): Promise<GeminiVisionLabel[]> {

  // Resize for Gemini — OCR source is untouched
  let geminiImage: GeminiImage;
  try {
    geminiImage = await resizeForGemini(pageImage);
  } catch (err) {
    console.error(`[GeminiVision] Page ${pageImage.pageIndex}: resize failed:`, err);
    return [];
  }

  const knownList = knownQuestionLabels.length > 0 ? knownQuestionLabels.join(', ') : '(none provided)';
  const mcqNote  = mcqIds.size > 0
    ? `\nMCQ questions — student writes a single letter (A/B/C/D) as their answer, not sub-question labels: ${[...mcqIds].join(', ')}`
    : '';

  const prompt = `You are analyzing ONE page of a student's HANDWRITTEN ANSWER SHEET.

Question paper contains these question labels: ${knownList}${mcqNote}

TASK: Find every location where the student wrote a QUESTION LABEL to start their answer.

Return for each boundary:
- normalizedLabel : question number, lowercase (e.g. "1", "3a", "1i", "1ii"). Use "?" only if completely unreadable.
- anchorText      : VERBATIM text written at that spot as accurately as possible.
- confidence      : 0.0–1.0 — how confident you are this is a question label (not body text).
- approximateY    : 0.0 = top of page, 1.0 = bottom. Estimate to 2 decimal places.
- pageIndex       : always 0 (single page call).
- reasoning       : one sentence.
- isAmbiguous     : true if you are uncertain.

RULES (read every rule before responding):

1. OUT-OF-ORDER answers are EXPECTED. Do not skip a label just because the sequence looks wrong.

2. MCQ option letters (A), (B), (C), (D) written as the student's CHOSEN ANSWER are NOT boundaries.

3. ROMAN NUMERAL or NUMBERED LIST ITEMS inside a running answer are NOT boundaries.
   These arise when a student lists their points using (i), (ii), (iii) or 1, 2, 3 inside ONE answer.
   Example (body text — do NOT report any of these):
     "The major discoveries are:
      (i) Rutherford's atomic model
      (ii) Bohr's model
      (iii) de Broglie's wave-particle duality"
   Here (i), (ii), (iii) mark list items within ONE answer, not the start of new questions.
   A key signal: genuine question boundaries always have a CLEAR question number (e.g. "3.", "Q.2",
   "1(ii)"). If what you see is only a roman numeral or letter with no visible question number,
   it is almost certainly a list item inside an answer — do not report it.



4. Mathematical step numbers, equation references, or calculation intermediate values are NOT boundaries.

5. Valid boundary label formats: "3.", "Q3", "Ans.3", "3)", "3 .", "1(ii)", "③", "2a", "2 a".

6. Partially illegible labels: report them with low confidence and isAmbiguous=true.

7. Do NOT report pixel coordinates. Only approximateY (0.0–1.0) is required.

Examine the image and return ALL answer-start boundaries you can see.`;

  const schema = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        normalizedLabel: { type: 'string' },
        anchorText:      { type: 'string' },
        confidence:      { type: 'number' },
        approximateY:    { type: 'number' },
        pageIndex:       { type: 'number' },
        reasoning:       { type: 'string' },
        isAmbiguous:     { type: 'boolean' },
      },
      required: ['normalizedLabel', 'anchorText', 'confidence', 'approximateY', 'pageIndex', 'reasoning', 'isAmbiguous'],
    },
  };

  let raw: GeminiVisionLabel[];
  try {
    raw = await geminiVisionStructuredRequest<GeminiVisionLabel[]>(
      prompt,
      [{ buffer: geminiImage.buffer, mimeType: geminiImage.mimeType }],
      schema
    );
  } catch (err) {
    console.error(`[GeminiVision] Page ${pageImage.pageIndex}: Gemini call failed, falling back to OCR-only for this page:`, err);
    return [];
  }

  // Validate + normalise + remap pageIndex to the actual GLOBAL page index
  const validated = raw
    .filter(r => typeof r.normalizedLabel === 'string')
    .map(r => ({
      normalizedLabel: r.normalizedLabel.toLowerCase().trim(),
      anchorText:      String(r.anchorText ?? '').trim(),
      confidence:      clamp(Number(r.confidence ?? 0), 0, 1),
      approximateY:    clamp(Number(r.approximateY ?? 0.5), 0, 1),
      pageIndex:       pageImage.pageIndex,  // global page index (not the 0 Gemini returned)
      reasoning:       String(r.reasoning ?? ''),
      isAmbiguous:     Boolean(r.isAmbiguous),
    }));

  console.log(`[GeminiVision] Page ${pageImage.pageIndex}: ${validated.length} boundaries detected`);
  validated.forEach(v =>
    console.log(
      `  [y=${v.approximateY.toFixed(2)} conf=${v.confidence.toFixed(2)}${v.isAmbiguous ? ' ?' : ''}]` +
      ` "${v.anchorText}" → "${v.normalizedLabel}" | ${v.reasoning}`
    )
  );

  return validated;
}

// ─── Main export (Fix D: controlled concurrency) ──────────────────────────────

/**
 * Identify answer-start boundaries across all answer-sheet pages using Gemini Vision.
 *
 * Pages are processed in sequential batches of GEMINI_VISION_CONCURRENCY size
 * (default: 1 page at a time). This avoids overwhelming the free-tier RPM limit.
 *
 * If a page call fails (429, network error, etc.) it contributes zero labels for
 * that page — the fusion engine falls back to OCR-only for those pages.
 */
export async function detectLabelsWithGeminiVision(
  pageImages: PageImage[],
  knownQuestionLabels: string[],
  mcqIds: Set<string>
): Promise<GeminiVisionLabel[]> {
  if (pageImages.length === 0) return [];

  // Kill-switch: GEMINI_VISION_CONCURRENCY=0 disables Vision entirely.
  // Use this to preserve API quota when rate-limited.
  if (!GEMINI_VISION_ENABLED) {
    console.log('[GeminiVision] Disabled (GEMINI_VISION_CONCURRENCY=0) — returning OCR-only mode');
    return [];
  }

  console.log(
    `[GeminiVision] Starting: ${pageImages.length} page(s), ` +
    `concurrency=${GEMINI_VISION_CONCURRENCY}, maxWidth=${GEMINI_IMAGE_MAX_WIDTH}px`
  );


  const allLabels: GeminiVisionLabel[] = [];
  const concurrency = GEMINI_VISION_CONCURRENCY;

  for (let i = 0; i < pageImages.length; i += concurrency) {
    const batch = pageImages.slice(i, i + concurrency);
    const batchStart = i;

    console.log(
      `[GeminiVision] Batch ${Math.floor(i / concurrency) + 1}` +
      `/${Math.ceil(pageImages.length / concurrency)}: pages ${batchStart}–${batchStart + batch.length - 1}`
    );

    // Run this batch's pages in parallel
    const batchResults = await Promise.all(
      batch.map(pi => detectLabelsOnPage(pi, knownQuestionLabels, mcqIds))
    );

    for (const pageLabels of batchResults) {
      allLabels.push(...pageLabels);
    }

    // Small pause between batches to reduce rate-limit pressure (fix D)
    const isLastBatch = i + concurrency >= pageImages.length;
    if (!isLastBatch) {
      await new Promise(r => setTimeout(r, INTER_BATCH_DELAY_MS));
    }
  }

  console.log(`[GeminiVision] Complete: ${allLabels.length} total boundaries across ${pageImages.length} pages`);
  return allLabels;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
