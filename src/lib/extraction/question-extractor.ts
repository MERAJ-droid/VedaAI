import type { ProcessedPage, Question, MCQOption } from '@/lib/types';
import { detectLabels } from '@/lib/extraction/label-detector';
import { geminiStructuredRequest } from '@/lib/gemini';
import { v4 as uuidv4 } from 'uuid';

interface SpatialContextPage {
  pageIndex: number;
  lines: Array<{
    lineIndex: number;
    text: string;
    normalizedY: number;
    normalizedBbox: { x: number; y: number; width: number; height: number };
  }>;
}

interface GeminiOption {
  label: string;  // 'A', 'B', 'C', 'D'
  text: string;
}

interface GeminiQuestion {
  id: string;
  number: string;
  text: string;
  type: 'mcq' | 'subjective' | 'short_answer';
  options: GeminiOption[] | null;
  marks: number | null;
  parentNumber: string | null;
  pageIndex: number;
  lineIndex: number;
}

// ─── Regex: a line that starts with an uppercase MCQ option label ─────────────
const UPPERCASE_MCQ_LABEL = /^\s*\([A-D]\)/;

// A single line containing 2+ uppercase MCQ labels → horizontal layout
const HORIZONTAL_MCQ_LABELS = /\([A-D]\).*\([A-D]\)/;

/**
 * Builds the spatial context payload for Gemini.
 */
function buildSpatialContext(pages: ProcessedPage[]): SpatialContextPage[] {
  return pages.map((page, pageIndex) => ({
    pageIndex,
    lines: page.lines.map((line, lineIndex) => ({
      lineIndex,
      text: line.text,
      normalizedY: line.normalized.y,
      normalizedBbox: {
        x: line.normalized.x,
        y: line.normalized.y,
        width: line.normalized.width,
        height: line.normalized.height,
      },
    })),
  }));
}

/**
 * Converts the spatial context into a compact plain-text format for the Gemini prompt.
 *
 * Format per line:  "L<lineIndex> y=<verticalPos>  <text>"
 *
 * This is ~70% smaller than JSON.stringify(pages, null, 2) because it omits
 * verbose field names (normalizedBbox, normalizedY, etc.) and JSON punctuation.
 * Gemini only needs lineIndex (for returning positions) and text (for analysis).
 */
function buildPromptLines(pages: SpatialContextPage[]): string {
  return pages
    .map(page => {
      const lineRows = page.lines
        .filter(l => l.text.trim().length > 0)
        .map(l => `L${l.lineIndex} y=${l.normalizedY.toFixed(2)}  ${l.text.substring(0, 250)}`);
      return `--- Page ${page.pageIndex} (${lineRows.length} lines) ---\n${lineRows.join('\n')}`;
    })
    .join('\n\n');
}

/**
 * Calls Gemini to extract questions from the question paper OCR data.
 */
