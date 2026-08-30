import type { Question, AnswerMapping, GradingResult, UnmatchedAnswer } from '@/lib/types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { QuestionCard } from './QuestionCard';

interface Props {
  questions: Question[];
  mappings: AnswerMapping[];
  gradingResults?: GradingResult[];
  unansweredQuestions: Question[];
  unmatchedAnswers: UnmatchedAnswer[];
  selectedQuestionId: string | null;
  selectedUnmatchedAnswerId: string | null;
  onSelectQuestion: (id: string) => void;
  onSelectUnmatchedAnswer: (id: string) => void;
}

export function QuestionList({
  questions,
  mappings,
  gradingResults,
  unansweredQuestions,
  unmatchedAnswers,
  selectedQuestionId,
  selectedUnmatchedAnswerId,
  onSelectQuestion,
  onSelectUnmatchedAnswer,
}: Props) {
  return (
    <div className="flex flex-col h-full bg-slate-900 border-r border-slate-800">
      <div className="p-4 flex items-center justify-between border-b border-slate-800">
        <h2 className="font-semibold text-slate-200">Questions</h2>
        <Badge variant="secondary" className="bg-slate-800 text-slate-300">
          {questions.length}
        </Badge>
      </div>

      <ScrollArea className="flex-1 p-4">
        <div className="space-y-2">
          {questions.map((question) => {
            const mapping = mappings.find((m) => m.questionId === question.id);
            const gradingResult = gradingResults?.find((g) => g.questionId === question.id);
            
            return (
              <QuestionCard
                key={question.id}
                question={question}
                mapping={mapping}
                gradingResult={gradingResult}
                isSelected={selectedQuestionId === question.id}
                onClick={() => onSelectQuestion(question.id)}
              />
            );
          })}
        </div>

        {unmatchedAnswers.length > 0 && (
          <>
            <Separator className="my-6 bg-slate-800" />
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-400">Unmatched Answers</h3>
              <Badge variant="outline" className="text-slate-500 border-slate-700">
                {unmatchedAnswers.length}
              </Badge>
            </div>
            
            <div className="space-y-2">
              {unmatchedAnswers.map((ua) => (
                <div
                  key={ua.answer.id}
                  onClick={() => onSelectUnmatchedAnswer(ua.answer.id)}
                  className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                    selectedUnmatchedAnswerId === ua.answer.id
                      ? 'bg-blue-500/20 border-blue-500/50'
                      : 'bg-slate-800/30 border-slate-700 hover:bg-slate-700/50'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div className="h-2 w-2 rounded-full bg-blue-500" />
                    <span className="text-sm font-medium text-slate-300">
                      {ua.answer.studentLabel || 'No label'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 line-clamp-2 pl-4">
                    {ua.answer.text}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </ScrollArea>
    </div>
  );
}
