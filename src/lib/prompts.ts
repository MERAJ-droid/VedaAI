/**
 * Prompts for Gemini API calls throughout the pipeline.
 * All prompts explicitly instruct Gemini NOT to generate spatial coordinates.
 */

/**
 * Build the question extraction prompt with spatial context.
 */
export function buildQuestionExtractionPrompt(
  pagesJson: string
): string {
  return `You are analyzing a scanned question paper. Extract all questions with their sub-parts.

For each question or sub-question, return:
- id: unique identifier using only alphanumeric chars e.g. "1", "2a", "2b", "11", "11a", "11b"
- number: the original label as printed e.g. "1.", "2 (a)", "11 (b)"  
- text: the full question text (just the question body, not the label)
- marks: number of marks if specified (look for patterns like "(5 marks)", "[3]"), or null
- parentNumber: for sub-questions like "11a", the parent is "11"; null for top-level questions
- pageIndex: which page (0-based) this question appears on
- lineIndex: the OCR line index (from the provided data) where this question's NUMBER/LABEL appears

IMPORTANT RULES:
- Sub-parts like "2(a)" and "2(b)" MUST be returned as SEPARATE questions
- Include the full question text even if it spans multiple lines
- Do NOT generate, modify, or infer any spatial coordinates
- Only use pageIndex and lineIndex to reference positions that already exist in the data
- If a question spans multiple lines, use the lineIndex of the line containing the question label/number
- Ignore headers, instructions, and school/exam metadata

Question paper OCR data (pages with line text and positions):
${pagesJson}

Return a JSON array of question objects.`;
}

/**
 * Build the answer disambiguation prompt for genuinely ambiguous segmentation cases.
 */
export function buildAnswerDisambiguationPrompt(
  ambiguousRegionsJson: string,
  precedingAnswerLabel: string | null
): string {
  return `You are analyzing handwritten student answer regions from an exam answer sheet.

The following content regions are ambiguous — it's unclear whether they:
1. Continue from the previous answer (label: ${precedingAnswerLabel || 'unknown'})
2. Start a new answer

For each ambiguous region, decide: "continuation" or "new_answer".

Factors to consider:
- Semantic continuity with the previous answer topic
- Whether the content seems to be mid-sentence/mid-thought
- Whether there's a clear topic shift
- Whether a new question label appears in the text

IMPORTANT: Do NOT generate any spatial coordinates or bounding boxes. Only classify each region.

Ambiguous regions:
${ambiguousRegionsJson}

Return a JSON array where each element has:
- regionId: the region ID from the input
- decision: "continuation" or "new_answer"  
- confidence: 0.0-1.0
- reasoning: brief explanation`;
}

/**
 * Build the semantic mapping prompt for unmatched answers.
 */
export function buildSemanticMappingPrompt(
  questionsJson: string,
  unmatchedAnswersJson: string
): string {
  return `You are a teacher's assistant helping match student handwritten answers to exam questions.

The following answers could not be automatically matched to questions by their labels.
Using semantic understanding of the content, suggest the best question match for each answer.

IMPORTANT: 
- Do NOT generate spatial coordinates
- Base decisions ONLY on text content and semantic meaning
- An answer may genuinely not match any question (label it "no_match")

Questions:
${questionsJson}

Unmatched answers (with extracted text):
${unmatchedAnswersJson}

For each answer, return:
- answerId: the answer ID from the input
- questionId: the best matching question ID, or "no_match" if none fits
- confidence: 0.0-1.0 (be conservative; prefer "no_match" over low-confidence guesses)
- reasoning: brief explanation

Return a JSON array.`;
}

/**
 * Build the grading prompt for a single question+answer pair.
 * (Kept for backward compatibility — prefer buildBatchGradingPrompt for new code.)
 */
export function buildGradingPrompt(
  questionText: string,
  questionMarks: number | null,
  answerText: string
): string {
  const marksClause = questionMarks
    ? `The question is worth ${questionMarks} marks.`
    : 'The maximum marks are not specified.';

  return `You are grading a student's handwritten exam answer. Be fair but rigorous.

Question: ${questionText}
${marksClause}

Student's answer:
${answerText}

Evaluate the answer and return:
- score: numeric score awarded (proportional to marks if specified, otherwise out of 10)
- maxScore: maximum possible score
- status: "correct" | "partial" | "incorrect" | "unanswered"
- feedback: constructive feedback for the student (2-4 sentences)

Return a single JSON object.`;
}

/**
 * Build a grading prompt for ALL question+answer pairs in ONE Gemini call.
 *
 * This replaces per-question grading calls (N calls) with a single batch call,
 * dramatically reducing API usage on the free tier.
 */
export function buildBatchGradingPrompt(
  pairs: Array<{
    questionId: string;
    questionNumber: string;
    questionText: string;
    answerText: string;
    marks: number | null;
  }>
): string {
  const pairsText = pairs.map((p, i) => {
    const marksStr = p.marks ? ` [${p.marks} marks]` : '';
    const answerStr = p.answerText?.trim()
      ? p.answerText.trim()
      : '(blank — student did not write an answer)';
    return (
      `--- Question ${i + 1} ` +
      `(questionId="${p.questionId}", number="${p.questionNumber}")${marksStr} ---\n` +
      `Question: ${p.questionText}\n` +
      `Answer: ${answerStr}`
    );
  }).join('\n\n');

  return `You are grading a student's handwritten exam answers. Grade EACH question-answer pair independently. Be fair but rigorous.

${pairsText}

For EVERY question listed above, return one JSON object with:
- questionId: exactly as shown in the header (e.g. "1", "2a", "1i")
- score: numeric score awarded (proportional to the marks value, or out of 10 if no marks given)
- maxScore: maximum possible score (use the marks value, or 10 if not specified)
- status: "correct" | "partial" | "incorrect" | "unanswered"
- feedback: 1-3 sentences of constructive feedback

Return a JSON array — one object per question, in the same order.`;
}