async function extractQuestionsWithGemini(pages: SpatialContextPage[]): Promise<GeminiQuestion[]> {

  const prompt = `You are analyzing a scanned question paper. Extract all questions as structured objects.

━━━ QUESTION TYPES ━━━

▸ "mcq" — Multiple Choice Question
  Signals (use ALL or MOST):
  • Followed by exactly 4 options labeled with UPPERCASE letters: (A) (B) (C) (D)
  • Options may be vertical (one per line) OR horizontal: "(A) Python  (B) HTML  (C) CSS  (D) JPEG"
  • All 4 options appear spatially grouped immediately below the question stem
  • Options have parallel structure and uniform short text (word to short phrase)
  • Options share the same indentation / column alignment
  • MCQ questions typically carry 1–2 marks

  For MCQ:
  • Set type = "mcq"
  • text = question STEM ONLY (do NOT include option text in the stem)
  • options = [{label:"A",text:"..."}, {label:"B",text:"..."}, {label:"C",text:"..."}, {label:"D",text:"..."}]
  • NEVER create separate question entries for (A), (B), (C), (D) options

▸ "subjective" — Long or short written answer
  • Student writes their own response
  • May have genuine sub-questions labeled with LOWERCASE letters (a), (b), (c) or
    Roman numerals (i), (ii), (iii)
  • Each genuine sub-question gets its OWN question entry with parentNumber set

▸ "short_answer" — One or two sentence written response

━━━ KEY DISTINCTION ━━━

  MCQ options  → UPPERCASE (A) (B) (C) (D) → bundle ALL under ONE question, set type="mcq"
  Sub-questions → LOWERCASE (a) (b) (c) or Roman (i) (ii) (iii) → separate entries, parentNumber set

━━━ PARENT CONTAINER RULE ━━━

A numbered item (e.g. "1.") may appear as a SECTION HEADER with no question stem of its own,
immediately followed by sub-items (i), (ii), (iii), (iv), (v) — each being an actual question.

In this case:
• The parent number IS part of the question identity — do NOT ignore it.
• Each sub-item is a genuine sub-question; set parentNumber = the parent number (e.g. "1").
• Build the id as parent + sub-label (LOWERCASE): e.g., "1" + "i" = "1i", "1" + "ii" = "1ii".
• Do NOT assign sub-items top-level sequential ids like "1", "2", "3" — that discards the parent.
• If each sub-item has its own (A)(B)(C)(D) options, set type = "mcq" for EACH sub-item.

Example (CORRECT):
  Paper shows:
    1.
      (i)  What is chlorophyll?  (A) pigment (B) molecule (C) enzyme (D) cell
      (ii) What is osmosis?      (A) diffusion (B) filtration (C) absorption (D) digestion

  Correct output:
    { id:"1i",  number:"1(i)",  text:"What is chlorophyll?", type:"mcq", parentNumber:"1", options:[...] }
    { id:"1ii", number:"1(ii)", text:"What is osmosis?",     type:"mcq", parentNumber:"1", options:[...] }

Example (WRONG — do not do this):
    { id:"1", number:"(i)",  text:"What is chlorophyll?", type:"mcq" }   ← wrong id, missing parent
    { id:"2", number:"(ii)", text:"What is osmosis?",     type:"mcq" }   ← wrong sequential id

━━━ ID FORMAT RULES ━━━

• Top-level questions: id = the printed number, e.g. "1", "2", "3"
• Sub-questions of top-level "N": id = N + sub-label (lowercase), e.g. "3a", "3b", "1i", "1ii"
• NEVER use just the sub-label alone (e.g., "i", "ii", "a") — always prepend the parent number.

━━━ FIELDS ━━━

For each question return:
- id: constructed per ID FORMAT RULES above (e.g. "1", "2", "3a", "1i", "1ii")
- number: label exactly as printed, e.g. "1.", "2(a)", "Q.3", "1(i)"
- text: question stem text (for MCQ: stem only, no option text)
- type: "mcq" | "subjective" | "short_answer"
- options: array of {label, text} for MCQ; null for other types
- marks: numeric marks if explicitly printed near this question's label, else null
- parentNumber: parent question id for genuine lowercase/Roman sub-questions; null otherwise
- pageIndex: 0-based page index where the question label appears
- lineIndex: line index where the question label appears

━━━ CRITICAL RULES ━━━

1. (A)(B)(C)(D) uppercase → ALWAYS part of MCQ options, NEVER sub-questions.
2. (a)(b)(c) lowercase → ALWAYS genuine sub-questions (if labeled separately in the paper).
3. If options appear horizontally on the same line(s), still treat the whole block as ONE MCQ.
4. When uncertain whether a lettered item is an MCQ option or sub-question:
   → uppercase = MCQ option → include in options[], do not split
   → lowercase = sub-question → create separate entry with parentNumber
5. Ignore headers, instructions, school name, exam title, dates, and metadata.
6. Do NOT generate coordinates — only use pageIndex and lineIndex to reference existing data.
7. When a numbered item like "1." introduces sub-items (i)(ii)(iii) with no stem of its own,
   apply the PARENT CONTAINER RULE: sub-item ids = "1i", "1ii", "1iii" with parentNumber = "1".

Question paper OCR lines (format: "L<lineIndex> y=<verticalPosition>  <text>"):
${buildPromptLines(pages)}

Return a JSON array of question objects.`;


  const schema = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id:           { type: 'string' },
        number:       { type: 'string' },
        text:         { type: 'string' },
        type:         { type: 'string', enum: ['mcq', 'subjective', 'short_answer'] },
        options: {
          type: 'array',
          nullable: true,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              text:  { type: 'string' },
            },
            required: ['label', 'text'],
          },
        },
        marks:        { type: 'number', nullable: true },
        parentNumber: { type: 'string', nullable: true },
        pageIndex:    { type: 'number' },
        lineIndex:    { type: 'number' },
      },
      required: ['id', 'number', 'text', 'type', 'pageIndex', 'lineIndex'],
    },
  };

  return geminiStructuredRequest<GeminiQuestion[]>(prompt, schema);
}

