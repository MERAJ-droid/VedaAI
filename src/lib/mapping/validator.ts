import type { Question, Answer, AnswerMapping, UnmatchedAnswer } from '@/lib/types';

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export function validateMappings(result: {
  questions: Question[];
  answers: Answer[];
  mappings: AnswerMapping[];
  unmatchedAnswers: UnmatchedAnswer[];
  unansweredQuestions: Question[];
}): ValidationResult {
  const { questions, answers, mappings, unmatchedAnswers, unansweredQuestions } = result;
  
  const warnings: string[] = [];
  const errors: string[] = [];
  
  const questionIds = new Set(questions.map(q => q.id));
  const answerIds = new Set(answers.map(a => a.id));
  
  const mappedAnswers = new Set<string>();
  const answerToQuestionCount = new Map<string, number>();

  for (const mapping of mappings) {
    // 1. All mapping.questionId values exist in questions list
    if (!questionIds.has(mapping.questionId)) {
      errors.push(`Mapping references unknown question ID: ${mapping.questionId}`);
    }
    
    // 2. All mapping.answerId values exist in answers list (if not null)
    if (mapping.answerId && !answerIds.has(mapping.answerId)) {
      errors.push(`Mapping references unknown answer ID: ${mapping.answerId}`);
    }
    
    // 3. No answer is mapped to multiple questions
    if (mapping.answerId) {
      mappedAnswers.add(mapping.answerId);
      const count = answerToQuestionCount.get(mapping.answerId) || 0;
      answerToQuestionCount.set(mapping.answerId, count + 1);
      
      if (count === 1) {
        warnings.push(`Answer ${mapping.answerId} is mapped to multiple questions.`);
      }
    }
  }

  // 4. All answer regions have valid normalized coordinates (x,y,w,h all in [0,1])
  for (const answer of answers) {
    if (answer.regions) {
      for (const region of answer.regions) {
        const { x, y, width, height } = region.normalized;
        if (
          x < 0 || x > 1 ||
          y < 0 || y > 1 ||
          width < 0 || width > 1 ||
          height < 0 || height > 1
        ) {
          errors.push(`Answer ${answer.id} has invalid region coordinates (not normalized).`);
        }
      }
    }
  }

  // 5. Unanswered questions array contains only valid question IDs
  for (const question of unansweredQuestions) {
    if (!questionIds.has(question.id)) {
      errors.push(`Unanswered questions list contains unknown question ID: ${question.id}`);
    }
  }

  // 6. Unmatched answers array contains only valid answer IDs
  for (const unmatched of unmatchedAnswers) {
    if (!answerIds.has(unmatched.answer.id)) {
      errors.push(`Unmatched answers list contains unknown answer ID: ${unmatched.answer.id}`);
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}
