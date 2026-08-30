'use client';

import { useState } from 'react';
import type { OverallSummary, GradingResult, Question } from '@/lib/types';
import { Progress } from '@/components/ui/progress';
import { Trophy, ChevronDown, ChevronUp, CheckCircle, XCircle, MinusCircle, AlertCircle } from 'lucide-react';

interface Props {
  overallSummary: OverallSummary;
  gradingResults: GradingResult[];
  questions: Question[];
}

export function GradingSummary({
  overallSummary,
  gradingResults,
  questions,
}: Props) {
  const [isExpanded, setIsExpanded] = useState(false);

  const percentage = 
    overallSummary.maxScore > 0 
      ? Math.round((overallSummary.totalScore / overallSummary.maxScore) * 100) 
      : 0;

  let progressColor = 'bg-red-500';
  let indicatorColor = 'text-red-500';
  if (percentage >= 70) {
    progressColor = 'bg-green-500';
    indicatorColor = 'text-green-500';
  } else if (percentage >= 40) {
    progressColor = 'bg-yellow-500';
    indicatorColor = 'text-yellow-500';
  }

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden shadow-sm">
      <div 
        className="p-4 cursor-pointer hover:bg-slate-700/50 transition-colors flex items-center justify-between"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-4 flex-1">
          <div className={`p-2 rounded-full bg-slate-900 ${indicatorColor}`}>
            <Trophy className="w-5 h-5" />
          </div>
          <div className="flex-1 pr-8">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-medium text-slate-200">Overall Score</h3>
              <span className="font-semibold text-slate-100">
                {overallSummary.totalScore} / {overallSummary.maxScore} <span className="text-slate-400 text-sm font-normal">({percentage}%)</span>
              </span>
            </div>
            {/* Fallback to custom div if shadcn Progress doesn't take indicatorClassName */}
            <div className="relative w-full h-2 bg-slate-900 rounded-full overflow-hidden">
              <div 
                className={`absolute top-0 left-0 h-full ${progressColor} transition-all duration-500`}
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>
        </div>
        <button 
          className="p-1 text-slate-400 hover:text-slate-200 focus:outline-none ml-2"
          aria-label={isExpanded ? "Collapse" : "Expand"}
        >
          {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
        </button>
      </div>

      {isExpanded && (
        <div className="border-t border-slate-700 p-4 bg-slate-900/50">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-slate-300">
              <thead className="text-xs text-slate-400 uppercase bg-slate-800/50 border-b border-slate-700">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Question</th>
                  <th scope="col" className="px-4 py-3 font-medium">Score</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {questions.map((question) => {
                  const result = gradingResults.find(r => r.questionId === question.id);
                  const score = result?.score ?? 0;
                  const maxScore = question.marks;
                  
                  let statusText = 'Unanswered';
                  let StatusIcon = MinusCircle;
                  let statusClass = 'text-slate-500 bg-slate-800/80 border-slate-700';

                  if (result) {
                    if (result.status === 'correct') {
                       statusText = 'Correct';
                       StatusIcon = CheckCircle;
                       statusClass = 'text-green-400 bg-green-500/10 border-green-500/20';
                    } else if (score > 0) {
                       statusText = 'Partial';
                       StatusIcon = AlertCircle;
                       statusClass = 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20';
                    } else {
                       statusText = 'Incorrect';
                       StatusIcon = XCircle;
                       statusClass = 'text-red-400 bg-red-500/10 border-red-500/20';
                    }
                  }

                  return (
                    <tr key={question.id} className="border-b border-slate-700/50 hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3 font-medium text-slate-200">
                        {question.number}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-slate-200">{score}</span>
                        <span className="text-slate-500 text-xs ml-1">/ {maxScore}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${statusClass}`}>
                          <StatusIcon className="w-3.5 h-3.5" />
                          {statusText}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
