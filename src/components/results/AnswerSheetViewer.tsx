'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import type { Answer, PageMetadata } from '@/lib/types';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface Props {
  answerSheetDataUrl: string | null;
  selectedAnswer: Answer | null;
  pageMetadata: PageMetadata[];
  zoom: number;                         // 50–300, 100 = fit container width
  currentPage: number;                  // 1-indexed, controlled by header buttons
  onCurrentPageChange?: (page: number) => void;
  onTotalPagesChange?: (total: number) => void;
  selectedQuestionLabel: string | null; // e.g. "Q2" shown on highlight badge
}

// ─── Single page with green highlight + Q-badge ───────────────────────────────
function PageWithHighlights({
  pageNumber,
  pageIndex,
  width,
  selectedAnswer,
  selectedQuestionLabel,
  metadata,
  pageRef,
}: {
  pageNumber: number;
  pageIndex: number;
  width: number | undefined;
  selectedAnswer: Answer | null;
  selectedQuestionLabel: string | null;
  metadata?: PageMetadata;
  pageRef: (el: HTMLDivElement | null) => void;
}) {
  const [renderedSize, setRenderedSize] = useState<{ width: number; height: number } | null>(null);
  const regionsOnPage = selectedAnswer?.regions?.filter(r => r.pageIndex === pageIndex) ?? [];

  return (
    <div
      ref={pageRef}
      style={{
        position: 'relative',
        display: 'block',
        lineHeight: 0,
        margin: '0 auto',
        padding: 0,
        border: 'none',
        width: width ? `${width}px` : '100%',
        ...(metadata && metadata.width && metadata.height ? { aspectRatio: `${metadata.width} / ${metadata.height}` } : {}),
      }}
      className="bg-white"
    >
      <Page
        pageNumber={pageNumber}
        width={width}
        renderTextLayer={false}
        renderAnnotationLayer={false}
        className="!border-0 !p-0 !m-0 block"
        onRenderSuccess={(page) => setRenderedSize({ width: page.width, height: page.height })}
        loading={
          <div className="flex items-center justify-center h-[700px] w-full text-gray-400 bg-white text-sm">
            Loading page {pageNumber}...
          </div>
        }
      />

      {/* Highlight overlays */}
      {renderedSize && regionsOnPage.map((region, rIndex) => (
        <div
          key={rIndex}
          style={{
            position: 'absolute',
            left: `${region.normalized.x * 100}%`,
            top: `${region.normalized.y * 100}%`,
            width: `${region.normalized.width * 100}%`,
            height: `${region.normalized.height * 100}%`,
            background: 'rgba(34, 197, 94, 0.18)',
            border: '2px solid rgba(34, 197, 94, 0.85)',
            borderRadius: '6px',
            pointerEvents: 'none',
            zIndex: 10,
            boxShadow: '0 0 0 2px rgba(34,197,94,0.10)',
          }}
        >
          {/* Q-number badge in top-left corner of the highlight box */}
          {rIndex === 0 && selectedQuestionLabel && (
            <div
              style={{
                position: 'absolute',
                top: '-14px',
                left: '-2px',
                background: '#22C55E',
                color: 'white',
                fontSize: '10px',
                fontWeight: 700,
                padding: '1px 6px',
                borderRadius: '4px',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
                lineHeight: '16px',
              }}
            >
              {selectedQuestionLabel}
            </div>
          )}
        </div>
      ))}

      {/* Page number badge */}
      <div className="absolute bottom-3 right-3 bg-black/50 text-white px-2 py-0.5 rounded text-xs pointer-events-none font-medium z-10">
        {pageNumber}
      </div>
    </div>
  );
}

