'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { X, ArrowRight, ArrowLeft, ChevronLeft, Menu } from 'lucide-react';
import { setAnswerSheetFile } from '@/lib/file-store';
import { Sidebar } from '@/components/Sidebar';

const PROGRESS_STAGES = [
  'Converting documents to images...',
  'Running OCR on documents...',
  'Extracting questions from paper...',
  'Segmenting answer regions...',
  'Mapping answers to questions...',
  'Finalising results...',
];

function FileUploadZone({
  sublabel,
  file,
  onFileSelect,
  onFileRemove,
}: {
  sublabel: string;
  file: File | null;
  onFileSelect: (f: File) => void;
  onFileRemove: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setIsDragging(true);
    else setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const f = e.dataTransfer.files?.[0];
      if (f && (f.type.startsWith('image/') || f.type === 'application/pdf')) onFileSelect(f);
    },
    [onFileSelect]
  );

  const formatSize = (bytes: number) =>
    bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB';

  return (
    <div
      className={`relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-white transition-all cursor-pointer select-none ${
        file
          ? 'border-[#FF5623]/50 p-3 sm:p-4'
          : isDragging
          ? 'border-[#FF5623] bg-[#FF935026] py-8 sm:py-10 px-4 sm:px-6'
          : 'border-[#D8D3D3] hover:border-[#FF5623]/50 py-8 sm:py-10 px-4 sm:px-6'
      }`}
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
      onClick={() => !file && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".pdf,image/*"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFileSelect(f);
        }}
      />

      {file ? (
        /* ── Uploaded state: matching reference screenshot ── */
        <div className="w-full flex items-center justify-center">
          <div className="flex items-center gap-3 w-full bg-[#F5F5F5] rounded-xl px-3.5 py-2.5 sm:px-4 sm:py-3">
            {/* PDF icon */}
            <div className="shrink-0">
              <Image src="/assets/pdf icon.png" alt="PDF" width={40} height={40} className="w-9 h-9 sm:w-10 sm:h-10 object-contain" />
            </div>
            {/* File info */}
            <div className="flex-1 min-w-0">
              <p className="text-xs sm:text-sm font-bold text-gray-900 truncate">{file.name}</p>
              <p className="text-[11px] sm:text-xs font-medium text-gray-400 mt-0.5">
                {formatSize(file.size)} • PDF
              </p>
            </div>
            {/* Dark circular remove button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFileRemove();
              }}
              className="shrink-0 w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center rounded-full bg-gray-800 hover:bg-gray-900 text-white transition-colors"
              aria-label="Remove file"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ) : (
        /* ── Empty state: matching reference screenshot ── */
        <div className="flex flex-col items-center justify-center gap-2.5 text-center">
          <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center">
            <Image src="/assets/upload icon.png" alt="upload" width={28} height={28} className="w-7 h-7 object-contain opacity-70" />
          </div>
          <div>
            <p className="text-sm sm:text-base font-bold text-gray-900">
              Upload <span className="text-[#FF5623]">{sublabel}</span>
            </p>
            <p className="text-xs font-medium text-gray-400 mt-0.5">Max 10MB</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [questionPaper, setQuestionPaper] = useState<File | null>(null);
  const [answerSheet, setAnswerSheet] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressStage, setProgressStage] = useState(0);
  const [progressPercent, setProgressPercent] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // ── Dev preview mode ──────────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const preview = params.get('preview');
    if (preview === 'loading') {
      setIsProcessing(true);
    } else if (preview === 'uploaded') {
      const dummy = (name: string) => new File(['dummy'], name, { type: 'application/pdf' });
      setQuestionPaper(dummy('Class_10_maths_unit_test.pdf'));
      setAnswerSheet(dummy('student_1_answer_sheet.pdf'));
    }
  }, []);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isProcessing && progressStage < PROGRESS_STAGES.length - 1)
      timer = setTimeout(() => setProgressStage((s) => s + 1), 12000);
    return () => clearTimeout(timer);
  }, [isProcessing, progressStage]);

  // ── Smooth progress percentage animation ──────────────────────────────────
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isProcessing) {
      setProgressPercent(15);
      interval = setInterval(() => {
        setProgressPercent((prev) => {
          if (prev >= 94) return prev;
          const remaining = 95 - prev;
          const step = Math.max(0.4, remaining * 0.04);
          return Math.min(94, +(prev + step).toFixed(1));
        });
      }, 350);
    } else {
      setProgressPercent(10);
    }
    return () => clearInterval(interval);
  }, [isProcessing]);

  const handleSubmit = async () => {
    if (!questionPaper || !answerSheet) return;
    setIsProcessing(true);
    setProgressStage(0);
    setProgressPercent(15);
    setError(null);
    const formData = new FormData();
    formData.append('questionPaper', questionPaper);
    formData.append('answerSheet', answerSheet);
    formData.append('enableGrading', 'true');
    try {
      const res = await fetch('/api/process', { method: 'POST', body: formData });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Failed to process documents');
      }
      const result = await res.json();
      setProgressPercent(100);
      localStorage.setItem('vedaai_result', JSON.stringify(result));
      setAnswerSheetFile(answerSheet);
      setTimeout(() => {
        router.push('/results');
      }, 400);
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred.');
      setIsProcessing(false);
    }
  };

  const canSubmit = !!questionPaper && !!answerSheet && !isProcessing;

  return (
    <div className="flex h-screen overflow-hidden bg-gradient-to-b from-[#EEEEEE] to-[#CECECE] md:bg-transparent">
      {/* Sidebar with mobile drawer support */}
      <Sidebar
        activeItem="Exams"
        isMobileOpen={isMobileMenuOpen}
        onMobileClose={() => setIsMobileMenuOpen(false)}
      />

      {/* ── Right / Main column ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 p-3 sm:py-3 sm:pr-3 sm:pl-0">
        {/* Topbar: Desktop View */}
        <div
          className="hidden md:flex items-center justify-between px-5 py-3 bg-white/75 backdrop-blur-md rounded-2xl mb-3 shrink-0"
          style={{ backgroundColor: 'rgba(255, 255, 255, 0.75)', boxShadow: '0 2px 12px 0 rgba(0,0,0,0.07)' }}
        >
          {/* Left: back + breadcrumb */}
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-500">
            <ChevronLeft className="w-5 h-5 text-gray-400 stroke-[2.5]" />
            <Image src="/assets/exams icon.png" alt="Exams" width={18} height={18} className="opacity-70" />
            <span className="text-gray-700">Exams</span>
          </div>

          {/* Right: icons + profile */}
          <div className="flex items-center gap-4">
            <Image
              src="/assets/question mark in circle icon.png"
              alt="Help"
              width={22}
              height={22}
              className="opacity-60"
            />
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

        {/* Topbar: Mobile View (Matches reference screenshots 1, 2, 3) */}
        <div
          className="flex md:hidden items-center justify-between px-4 py-2.5 bg-white rounded-2xl mb-3 shrink-0"
          style={{ boxShadow: '0 2px 12px 0 rgba(0,0,0,0.07)' }}
        >
          {/* Left: ← VedaAI */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.push('/')}
              className="p-1 text-gray-800 hover:text-gray-900 transition-colors"
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
              <span className="absolute 1 top-1 right-1.5 w-2 h-2 bg-[#FF5623] rounded-full border border-white" />
            </div>
            <Image src="/assets/dp icon.png" alt="Profile" width={28} height={28} className="rounded-full" />
            <button
              onClick={() => setIsMobileMenuOpen(true)}
              className="p-1 text-gray-800 hover:text-gray-900 transition-colors"
              aria-label="Open menu"
            >
              <Menu className="w-6 h-6 stroke-[2]" />
            </button>
          </div>
        </div>

        {/* Main area */}
        {isProcessing ? (
          <div className="flex-1 flex flex-col min-h-0 w-full">
            {error && (
              <div className="w-full p-4 mb-3 rounded-xl border border-red-200 bg-red-50 flex items-start gap-3 shrink-0">
                <X className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-bold text-red-600">Processing Error</p>
                  <p className="text-sm text-red-500 mt-0.5">{error}</p>
                </div>
              </div>
            )}
            <div
              className="flex-1 w-full rounded-3xl md:rounded-2xl bg-white flex flex-col items-center justify-center p-6 sm:p-8"
              style={{ boxShadow: '0 4px 24px 0 rgba(0,0,0,0.08)' }}
            >
              <div className="relative flex items-center justify-center">
                <div
                  className="absolute w-36 h-36 sm:w-44 sm:h-44 rounded-full animate-pulse"
                  style={{ background: 'radial-gradient(circle, rgba(255,86,35,0.18) 0%, transparent 70%)' }}
                />
                <Image
                  src="/assets/extracting icon.png"
                  alt="Extracting"
                  width={100}
                  height={100}
                  className="relative z-10 animate-pulse w-[100px] h-[100px] object-contain"
                  style={{ animationDuration: '1.5s' }}
                />
              </div>
              <div className="text-center mt-6">
                <p className="text-2xl sm:text-3xl font-extrabold text-gray-900 tracking-tight">Extracting...</p>
                <p className="text-sm sm:text-base font-medium text-gray-400 mt-1.5">This may take a while</p>
              </div>

              {/* Theme Grey & Orange Progress Bar */}
              <div className="w-full max-w-xs sm:max-w-sm md:max-w-md mt-6 flex flex-col items-center gap-2">
                <div className="w-full h-2.5 sm:h-3 bg-[#EAE7E5] rounded-full overflow-hidden p-0.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.1)] border border-black/5">
                  <div
                    className="h-full bg-gradient-to-r from-[#FF7A45] to-[#FF5623] rounded-full transition-all duration-500 ease-out shadow-xs"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="w-full flex items-center justify-between text-[11px] sm:text-xs text-gray-500 font-medium px-1">
                  <span className="truncate pr-2">{PROGRESS_STAGES[progressStage]}</span>
                  <span className="font-bold text-[#FF5623] tabular-nums shrink-0">{Math.round(progressPercent)}%</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col items-center justify-center">
            <div className="flex flex-col items-center gap-5 sm:gap-6 w-full max-w-2xl px-2 sm:px-4 py-2">
              {/* Error */}
              {error && (
                <div className="w-full p-4 rounded-xl border border-red-200 bg-red-50 flex items-start gap-3">
                  <X className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-bold text-red-600">Processing Error</p>
                    <p className="text-sm text-red-500 mt-0.5">{error}</p>
                  </div>
                </div>
              )}

              {/* ── Upload State: matching Screenshots 2 & 3 ── */}
              {/* Heading + Character */}
              <div className="text-center">
                <h1 className="text-2xl sm:text-3xl md:text-4xl font-extrabold text-gray-900 leading-tight tracking-tight md:whitespace-nowrap">
                  Upload{' '}
                  <span
                    className="text-[#FF5623] rounded-lg px-2 py-0.5"
                    style={{ background: '#FF935026' }}
                  >
                    Question Paper &amp; Answer Sheets
                  </span>
                </h1>
                <p className="hidden md:block text-sm text-gray-500 font-medium mt-1.5">
                  Upload both files to get started
                </p>
              </div>

                <div className="relative flex items-center justify-center my-1">
                  <div
                    className="absolute w-32 h-32 sm:w-36 sm:h-36 rounded-full"
                    style={{ background: 'radial-gradient(circle, rgba(255,147,80,0.28) 0%, transparent 70%)' }}
                  />
                  <Image
                    src="/assets/center animated character icon.png"
                    alt="Teacher"
                    width={115}
                    height={115}
                    className="relative z-10 w-[105px] h-[105px] sm:w-[115px] sm:h-[115px] object-contain"
                  />
                </div>

                {/* Grey container wrapping upload cards */}
                <div className="w-full bg-[#F0EDEC] rounded-3xl p-3.5 sm:p-4 shadow-2xs">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                    <FileUploadZone
                      sublabel="Question Paper"
                      file={questionPaper}
                      onFileSelect={setQuestionPaper}
                      onFileRemove={() => setQuestionPaper(null)}
                    />
                    <FileUploadZone
                      sublabel="Answer Sheet"
                      file={answerSheet}
                      onFileSelect={setAnswerSheet}
                      onFileRemove={() => setAnswerSheet(null)}
                    />
                  </div>
                </div>

                {/* Start Mapping button */}
                <div className="flex flex-col items-center gap-2 mt-1">
                  <button
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    className={`flex items-center gap-2 rounded-full px-8 py-3.5 text-sm sm:text-base font-bold transition-all ${
                      canSubmit
                        ? 'bg-gray-800 text-white hover:bg-gray-900 shadow-md cursor-pointer'
                        : 'bg-[#B4B4B4]/50 text-gray-500 cursor-not-allowed'
                    }`}
                  >
                    Start Mapping
                    <ArrowRight className="w-4 h-4" />
                  </button>
                  <p className="text-xs sm:text-sm font-medium text-gray-400 text-center max-w-xs sm:max-w-sm">
                    Once both files are uploaded, you&apos;ll able to map answers with questions
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

