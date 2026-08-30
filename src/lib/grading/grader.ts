import type { Question, Answer, AnswerMapping, GradingResult, OverallSummary } from '@/lib/types';
import { geminiStructuredRequest } from '@/lib/gemini';
import { buildBatchGradingPrompt } from '@/lib/prompts';

/**
 * Grade ALL mapped question+answer pairs in a SINGLE Gemini call.
 *
 * Previous approach: 1 call per question (N calls total) → guaranteed 429 on free tier.
 * New approach: all pairs in one prompt → 1 call total for grading.
 *
 * @param questions - Extracted questions from the question paper
 * @param answers   - Extracted answers from the answer sheet
 * @param mappings  - Answer-to-question mappings
 */
export async function gradeAllAnswers(
  questions: Question[],
  answers: Answer[],
  mappings: AnswerMapping[]
): Promise<GradingResult[]> {

  // ── Build pairs list (answered only) ────────────────────────────────────────
  const pairs: Array<{
    questionId: string;
    questionNumber: string;
    questionText: string;
    answerText: string;
    marks: number | null;
    answerId: string;
  }> = [];

  for (const mapping of mappings) {
    if (!mapping.answerId) continue;
    const question = questions.find(q => q.id === mapping.questionId);
    const answer   = answers.find(a => a.id === mapping.answerId);
    if (!question || !answer) continue;
    pairs.push({
      questionId:     mapping.questionId,
      questionNumber: question.number,
      questionText:   question.text,
      answerText:     answer.text ?? '',
      marks:          question.marks ?? null,
      answerId:       mapping.answerId,
    });
  }

  const results: GradingResult[] = [];

  // ── One batch Gemini call for all answered questions ─────────────────────────
  if (pairs.length > 0) {
    const prompt = buildBatchGradingPrompt(pairs);

    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          questionId: { type: 'string' },
          score:      { type: 'number' },
          maxScore:   { type: 'number' },
          status:     { type: 'string', enum: ['correct', 'partial', 'incorrect', 'unanswered'] },
          feedback:   { type: 'string' },
        },
        required: ['questionId', 'score', 'maxScore', 'status', 'feedback'],
      },
    };

    try {
      const batchResults = await geminiStructuredRequest<Array<{
        questionId: string;
        score: number;
        maxScore: number;
        status: 'correct' | 'partial' | 'incorrect' | 'unanswered';
        feedback: string;
      }>>(prompt, schema);

      console.log(`[grader] Batch grading returned ${batchResults.length} result(s) for ${pairs.length} pair(s)`);

      for (const r of batchResults) {
        const pair = pairs.find(p => p.questionId === r.questionId);
        if (!pair) {
          console.warn(`[grader] Batch result references unknown questionId "${r.questionId}" — skipping`);
          continue;
        }
        results.push({
          questionId: r.questionId,
          answerId:   pair.answerId,
          score:      r.score,
          maxScore:   r.maxScore,
          status:     r.status,
          aiFeedback: r.feedback,
        });
      }

      // Any pairs not covered by the batch response get a fallback entry
      for (const pair of pairs) {
        if (!results.find(r => r.questionId === pair.questionId)) {
          console.warn(`[grader] Batch did not return result for questionId "${pair.questionId}" — using fallback`);
          results.push({
            questionId: pair.questionId,
            answerId:   pair.answerId,
            score:      null,
            maxScore:   pair.marks,
            status:     'incorrect',
            aiFeedback: 'Grading result was not returned for this question.',
          });
        }
      }

    } catch (error) {
      console.error('[grader] Batch grading call failed:', error);
      // Degrade gracefully: mark all answered questions as failed
      for (const pair of pairs) {
        results.push({
          questionId: pair.questionId,
          answerId:   pair.answerId,
          score:      null,
          maxScore:   pair.marks,
          status:     'incorrect',
          aiFeedback: 'Automated grading failed. Please review this answer manually.',
        });
      }
    }
  }

  // ── Unanswered entries (no Gemini call needed) ───────────────────────────────
  for (const mapping of mappings) {
    if (mapping.answerId !== null) continue;
    if (results.find(r => r.questionId === mapping.questionId)) continue;
    const question = questions.find(q => q.id === mapping.questionId);
    results.push({
      questionId: mapping.questionId,
      answerId:   null,
      score:      0,
      maxScore:   question?.marks ?? 10,
      status:     'unanswered',
      aiFeedback: 'This question was not answered.',
    });
  }

  return results;
}

/**
 * Generate an overall summary from grading results.
 *
 * Computes totals locally — NO Gemini call.
 * Saves 1 API call per pipeline run; the feedback template covers all common cases.
 */
export async function generateOverallSummary(
  questions: Question[],
  gradingResults: GradingResult[]
): Promise<OverallSummary> {
  let totalScore      = 0;
  let maxScore        = 0;
  let correctCount    = 0;
  let partialCount    = 0;
  let incorrectCount  = 0;
  let unansweredCount = 0;

  for (const r of gradingResults) {
    totalScore += r.score  ?? 0;
    maxScore   += r.maxScore ?? 0;
    if      (r.status === 'correct')    correctCount++;
    else if (r.status === 'partial')    partialCount++;
    else if (r.status === 'incorrect')  incorrectCount++;
    else if (r.status === 'unanswered') unansweredCount++;
  }

  const total = gradingResults.length;
  const percentage = maxScore > 0
    ? Math.round((totalScore / maxScore) * 1000) / 10
    : 0;

  const unansweredNote = unansweredCount > 0
    ? ` ${unansweredCount} question${unansweredCount > 1 ? 's were' : ' was'} left unanswered.`
    : '';

  let overallFeedback: string;
  if (percentage >= 90) {
    overallFeedback =
      `Outstanding performance! Scored ${totalScore}/${maxScore} (${percentage}%). ` +
      `${correctCount} of ${total} questions answered correctly.${unansweredNote} ` +
      `Excellent understanding of the subject. Keep up the great work!`;
  } else if (percentage >= 75) {
    overallFeedback =
      `Good performance. Scored ${totalScore}/${maxScore} (${percentage}%). ` +
      `Strong understanding shown in most areas.${unansweredNote} ` +
      `Review the ${incorrectCount + partialCount} question(s) where marks were lost to reach distinction level.`;
  } else if (percentage >= 50) {
    overallFeedback =
      `Satisfactory performance. Scored ${totalScore}/${maxScore} (${percentage}%). ` +
      `Basic concepts are understood, but there is room for improvement.${unansweredNote} ` +
      `Focus on the topics where answers were partial or incorrect.`;
  } else if (percentage >= 33) {
    overallFeedback =
      `Below average performance. Scored ${totalScore}/${maxScore} (${percentage}%). ` +
      `Significant revision is needed across several topics.${unansweredNote} ` +
      `Please review core concepts and attempt more practice papers.`;
  } else {
    overallFeedback =
      `Needs improvement. Scored ${totalScore}/${maxScore} (${percentage}%). ` +
      `Extensive revision is required.${unansweredNote} ` +
      `Consider seeking additional support and systematically revising each topic.`;
  }

  return { totalScore, maxScore, percentage, overallFeedback };
}