// ─── Main viewer ──────────────────────────────────────────────────────────────
export function AnswerSheetViewer({
  answerSheetDataUrl,
  selectedAnswer,
  pageMetadata,
  zoom,
  currentPage,
  onCurrentPageChange,
  onTotalPagesChange,
  selectedQuestionLabel,
}: Props) {
  const [numPages, setNumPages] = useState<number>(0);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<{ [key: number]: HTMLDivElement | null }>({});
  const isProgrammaticScrollRef = useRef<boolean>(false);

  // Measure container width without margins/padding
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const updateWidth = () => {
      if (el) {
        setContainerWidth(el.clientWidth);
      }
    };
    updateWidth();

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === el) {
          setContainerWidth(el.clientWidth);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Update total pages when document loads
  const handleDocumentLoadSuccess = ({ numPages: total }: { numPages: number }) => {
    setNumPages(total);
    if (onTotalPagesChange) {
      onTotalPagesChange(total);
    }
  };

  // Scroll to START of highlight when selectedAnswer changes
  useEffect(() => {
    if (!selectedAnswer?.regions?.length) return;
    const region = selectedAnswer.regions[0];
    const pageIndex = region.pageIndex;
    const pageEl = pageRefs.current[pageIndex];
    const scrollContainer = scrollContainerRef.current;
    if (!pageEl || !scrollContainer) return;

    isProgrammaticScrollRef.current = true;

    setTimeout(() => {
      const containerRect = scrollContainer.getBoundingClientRect();
      const pageRect = pageEl.getBoundingClientRect();
      const highlightTopInViewport = pageRect.top + region.normalized.y * pageEl.offsetHeight;
      const targetScrollTop = scrollContainer.scrollTop + (highlightTopInViewport - containerRect.top) - 60;
      scrollContainer.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });

      if (onCurrentPageChange) {
        onCurrentPageChange(pageIndex + 1);
      }

      setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 500);
    }, 150);
  }, [selectedAnswer, onCurrentPageChange]);

  // Scroll to page when header page buttons change currentPage
  const prevPageRef = useRef(currentPage);
  useEffect(() => {
    if (!currentPage || currentPage < 1 || currentPage === prevPageRef.current) return;
    prevPageRef.current = currentPage;

    const pageEl = pageRefs.current[currentPage - 1];
    const scrollContainer = scrollContainerRef.current;
    if (!pageEl || !scrollContainer) return;

    isProgrammaticScrollRef.current = true;

    const containerRect = scrollContainer.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    const targetScrollTop = scrollContainer.scrollTop + (pageRect.top - containerRect.top);
    scrollContainer.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });

    setTimeout(() => {
      isProgrammaticScrollRef.current = false;
    }, 500);
  }, [currentPage]);

  // Track active page as user scrolls manually
  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current || !scrollContainerRef.current || numPages <= 1) return;
    const scrollContainer = scrollContainerRef.current;
    const containerTop = scrollContainer.getBoundingClientRect().top;

    let closestPage = 1;
    let minDistance = Infinity;

    for (let i = 0; i < numPages; i++) {
      const pageEl = pageRefs.current[i];
      if (pageEl) {
        const rect = pageEl.getBoundingClientRect();
        // Distance of top of page from top of container viewport
        const dist = Math.abs(rect.top - containerTop);
        // If page is covering top section of container viewport
        if (rect.top <= containerTop + 100 && rect.bottom >= containerTop + 50) {
          closestPage = i + 1;
          break;
        }
        if (dist < minDistance) {
          minDistance = dist;
          closestPage = i + 1;
        }
      }
    }

    if (closestPage !== currentPage && onCurrentPageChange) {
      prevPageRef.current = closestPage;
      onCurrentPageChange(closestPage);
    }
  }, [numPages, currentPage, onCurrentPageChange]);

  // Computed page width based on zoom: 100% fits container width exactly
  const pageWidth = containerWidth > 0
    ? Math.round(containerWidth * (zoom / 100))
    : undefined;

  if (!answerSheetDataUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full text-gray-400 gap-3 bg-white">
        <span className="text-4xl">📄</span>
        <p className="text-sm font-medium">Click a question to highlight its answer</p>
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className="w-full h-full overflow-y-auto overflow-x-auto bg-white m-0 p-0 select-none"
    >
      <Document
        file={answerSheetDataUrl}
        onLoadSuccess={handleDocumentLoadSuccess}
        loading={<div className="flex items-center justify-center p-12 text-gray-400 text-sm">Loading PDF...</div>}
        error={<div className="flex items-center justify-center p-12 text-red-400 text-sm">Failed to load PDF. Try re-uploading.</div>}
      >
        {Array.from({ length: numPages }, (_, i) => (
          <PageWithHighlights
            key={`page_${i}`}
            pageNumber={i + 1}
            pageIndex={i}
            width={pageWidth}
            selectedAnswer={selectedAnswer}
            selectedQuestionLabel={selectedQuestionLabel}
            metadata={pageMetadata[i]}
            pageRef={(el) => { pageRefs.current[i] = el; }}
          />
        ))}
      </Document>
    </div>
  );
}

