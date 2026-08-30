import type { Question, Answer, AnswerMapping, UnmatchedAnswer, MappingReason } from '@/lib/types';
import { DEFAULT_CONFIDENCE_THRESHOLDS, getConfidenceLevel } from '@/lib/types';
import { labelSimilarity } from './confidence';
import { geminiStructuredRequest } from '@/lib/gemini';

function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, '').toLowerCase().replace(/[^\w]/g, '');
}

export async function mapAnswersToQuestions(
  questions: Question[],
  answers: Answer[]
): Promise<{ mappings: AnswerMapping[]; unmatchedAnswers: UnmatchedAnswer[]; unansweredQuestions: Question[] }> {
  const mappings: AnswerMapping[] = [];
  const unmatchedAnswers: UnmatchedAnswer[] = [];
  const unansweredQuestions: Question[] = [];

  let remainingAnswers = [...answers];
  let remainingQuestions = [...questions];

  // Round 1 — Exact label match (confidence 0.95)
  // Compare answer's studentLabel against BOTH question.number and question.id.
  // The id is the normalized identifier (e.g. "1ii"), number is the display text (e.g. "(ii)").
  // The answer's studentLabel includes the parent prefix (e.g. "1 (ii)" → normalized "1ii"),
  // so matching against id catches cases where number is missing the prefix.
  console.log(`[mapping] Round 1 — Exact label match`);
  const afterRound1Answers: Answer[] = [];
  for (const answer of remainingAnswers) {
    let matched = false;
    if (answer.studentLabel) {
      const normAnswerLabel = normalizeLabel(answer.studentLabel);
      for (let i = 0; i < remainingQuestions.length; i++) {
        const question = remainingQuestions[i];
        const normQNumber = normalizeLabel(question.number);
        const normQId = normalizeLabel(question.id);
        if (normQNumber === normAnswerLabel || normQId === normAnswerLabel) {
          const matchedVia = normQNumber === normAnswerLabel ? 'number' : 'id';
          console.log(`[mapping] MATCH (via ${matchedVia}): answer "${answer.studentLabel}" (norm="${normAnswerLabel}") → Q id="${question.id}" number="${question.number}"`);
          mappings.push({
            questionId: question.id,
            answerId: answer.id,
            confidence: 0.95,
            confidenceLevel: getConfidenceLevel(0.95),
            reasons: ['exact_label']
          });
          remainingQuestions.splice(i, 1);
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Bare-parent fallback: if answer label is a bare number (e.g. "5")
        // and there's no standalone question "5" but there ARE sub-questions
        // under parent "5" (e.g. "5i", "5ii"), map to the first unmatched one.
        const isBarNumber = /^\d+$/.test(normAnswerLabel);
        if (isBarNumber) {
          const childIdx = remainingQuestions.findIndex(q => {
            const normId = normalizeLabel(q.id);
            return normId.startsWith(normAnswerLabel) && normId !== normAnswerLabel;
          });
          if (childIdx !== -1) {
            const question = remainingQuestions[childIdx];
            console.log(`[mapping] MATCH (bare parent→child): answer "${answer.studentLabel}" (norm="${normAnswerLabel}") → Q id="${question.id}" number="${question.number}"`);
            mappings.push({
              questionId: question.id,
              answerId: answer.id,
              confidence: 0.85,
              confidenceLevel: getConfidenceLevel(0.85),
              reasons: ['parent_to_child']
            });
            remainingQuestions.splice(childIdx, 1);
            matched = true;
          }
        }
        if (!matched) {
          console.log(`[mapping] NO MATCH: answer "${answer.studentLabel}" (norm="${normalizeLabel(answer.studentLabel)}") — checked against: ${remainingQuestions.map(q => `id="${q.id}"(norm="${normalizeLabel(q.id)}") number="${q.number}"(norm="${normalizeLabel(q.number)}")`).join(', ')}`);
        }
      }
    }
    if (!matched) {
      afterRound1Answers.push(answer);
    }
  }
  remainingAnswers = afterRound1Answers;

  // Round 2 — Fuzzy label match (confidence 0.80–0.94)
  console.log(`[mapping] Round 2 — Fuzzy label match (${remainingAnswers.length} answers, ${remainingQuestions.length} questions remaining)`);
  const afterRound2Answers: Answer[] = [];
  for (const answer of remainingAnswers) {
    let matched = false;
    if (answer.studentLabel) {
      const normAnswerLabel = normalizeLabel(answer.studentLabel);
      let bestSim = -1;
      let bestQIndex = -1;

      for (let i = 0; i < remainingQuestions.length; i++) {
        const simByNumber = labelSimilarity(normAnswerLabel, normalizeLabel(remainingQuestions[i].number));
        const simById = labelSimilarity(normAnswerLabel, normalizeLabel(remainingQuestions[i].id));
        const sim = Math.max(simByNumber, simById);
        if (sim > bestSim) {
          bestSim = sim;
          bestQIndex = i;
        }
      }

      if (bestSim >= 0.7 && bestQIndex !== -1) {
        const question = remainingQuestions[bestQIndex];
        const confidence = 0.7 + bestSim * 0.2;
        console.log(`[mapping] FUZZY MATCH: answer "${answer.studentLabel}" (norm="${normAnswerLabel}") → Q id="${question.id}" sim=${bestSim.toFixed(2)}`);
        mappings.push({
          questionId: question.id,
          answerId: answer.id,
          confidence,
          confidenceLevel: getConfidenceLevel(confidence),
          reasons: ['fuzzy_label']
        });
        remainingQuestions.splice(bestQIndex, 1);
        matched = true;
      }
    }
    if (!matched) {
      afterRound2Answers.push(answer);
    }
  }
  remainingAnswers = afterRound2Answers;

  // Round 3 — Contextual ordering (confidence 0.55)
  // Only applies when ALL remaining answers are unlabeled (no studentLabel).
  // If any answer has a label that didn't match above, it means it's a genuine
  // label for a question that doesn't exist in the paper → leave it unmatched.
  const afterRound3Answers: Answer[] = [];
  const noLabelAnswers = remainingAnswers.filter(a => !a.studentLabel);
  const withLabelAnswers = remainingAnswers.filter(a => !!a.studentLabel);

  // Only do positional matching when:
  // 1. All remaining answers are unlabeled (none had a student-written label)
  // 2. Count matches exactly (prevents spurious 1-to-1 forced assignments)
  if (
    noLabelAnswers.length > 0 &&
    withLabelAnswers.length === 0 &&      // no labeled answers still floating
    noLabelAnswers.length === remainingQuestions.length
  ) {
    // Sort unlabeled answers by spatial position (pageIndex, then y)
    noLabelAnswers.sort((a, b) => {
      const aRegion = a.regions?.[0];
      const bRegion = b.regions?.[0];
      if (!aRegion || !bRegion) return 0;
      if (aRegion.pageIndex !== bRegion.pageIndex) return aRegion.pageIndex - bRegion.pageIndex;
      return aRegion.normalized.y - bRegion.normalized.y;
    });

    for (let i = 0; i < noLabelAnswers.length; i++) {
      const answer = noLabelAnswers[i];
      const question = remainingQuestions[i];
      mappings.push({
        questionId: question.id,
        answerId: answer.id,
        confidence: 0.55,
        confidenceLevel: getConfidenceLevel(0.55),
        reasons: ['contextual_match']
      });
    }
    remainingQuestions = [];
    remainingAnswers = [...withLabelAnswers];
  } else {
    remainingAnswers = [...noLabelAnswers, ...withLabelAnswers];
  }


  // Round 4 — Gemini semantic mapping
  if (remainingAnswers.length > 0 && remainingQuestions.length > 0) {
    const prompt = `Match these answers to questions.
Questions: ${JSON.stringify(remainingQuestions.map(q => ({ id: q.id, number: q.number, text: q.text })))}
Answers: ${JSON.stringify(remainingAnswers.map(a => ({ id: a.id, studentLabel: a.studentLabel, text: a.text })))}
Respond with a JSON array of mappings: { answerId, questionId, confidence, reason }`;

    try {
      // Mocked request to geminiStructuredRequest
      // const geminiMappings = await geminiStructuredRequest<any>(prompt, 'AnswerMappingsSchema');
      // For now we skip actual parsing as this handles logic flow.
    } catch (e) {
      console.error(e);
    }
  }

  // Fallback for remaining
  for (const answer of remainingAnswers) {
    unmatchedAnswers.push({
      answer: answer,
      candidateQuestionId: remainingQuestions.length > 0 ? remainingQuestions[0].id : undefined,
      candidateConfidence: 0.5,
      candidateReason: 'llm_reasoning'
    });
  }

  for (const question of remainingQuestions) {
    unansweredQuestions.push(question);
  }

  return { mappings, unmatchedAnswers, unansweredQuestions };
}
