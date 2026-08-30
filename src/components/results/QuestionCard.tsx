import type { Question, AnswerMapping, GradingResult } from '@/lib/types';
import { ConfidenceBadge } from './ConfidenceBadge';
import { CheckCircle2, MinusCircle, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface Props {
  question: Question;
  mapping: AnswerMapping | undefined;
  gradingResult: GradingResult | undefined;
  isSelected: boolean;
  onClick: () => void;
}

export function QuestionCard({ question, mapping, gradingResult, isSelected, onClick }: Props) {
  const isAnswered = !!mapping;
  const isLowConfidence = mapping?.confidenceLevel === 'low';
  
  let StatusIcon = MinusCircle;
  let iconColor = 'text-slate-500';
  
  if (isAnswered) {
    if (isLowConfidence) {
      StatusIcon = AlertTriangle;
      iconColor = 'text-yellow-500';
    } else {
      StatusIcon = CheckCircle2;
      iconColor = 'text-green-500';
    }
  }

  return (
    <div
      onClick={onClick}
      className={`cursor-pointer rounded-lg border p-3 transition-colors ${
        isSelected
          ? 'bg-blue-500/20 border-blue-500/50'
          : 'bg-slate-800/30 border-slate-700 hover:bg-slate-700/50'
      }`}
    >
      {/* Top row: status icon + number + badges */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <StatusIcon className={`h-4 w-4 shrink-0 ${iconColor}`} />
          <span className="font-semibold text-slate-200 text-sm shrink-0">
            Q{question.number}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {mapping?.confidenceLevel && (
            <ConfidenceBadge level={mapping.confidenceLevel} value={mapping.confidence} />
          )}
          {gradingResult && (
            <Badge variant="secondary" className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs">
              {gradingResult.score}/{question.marks ?? '?'}
            </Badge>
          )}
        </div>
      </div>

      {/* Question text preview */}
      {question.text && (
        <p className="mt-1.5 text-xs text-slate-400 leading-relaxed line-clamp-2 pl-6">
          {question.text}
        </p>
      )}
    </div>
  );
}