// ─── Structure-aware MCQ post-processing (Fix 3) ──────────────────────────────
/**
 * Detects cases where Gemini incorrectly split MCQ options into sub-questions
 * and corrects them by converting the parent to type="mcq" with options[].
 *
 * Uses structural signals from the raw OCR data:
 *   - Uppercase (A)/(B)/(C)/(D) at the start of the OCR line for each sub-question
 *   - Horizontal layout: a single line containing multiple uppercase labels
 *   - Spatial grouping: sub-questions within a tight vertical band below the stem
 *   - Consistent indentation: sub-questions aligned to a similar x-column
 *
 * Does NOT use "4 short sub-parts = MCQ" — that incorrectly merges genuine sub-questions.
 */
function detectAndFixMCQSplits(
  questions: GeminiQuestion[],
  pages: ProcessedPage[]
): GeminiQuestion[] {
  // Group sub-questions by parentNumber
  const subsByParent = new Map<string, GeminiQuestion[]>();
  for (const q of questions) {
    if (!q.parentNumber) continue;
    if (!subsByParent.has(q.parentNumber)) subsByParent.set(q.parentNumber, []);
    subsByParent.get(q.parentNumber)!.push(q);
  }

  const toRemoveIds = new Set<string>();
  const corrected = [...questions];

  for (const [parentId, subs] of subsByParent.entries()) {
    // Signal 1: How many subs have an uppercase MCQ label at their OCR line start?
    const uppercaseCount = subs.filter(sq => {
      const page = pages[sq.pageIndex];
      const line = page?.lines[sq.lineIndex];
      return line ? UPPERCASE_MCQ_LABEL.test(line.text) : false;
    }).length;

    // Signal 2: Horizontal layout — any sub's OCR line contains 2+ uppercase labels on one line
    const hasHorizontalLayout = subs.some(sq => {
      const page = pages[sq.pageIndex];
      const line = page?.lines[sq.lineIndex];
      return line ? HORIZONTAL_MCQ_LABELS.test(line.text) : false;
    });

    // Signal 3: Spatial grouping — all subs within a compact vertical band
    const yPositions = subs
      .map(sq => pages[sq.pageIndex]?.lines[sq.lineIndex]?.normalized.y)
      .filter((y): y is number => y !== undefined);
    const ySpan = yPositions.length >= 2
      ? Math.max(...yPositions) - Math.min(...yPositions)
      : 1;
    const isSpatiallyGrouped = ySpan < 0.30; // all options within 30% of page height

    // Signal 4: Consistent indentation — subs share a similar left x-column
    const xPositions = subs
      .map(sq => pages[sq.pageIndex]?.lines[sq.lineIndex]?.normalized.x)
      .filter((x): x is number => x !== undefined);
    const xVariation = xPositions.length >= 2
      ? Math.max(...xPositions) - Math.min(...xPositions)
      : 1;
    const hasConsistentIndent = xVariation < 0.25;

    // Decision: uppercase origin is the PRIMARY signal.
    // Spatial signals add confidence but uppercase alone is sufficient.
    const allUppercase = uppercaseCount === subs.length && subs.length >= 2;
    const someUppercaseWithSpatial =
      uppercaseCount >= 2 && isSpatiallyGrouped && hasConsistentIndent;

    const isMCQSplit = allUppercase || hasHorizontalLayout || someUppercaseWithSpatial;

    if (!isMCQSplit) continue;

    // Find and update the parent question
    const parentIdx = corrected.findIndex(q => q.id === parentId);
    if (parentIdx === -1) continue;

    const options: GeminiOption[] = subs.map(sq => {
      // Derive option label: strip parentId prefix, uppercase the remaining letter
      const suffix = sq.id.replace(parentId, '').toUpperCase() || sq.number.replace(/\d+/g, '').toUpperCase();
      // Alternatively, extract from the raw OCR line
      const page = pages[sq.pageIndex];
      const line = page?.lines[sq.lineIndex];
      const rawMatch = line?.text.match(/^\s*\(([A-D])\)/);
      const label = rawMatch ? rawMatch[1] : suffix.replace(/[^A-D]/g, '') || '?';
      return { label, text: sq.text };
    });

    // Sort options A→B→C→D
    options.sort((a, b) => a.label.localeCompare(b.label));

    corrected[parentIdx] = {
      ...corrected[parentIdx],
      type: 'mcq',
      options,
    };

    for (const sq of subs) toRemoveIds.add(sq.id);
    console.log(
      `[extractQuestions] MCQ-split detected for Q${parentId}: ` +
      `merged ${subs.length} sub-entries into options[] ` +
      `(uppercase=${uppercaseCount}, horizontal=${hasHorizontalLayout}, ` +
      `ySpan=${ySpan.toFixed(3)}, xVar=${xVariation.toFixed(3)})`
    );
  }

  return corrected.filter(q => !toRemoveIds.has(q.id));
}

