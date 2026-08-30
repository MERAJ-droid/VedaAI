import type { Question, Answer, AnswerMapping, GradingResult, UnmatchedAnswer } from '@/lib/types';
import { ConfidenceBadge } from './ConfidenceBadge';

interface Props {
  selectedQuestion: Question | null;
  selectedAnswer: Answer | null;
  selectedMapping: AnswerMapping | null;
  gradingResult: GradingResult | undefined;
  selectedUnmatchedAnswer: UnmatchedAnswer | null;
}

export function AnswerPanel({
  selectedQuestion,
  selectedAnswer,
  selectedMapping,
  gradingResult,
  selectedUnmatchedAnswer,
}: Props) {
  if (!selectedQuestion && !selectedUnmatchedAnswer) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-900 text-slate-500">
        <p>← Select a question from the list</p>
      </div>
    );
  }

  const formatReason = (reason: string) => {
    const reasons: Record<string, string> = {
      exact_label: 'Exact label',
      fuzzy_label: 'Fuzzy label',
      semantic_match: 'Semantic',
      contextual_match: 'Contextual ordering',
      llm_reasoning: 'AI reasoning',
    };
    return reasons[reason] || reason;
  };

  const renderGradingResult = () => {
    if (!gradingResult || !selectedQuestion) return null;
    const score = gradingResult.score ?? 0;
    const maxMarks = selectedQuestion.marks ?? gradingResult.maxScore ?? 10;
    const ratio = maxMarks > 0 ? score / maxMarks : 0;
    let colorClass = 'bg-red-500/20 text-red-400 border-red-500/30';
    if (ratio >= 0.8) colorClass = 'bg-green-500/20 text-green-400 border-green-500/30';
    else if (ratio >= 0.5) colorClass = 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';

    return (
      <div className="mt-6 space-y-3">
        <h3 className="text-sm font-medium text-slate-400">Grading</h3>
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
          <div className="flex items-center gap-3 mb-3">
            <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${colorClass}`}>
              {score} / {maxMarks} marks
            </span>
          </div>
          {gradingResult.aiFeedback && (
            <p className="text-sm text-slate-300 bg-slate-900/50 p-3 rounded-md border border-slate-800">
              {gradingResult.aiFeedback}
            </p>
          )}
        </div>
      </div>
    );
  };

  if (selectedUnmatchedAnswer) {
    return (
      <div className="h-full overflow-y-auto bg-slate-900 p-6">
        <div className="space-y-6 max-w-3xl mx-auto">
          <div>
            <h2 className="text-xl font-semibold text-slate-200 mb-4">Unmatched Answer</h2>
            <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4 space-y-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-400">Label:</span>
                <span className="font-mono text-slate-200 bg-slate-900 px-2 py-1 rounded">
                  {selectedUnmatchedAnswer.answer.studentLabel || 'None'}
                </span>
              </div>
              <div>
                <span className="text-sm text-slate-400 block mb-2">Content:</span>
                <div className="font-mono text-slate-300 bg-slate-900 p-4 rounded-md border border-slate-800 whitespace-pre-wrap">
                  {selectedUnmatchedAnswer.answer.text}
                </div>
              </div>
              {selectedUnmatchedAnswer.candidateQuestionId && (
                <div className="pt-4 border-t border-slate-700">
                  <p className="text-sm text-slate-400">
                    Possible match: {selectedUnmatchedAnswer.candidateQuestionId}
                    {selectedUnmatchedAnswer.candidateConfidence !== undefined && 
                      ` (confidence: ${Math.round(selectedUnmatchedAnswer.candidateConfidence * 100)}%)`}
                  </p>
                  {selectedUnmatchedAnswer.candidateReason && (
                    <p className="text-sm text-slate-500 mt-1">
                      Reason: {selectedUnmatchedAnswer.candidateReason}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (selectedQuestion) {
    return (
      <div className="h-full overflow-y-auto bg-slate-900 p-6">
        <div className="space-y-6 max-w-3xl mx-auto">
          <div className="rounded-lg border border-slate-700 bg-slate-800 p-5 shadow-sm">
            <h2 className="text-lg font-medium text-slate-200 mb-2">
              Question {selectedQuestion.number}
              <span className="ml-2 text-sm text-slate-400 font-normal">[{selectedQuestion.marks} marks]</span>
            </h2>
            <p className="text-slate-300">{selectedQuestion.text}</p>
          </div>

          {!selectedAnswer ? (
            <div className="rounded-lg border border-slate-800 bg-slate-800/30 p-8 text-center text-slate-500">
              This question was not attempted by the student
            </div>
          ) : (
            <>
              <div>
                <h3 className="text-sm font-medium text-slate-400 mb-3">Student Answer</h3>
                <div className="rounded-lg border border-slate-700 bg-slate-800 p-5 font-mono text-slate-200 whitespace-pre-wrap shadow-inner">
                  {selectedAnswer.text}
                </div>
              </div>

              {selectedMapping && (
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-slate-400">Matched via:</span>
                  {selectedMapping.reasons && selectedMapping.reasons.length > 0 && (
                    <span className="rounded-md bg-slate-800 px-2 py-1 text-slate-300 border border-slate-700">
                      {selectedMapping.reasons.map(formatReason).join(', ')}
                    </span>
                  )}
                  {selectedMapping.confidenceLevel && (
                    <ConfidenceBadge 
                      level={selectedMapping.confidenceLevel} 
                      value={selectedMapping.confidence} 
                    />
                  )}
                </div>
              )}

              {renderGradingResult()}
            </>
          )}
        </div>
      </div>
    );
  }

  return null;
}
