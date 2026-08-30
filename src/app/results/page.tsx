'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  ArrowLeft,
  Menu,
} from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { getAnswerSheetFileAsync } from '@/lib/file-store';
import { Sidebar } from '@/components/Sidebar';
import type { ProcessingResult, Question, GradingResult } from '@/lib/types';

// PDF viewer — client-only
const AnswerSheetViewer = dynamic(
  () => import('@/components/results/AnswerSheetViewer').then(m => ({ default: m.AnswerSheetViewer })),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        Loading viewer...
      </div>
    ),
  }
);

// ─── Sidebar (same as upload page) ──────────────────────────────────────────
const NAV_ITEMS = [
  { label: 'Home',         icon: '/assets/home icon.png' },
  { label: 'My Classroom', icon: '/assets/my classroom icon.png' },
  { label: 'Assignments',  icon: '/assets/assignments icon.png' },
  { label: 'Exams',        icon: '/assets/exams icon.png', active: true },
  { label: 'My Library',   icon: '/assets/my library icon.png' },
];

// ─── Score badge — pill with red / yellow / green ────────────────────────────
function ScoreBadge({ score, maxScore }: { score: number | null; maxScore: number | null }) {
  if (score === null || maxScore === null) return null;
  const isFull    = score === maxScore;
  const isZero    = score === 0;
  const isPartial = !isFull && !isZero;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold tabular-nums border shrink-0 ${
      isFull    ? 'bg-green-50  text-green-700  border-green-200'  :
      isPartial ? 'bg-yellow-50 text-yellow-700 border-yellow-200' :
                  'bg-red-50    text-red-600    border-red-200'
    }`}>
      {score}/{maxScore}
    </span>
  );
}

// ─── Question accordion item ─────────────────────────────────────────────────
function QuestionItem({
  question,
  displayIndex,
  gradingResult,
  isExpanded,
  onClick,
}: {
  question: Question;
  displayIndex: number;
  gradingResult?: GradingResult;
  isExpanded: boolean;
  onClick: () => void;
}) {
  const subpart = question.parentNumber
    ? question.number.replace(question.parentNumber, '').trim()
    : null;

  return (
    <div
      className={`w-full min-w-0 rounded-2xl border-2 transition-all cursor-pointer bg-white p-3 sm:p-3.5 ${
        isExpanded
          ? 'border-[#FF5623] shadow-md'
          : 'border-transparent shadow-xs hover:shadow-sm'
      }`}
      onClick={onClick}
    >
      {/* Top Header Row: Number Badge (+ subpart) on Left, Score Badge + Chevron on Right */}
      <div className="flex items-center justify-between w-full gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold ring-[3px] ${
              isExpanded
                ? 'bg-[#FF5623] text-white ring-orange-200'
                : 'bg-gray-700 text-white ring-gray-200'
            }`}
          >
            {displayIndex}
          </div>
          {subpart && (
            <span className="text-xs sm:text-sm font-bold text-gray-700">{subpart}</span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {gradingResult && (
            <ScoreBadge score={gradingResult.score} maxScore={gradingResult.maxScore} />
          )}
          <div className="w-6 h-6 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
            {isExpanded ? (
              <ChevronUp className="w-3.5 h-3.5 text-gray-500" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
            )}
          </div>
        </div>
      </div>

      {/* Question Text Row: Full width below header row */}
      <p className="w-full text-xs sm:text-sm font-medium text-gray-800 leading-snug break-words mt-2.5">
        {question.text}
      </p>

      {/* Expanded: AI Feedback */}
      {isExpanded && gradingResult?.aiFeedback && (
        <div className="mt-3 rounded-xl bg-gray-50 p-3 text-xs space-y-1">
          <p className="font-bold text-gray-700">AI Feedback</p>
          <p className="text-gray-600 leading-relaxed break-words">{gradingResult.aiFeedback}</p>
        </div>
      )}
    </div>
  );
}