// ─── Fix A: Sub-question parent inference ─────────────────────────────────────

/**
 * Matches question `number` fields that are PURE sub-question labels with no
 * parent prefix — e.g. "(i)", "(ii)", "(a)", "(b)" — as printed in the paper.
 * These indicate Gemini failed to associate the item with its parent number.
 */
const BARE_SUB_LABEL = /^\(\s*([a-z]|[ivxlcdm]+)\s*\)$/i;

/**
 * Matches a line that begins with a top-level question number —
 * e.g. "1.", "2.", "Q.1", "Q1." — even if the rest of the line is blank.
 * Captures the number in group 1.
 */
const TOP_LEVEL_NUMBER_LINE = /^(?:Q\.?\s*)?(\d+)\s*[.\):\-]\s*$/i;

/**
 * Deterministic post-processing that repairs question ids when Gemini assigns
 * sequential top-level ids (1, 2, 3...) to sub-questions that should be
 * labeled 1(i), 1(ii), 1(iii).
 *
 * Strategy per question:
 *  1. If `number` matches BARE_SUB_LABEL (e.g. "(i)", "(ii)"), the question
 *     was printed with only a sub-label — the parent number is implicit.
 *  2. Walk BACKWARD through the same page's OCR lines starting from the
 *     question's lineIndex.
 *  3. The first line that matches TOP_LEVEL_NUMBER_LINE is the parent.
 *  4. Rewrite: id = parentNum + subLabel, number = "parentNum(subLabel)",
 *     parentNumber = parentNum.
 *
 * A search limit of MAX_LOOKBACK_LINES prevents false-positive matches far
 * away on the same page.
 */
const MAX_LOOKBACK_LINES = 30;

function fixSubquestionIds(
  questions: GeminiQuestion[],
  spatialPages: SpatialContextPage[]
): GeminiQuestion[] {
  return questions.map(gq => {
    const numTrimmed = (gq.number ?? '').trim();
    const subMatch = numTrimmed.match(BARE_SUB_LABEL);

    // Only process questions whose printed number is a bare sub-label like "(i)"
    if (!subMatch) return gq;

    // If parentNumber is already correctly set AND id already has the parent prefix, skip
    const subLabel = subMatch[1].toLowerCase();
    if (
      gq.parentNumber &&
      gq.id.toLowerCase().startsWith(gq.parentNumber.toLowerCase()) &&
      gq.id.toLowerCase() !== gq.parentNumber.toLowerCase()
    ) {
      return gq;
    }

    const page = spatialPages[gq.pageIndex];
    if (!page) return gq;

    // Walk backward in OCR lines looking for the parent number line
    const startLine = Math.max(0, gq.lineIndex - 1);
    const stopLine  = Math.max(0, gq.lineIndex - MAX_LOOKBACK_LINES);

    for (let li = startLine; li >= stopLine; li--) {
      const line = page.lines[li];
      if (!line) continue;

      const lineText = line.text.trim();
      if (!lineText) continue;

      const parentMatch = lineText.match(TOP_LEVEL_NUMBER_LINE);
      if (parentMatch) {
        const parentNum = parentMatch[1];
        const correctedId     = parentNum + subLabel;
        const correctedNumber = `${parentNum}(${subLabel})`;

        console.log(
          `[fixSubquestionIds] "${gq.number}" (id="${gq.id}") → ` +
          `id="${correctedId}", number="${correctedNumber}", parentNumber="${parentNum}" ` +
          `(parent found at line ${li}: "${lineText}")`
        );

        return { ...gq, id: correctedId, number: correctedNumber, parentNumber: parentNum };
      }

      // If we hit another sub-label line (a sibling), continue searching above it
      // — the parent is further up, not between siblings.
    }

    // No parent found — return unchanged (will remain as-is)
    return gq;
  });
}



// ─── Build Question objects ───────────────────────────────────────────────────
function buildQuestionObjects(geminiQuestions: GeminiQuestion[], pages: ProcessedPage[]): Question[] {
  const questions: Question[] = geminiQuestions.map(gq => {
    let verticalPosition = 0;
    const page = pages[gq.pageIndex];
    if (page && page.lines[gq.lineIndex]) {
      verticalPosition = page.lines[gq.lineIndex].normalized.y;
    }

    let id = gq.id && /^[a-zA-Z0-9_-]+$/.test(gq.id) ? gq.id : uuidv4();

    // Fix A: Sub-question id normalization (safety net).
    // If Gemini returned id="i" + parentNumber="1" instead of id="1i",
    // auto-correct to "1i" so it matches what the answer segmenter expects.
    // This fires when the id does NOT already start with the parent prefix.
    if (gq.parentNumber) {
      const parentNorm = gq.parentNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
      const rawIdNorm  = id.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (parentNorm && !rawIdNorm.startsWith(parentNorm)) {
        const corrected = parentNorm + rawIdNorm;
        console.log(`[extractQuestions] Sub-question id corrected: "${id}" → "${corrected}" (parent="${gq.parentNumber}")`);
        id = corrected;
      }
    }

    // Fix B: Sub-question number normalization.
    // Derive the display number from the corrected id when parentNumber exists.
    // Gemini sometimes produces number="(i)" for all sub-questions or omits the
    // parent prefix. The id field (e.g. "1ii") is correct, so extract the sub-part
    // from it and build a proper display number like "1(ii)".
    let number = gq.number;
    if (gq.parentNumber) {
      const parentNorm = gq.parentNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
      const idNorm = id.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (idNorm.startsWith(parentNorm) && idNorm.length > parentNorm.length) {
        const subPart = idNorm.slice(parentNorm.length);
        const correctedNumber = `${parentNorm}(${subPart})`;
        if (number !== correctedNumber) {
          console.log(`[extractQuestions] Sub-question number corrected: "${number}" → "${correctedNumber}" (derived from id="${id}")`);
          number = correctedNumber;
        }
      }
    }

    // Normalize options: ensure labels are uppercase and deduplicated
    const options: MCQOption[] | undefined =
      gq.type === 'mcq' && Array.isArray(gq.options) && gq.options.length > 0
        ? gq.options.map(o => ({ label: o.label.toUpperCase().trim(), text: o.text.trim() }))
        : undefined;

    return {
      id,
      number,
      text: gq.text,
      type: gq.type ?? undefined,
      options,
      marks: gq.marks ?? undefined,
      parentNumber: gq.parentNumber ?? undefined,
      pageIndex: gq.pageIndex,
      verticalPosition,
    };

  });

  // Sort: page first, then vertical position
  questions.sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    return a.verticalPosition - b.verticalPosition;
  });

  return questions;
}

// ─── Main export ──────────────────────────────────────────────────────────────
/**
 * Extracts structured questions from a question paper using OCR output and Gemini.
 */
export async function extractQuestions(pages: ProcessedPage[]): Promise<Question[]> {
  // Detect labels (for logging / future use)
  for (const page of pages) {
    detectLabels(page.lines, page.pageIndex);
  }

  const spatialContext = buildSpatialContext(pages);
  let geminiQuestions = await extractQuestionsWithGemini(spatialContext);

  // ── Debug: raw Gemini output ──────────────────────────────────────────────
  console.log(`[extractQuestions] Raw Gemini output: ${geminiQuestions.length} items`);
  for (const gq of geminiQuestions) {
    console.log(
      `  [raw] id="${gq.id}" number="${gq.number}" type=${gq.type} ` +
      `parent=${gq.parentNumber ?? '(none)'} options=${gq.options?.length ?? 0}`
    );
  }

  // Fix A (step 1): Deterministically repair sub-question ids by searching
  // backward in OCR for the parent number line. Runs before MCQ-split detection
  // so corrected ids ("1i","1ii") are visible to that pass.
  geminiQuestions = fixSubquestionIds(geminiQuestions, spatialContext);

  // Fix A (step 2): Structure-aware post-processing to merge any MCQ options
  // that Gemini split into sub-entries (distinct from genuine sub-questions).
  geminiQuestions = detectAndFixMCQSplits(geminiQuestions, pages);


  const questions = buildQuestionObjects(geminiQuestions, pages);

  // ── Debug: final question schema ──────────────────────────────────────────
  console.log(`[extractQuestions] Final question schema:`);
  for (const q of questions) {
    console.log(
      `  [final] id="${q.id}" number="${q.number}" type=${q.type ?? 'undefined'} ` +
      `parent=${q.parentNumber ?? '(none)'} options=${q.options?.length ?? 0}`
    );
  }

  // Log MCQ vs subjective breakdown
  const mcqCount = questions.filter(q => q.type === 'mcq').length;
  const subjectiveCount = questions.filter(q => q.type !== 'mcq').length;
  console.log(
    `[extractQuestions] ${questions.length} questions total: ` +
    `${mcqCount} MCQ, ${subjectiveCount} subjective/short_answer`
  );

  return questions;
}