// ─── Results page ─────────────────────────────────────────────────────────────
export default function ResultsPage() {
  const router = useRouter();
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [answerSheetDataUrl, setAnswerSheetDataUrl] = useState<string | null>(null);
  const [expandedQuestionId, setExpandedQuestionId] = useState<string | null>(null);
  const [allExpanded, setAllExpanded] = useState(false);
  const [mobileTab, setMobileTab] = useState<'questions' | 'answers'>('questions');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // ── Resizable split (Desktop) ──────────────────────────────────────────────
  const [splitRatio, setSplitRatio] = useState(0.38);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Viewer controls ────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(100);
  const [currentPage, setCurrentPage] = useState(1);
  const [pdfTotalPages, setPdfTotalPages] = useState<number>(0);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const onMouseMove = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const ratio = (ev.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(0.72, Math.max(0.22, ratio)));
    };

    const onMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const {
    selectedQuestionId,
    selectQuestion,
    selectUnmatchedAnswer,
    getSelectedAnswer,
    getSelectedUnmatchedAnswer,
    setResult: setStoreResult,
  } = useAppStore();

  useEffect(() => {
    const stored = localStorage.getItem('vedaai_result');
    if (!stored) { router.replace('/'); return; }
    try {
      const parsed = JSON.parse(stored) as ProcessingResult;
      setResult(parsed);
      setStoreResult(parsed);
    } catch { router.replace('/'); return; }

    let objectUrl: string | null = null;
    getAnswerSheetFileAsync().then(file => {
      if (file) {
        objectUrl = URL.createObjectURL(file);
        setAnswerSheetDataUrl(objectUrl);
      }
    }).catch(err => console.warn('[results] Failed to load answer sheet file:', err));

    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [router]);

  if (!result) {
    return (
      <div className="h-screen flex items-center justify-center">
        <p className="text-gray-400 text-sm font-medium">Loading results...</p>
      </div>
    );
  }

  const selectedAnswer = getSelectedAnswer();
  const totalPages = pdfTotalPages || result.pageMetadata.length || 1;

  // ── Derived data ─────────────────────────────────────────────────────────
  const unansweredIds = new Set(result.unansweredQuestions.map(q => q.id));
  const answeredQuestions = result.questions.filter(q => !unansweredIds.has(q.id));

  // Label shown on the PDF highlight badge
  const selectedUnmatched = getSelectedUnmatchedAnswer();
  const selectedQuestion = result.questions.find(q => q.id === expandedQuestionId);
  const selectedQuestionLabel = selectedQuestion
    ? `Q${selectedQuestion.number}`
    : selectedUnmatched
      ? `?(${selectedUnmatched.answer.studentLabel ?? '?'})`
      : null;

  const handleQuestionClick = (qId: string) => {
    const next = expandedQuestionId === qId ? null : qId;
    setExpandedQuestionId(next);
    selectQuestion(next);
  };

  const handleUnmatchedClick = (answerId: string) => {
    selectUnmatchedAnswer(answerId);
    setExpandedQuestionId(null);
  };

  const handleExpandAll = () => setAllExpanded(v => !v);

  // ── Questions List Component (shared by desktop and mobile) ────────────────
  const renderQuestionsPanel = () => (
    <div
      className="flex flex-col rounded-3xl md:rounded-2xl overflow-hidden shrink-0 h-full w-full min-w-0 bg-white/50 backdrop-blur-md"
      style={{
        backgroundColor: 'rgba(255, 255, 255, 0.50)',
        boxShadow: '0 4px 24px 0 rgba(0,0,0,0.08)',
      }}
    >
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-gray-200/60 shrink-0 w-full bg-transparent">
        <p className="text-xs sm:text-sm font-bold text-gray-800">
          Extracted Questions <span className="text-gray-400 font-medium">(from question paper)</span>
        </p>
        <button
          onClick={handleExpandAll}
          className="text-xs font-semibold text-gray-700 bg-white/80 hover:bg-white px-3 py-1.5 rounded-lg border border-gray-200/60 transition-colors shrink-0 cursor-pointer shadow-2xs"
        >
          {allExpanded ? 'Collapse All' : 'Expand All'}
        </button>
      </div>

      {/* Scrollable question list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 w-full min-w-0">
        {/* ── Answered questions only (100% opacity solid white cards) ──────── */}
        {answeredQuestions.map((q) => {
          const originalIndex = result.questions.findIndex(rq => rq.id === q.id);
          const gradingResult = result.gradingResults?.find(g => g.questionId === q.id);
          const isExp = allExpanded || expandedQuestionId === q.id;
          return (
            <QuestionItem
              key={q.id}
              question={q}
              displayIndex={originalIndex + 1}
              gradingResult={gradingResult}
              isExpanded={isExp}
              onClick={() => handleQuestionClick(q.id)}
            />
          );
        })}

        {/* ── Unanswered questions (100% opacity solid white cards) ─────────── */}
        {result.unansweredQuestions.length > 0 && (
          <div className="pt-2 w-full min-w-0">
            <p className="text-xs font-semibold text-gray-500 px-1 pb-1">Unanswered</p>
            {result.unansweredQuestions.map((q) => {
              const originalIndex = result.questions.findIndex(rq => rq.id === q.id);
              return (
                <div key={q.id} className="flex items-center gap-3 p-3 rounded-2xl bg-white mb-2 shadow-xs border border-gray-100/80 opacity-75 w-full min-w-0">
                  <div className="shrink-0 w-7 h-7 rounded-full bg-gray-300 ring-[3px] ring-gray-200 flex items-center justify-center text-xs font-extrabold text-white">
                    {originalIndex + 1}
                  </div>
                  <p className="flex-1 text-xs sm:text-sm text-gray-600 leading-snug break-words min-w-0">{q.text}</p>
                  <span className="text-xs font-bold text-red-500 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full shrink-0">
                    0/{q.marks ?? '?'}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Unmatched answers (100% opacity solid white cards) ────────────── */}
        {result.unmatchedAnswers.length > 0 && (
          <div className="pt-2 w-full min-w-0">
            <p className="text-xs font-semibold text-orange-500 px-1 pb-1">
              Unmatched Answers ({result.unmatchedAnswers.length})
            </p>
            {result.unmatchedAnswers.map((ua) => {
              const isSelected = selectedUnmatched?.answer.id === ua.answer.id;
              return (
                <button
                  key={ua.answer.id}
                  onClick={() => handleUnmatchedClick(ua.answer.id)}
                  className={`w-full text-left rounded-2xl border-2 p-3 transition-all bg-white mb-2 cursor-pointer min-w-0 ${
                    isSelected
                      ? 'border-orange-400 shadow-md'
                      : 'border-orange-100 shadow-xs hover:shadow-md hover:border-orange-200'
                  }`}
                >
                  <div className="flex items-center gap-3 w-full min-w-0">
                    <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold ring-[3px] ${
                      isSelected ? 'bg-orange-400 text-white ring-orange-200' : 'bg-orange-100 text-orange-600 ring-orange-100'
                    }`}>
                      ?
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-orange-500 mb-0.5">
                        Student label: {ua.answer.studentLabel ?? 'none'}
                      </p>
                      <p className="text-xs text-gray-400 truncate">{ua.answer.text.slice(0, 80)}…</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  // ── Answer Sheet Viewer Component (shared by desktop and mobile) ──────────
  const renderViewerPanel = () => (
    <div
      className="flex-1 flex flex-col rounded-3xl md:rounded-2xl overflow-hidden min-w-0 bg-white h-full"
      style={{ boxShadow: '0 4px 24px 0 rgba(0,0,0,0.08)' }}
    >
      {/* Dark header bar */}
      <div className="flex items-center justify-between px-3.5 sm:px-4 py-2.5 bg-[#2C2C2C] shrink-0 rounded-t-3xl md:rounded-t-2xl">
        <span className="text-xs sm:text-sm font-semibold text-white">Answer Sheet</span>
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Zoom controls */}
          <div className="flex items-center gap-1 bg-white/10 rounded-lg px-1.5 sm:px-2 py-1">
            <button
              onClick={() => setZoom(z => Math.max(50, z - 15))}
              className="w-5 h-5 flex items-center justify-center rounded text-white/70 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              title="Zoom Out"
            >
              <Minus className="w-3.5 h-3.5 stroke-[2.5]" />
            </button>
            <button
              onClick={() => setZoom(100)}
              className="text-[11px] sm:text-xs font-semibold text-white min-w-[3.5ch] text-center hover:text-orange-300 transition-colors px-1 select-none cursor-pointer"
              title="Click to reset to 100%"
            >
              {zoom}%
            </button>
            <button
              onClick={() => setZoom(z => Math.min(300, z + 15))}
              className="w-5 h-5 flex items-center justify-center rounded text-white/70 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              title="Zoom In"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
            </button>
          </div>

          {/* Page navigation */}
          {totalPages > 0 && (
            <div className="flex items-center gap-0.5 sm:gap-1 bg-white/10 rounded-lg px-1 sm:px-1.5 py-1 text-xs">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="w-5 sm:w-6 h-5 sm:h-6 flex items-center justify-center rounded text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors cursor-pointer"
                title="Previous Page"
              >
                <ChevronLeft className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>
              <span className="font-medium text-white px-1 select-none whitespace-nowrap text-[11px] sm:text-xs">
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                className="w-5 sm:w-6 h-5 sm:h-6 flex items-center justify-center rounded text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors cursor-pointer"
                title="Next Page"
              >
                <ChevronRight className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* PDF content */}
      <div className="flex-1 min-h-0 overflow-hidden bg-white">
        <AnswerSheetViewer
          answerSheetDataUrl={answerSheetDataUrl}
          selectedAnswer={selectedAnswer ?? (selectedUnmatched?.answer ?? null)}
          pageMetadata={result.pageMetadata}
          zoom={zoom}
          currentPage={currentPage}
          onCurrentPageChange={setCurrentPage}
          onTotalPagesChange={setPdfTotalPages}
          selectedQuestionLabel={selectedQuestionLabel}
        />
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-[#CECECE] md:bg-transparent">
      {/* Sidebar with mobile drawer support */}
      <Sidebar
        activeItem="Exams"
        isMobileOpen={isMobileMenuOpen}
        onMobileClose={() => setIsMobileMenuOpen(false)}
      />

      {/* ── Right / Main column ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 p-3 sm:py-3 sm:pr-3 sm:pl-0 gap-2 sm:gap-3">
        {/* Floating Topbar: Desktop View */}
        <div
          className="hidden md:flex items-center justify-between px-5 py-3 bg-white/75 backdrop-blur-md rounded-2xl shrink-0"
          style={{ backgroundColor: 'rgba(255, 255, 255, 0.75)', boxShadow: '0 2px 12px 0 rgba(0,0,0,0.07)' }}
        >
          <div
            className="flex items-center gap-2 text-sm font-semibold text-gray-500 cursor-pointer hover:text-gray-800 transition-colors"
            onClick={() => router.push('/')}
          >
            <ChevronLeft className="w-5 h-5 text-gray-400 stroke-[2.5]" />
            <Image src="/assets/exams icon.png" alt="Exams" width={18} height={18} className="opacity-70" />
            <span className="text-gray-700">Exams</span>
          </div>
          <div className="flex items-center gap-4">
            <Image src="/assets/question mark in circle icon.png" alt="Help" width={22} height={22} className="opacity-60" />
            <div className="relative">
              <Image src="/assets/bell icon.png" alt="Notifications" width={22} height={22} className="opacity-60" />
              <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-[#FF5623] rounded-full border-2 border-white" />
            </div>
            <Image src="/assets/gemini like icon.png" alt="AI" width={22} height={22} className="opacity-60" />
            <div className="flex items-center gap-2 text-sm font-bold text-gray-800">
              <Image src="/assets/dp icon.png" alt="Profile" width={30} height={30} className="rounded-full" />
              Madhur Rastogi
              <span className="text-gray-400 font-normal text-xs">∨</span>
            </div>
          </div>
        </div>

        {/* Floating Topbar: Mobile View (Matches reference screenshots 4 & 5) */}
        <div
          className="flex md:hidden items-center justify-between px-4 py-2.5 bg-white rounded-2xl shrink-0"
          style={{ boxShadow: '0 2px 12px 0 rgba(0,0,0,0.07)' }}
        >
          {/* Left: ← VedaAI */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.push('/')}
              className="p-1 text-gray-800 hover:text-gray-900 transition-colors cursor-pointer"
              aria-label="Back"
            >
              <ArrowLeft className="w-5 h-5 stroke-[2.5]" />
            </button>
            <div className="flex items-center gap-1.5 font-extrabold text-gray-900 text-lg tracking-tight">
              <Image src="/assets/veda ai logo.png" alt="VedaAI" width={24} height={24} className="shrink-0" />
              <span>VedaAI</span>
            </div>
          </div>

          {/* Right: Bell with dot, Profile DP, Hamburger Menu */}
          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center w-8 h-8 rounded-full bg-gray-100/80">
              <Image src="/assets/bell icon.png" alt="Notifications" width={18} height={18} className="opacity-70" />
              <span className="absolute top-1 right-1.5 w-2 h-2 bg-[#FF5623] rounded-full border border-white" />
            </div>
            <Image src="/assets/dp icon.png" alt="Profile" width={28} height={28} className="rounded-full" />
            <button
              onClick={() => setIsMobileMenuOpen(true)}
              className="p-1 text-gray-800 hover:text-gray-900 transition-colors cursor-pointer"
              aria-label="Open menu"
            >
              <Menu className="w-6 h-6 stroke-[2]" />
            </button>
          </div>
        </div>

        {/* Mobile Tab Switcher Pill Bar (Visible only on mobile, matching uploaded reference image) */}
        <div
          className="flex md:hidden items-center p-1 rounded-full w-full max-w-[290px] sm:max-w-xs mx-auto shrink-0 shadow-[0_4px_24px_rgba(0,0,0,0.10)] border-0 outline-none"
          style={{ backgroundColor: '#FFFFFF' }}
        >
          <button
            onClick={() => setMobileTab('questions')}
            className={`flex-1 py-2 px-4 rounded-full text-xs font-bold transition-all duration-200 text-center cursor-pointer border-0 outline-none ${
              mobileTab === 'questions'
                ? 'bg-[#2B2B2B] text-white shadow-[0_4px_12px_rgba(0,0,0,0.30)]'
                : 'text-[#1F2937] hover:text-black bg-transparent'
            }`}
          >
            Questions
          </button>
          <button
            onClick={() => setMobileTab('answers')}
            className={`flex-1 py-2 px-4 rounded-full text-xs font-bold transition-all duration-200 text-center cursor-pointer border-0 outline-none ${
              mobileTab === 'answers'
                ? 'bg-[#2B2B2B] text-white shadow-[0_4px_12px_rgba(0,0,0,0.30)]'
                : 'text-[#1F2937] hover:text-black bg-transparent'
            }`}
          >
            Answer Sheet
          </button>
        </div>

        {/* ── Desktop Two-Panel Split View ─────────────────────────────────── */}
        <div
          ref={containerRef}
          className="hidden md:flex flex-1 overflow-hidden min-h-0"
          style={{ cursor: isDragging ? 'col-resize' : 'default' }}
        >
          {/* Left: Questions panel */}
          <div
            className="flex flex-col h-full overflow-hidden shrink-0"
            style={{ width: `calc(${splitRatio * 100}% - 6px)` }}
          >
            {renderQuestionsPanel()}
          </div>

          {/* Drag Divider */}
          <div
            className="flex items-center justify-center w-3 shrink-0 cursor-col-resize group select-none"
            onMouseDown={handleDividerMouseDown}
          >
            <div className={`flex flex-col gap-1 px-1 py-3 rounded-full transition-all ${
              isDragging ? 'bg-gray-300' : 'group-hover:bg-gray-200'
            }`}>
              <span className={`w-1 h-1 rounded-full transition-colors ${isDragging ? 'bg-gray-600' : 'bg-gray-300 group-hover:bg-gray-500'}`} />
              <span className={`w-1 h-1 rounded-full transition-colors ${isDragging ? 'bg-gray-600' : 'bg-gray-300 group-hover:bg-gray-500'}`} />
              <span className={`w-1 h-1 rounded-full transition-colors ${isDragging ? 'bg-gray-600' : 'bg-gray-300 group-hover:bg-gray-500'}`} />
              <span className={`w-1 h-1 rounded-full transition-colors ${isDragging ? 'bg-gray-600' : 'bg-gray-300 group-hover:bg-gray-500'}`} />
              <span className={`w-1 h-1 rounded-full transition-colors ${isDragging ? 'bg-gray-600' : 'bg-gray-300 group-hover:bg-gray-500'}`} />
            </div>
          </div>

          {/* Right: Answer Sheet viewer */}
          <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
            {renderViewerPanel()}
          </div>
        </div>

        {/* ── Mobile Single-Panel Tabbed View ──────────────────────────────── */}
        <div className="flex md:hidden flex-1 overflow-hidden min-h-0">
          {mobileTab === 'questions' ? renderQuestionsPanel() : renderViewerPanel()}
        </div>
      </div>
    </div>
  );
}
