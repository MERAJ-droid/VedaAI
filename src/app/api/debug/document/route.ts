export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { processUploadedFile } from '@/lib/pdf-utils';
import { createOCRSpaceProvider } from '@/lib/ocr/ocr-space';
import { debugSegmentation } from '@/lib/extraction/answer-segmenter';
import { detectLabels } from '@/lib/extraction/label-detector';

/**
 * Development-only debug route for testing the hybrid OCR + Gemini Vision pipeline.
 *
 * POST /api/debug/document
 * FormData fields:
 *   file        — PDF or image of the answer sheet
 *   engine      — "2" (printed) | "3" (handwriting, default)
 *   knownLabels — comma-separated question IDs, e.g. "1,2,3,4,5" (optional)
 *   runVision   — "true" | "false" (default "false")
 *                 If "false": only OCR + regex labels (cheap)
 *                 If "true":  OCR + Gemini Vision + fusion (uses API quota)
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Debug route not available in production' }, { status: 403 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const engineParam = parseInt((formData.get('engine') as string) || '3', 10);
    const engine = (engineParam === 2 ? 2 : 3) as 2 | 3;

    const knownLabelsRaw = ((formData.get('knownLabels') as string) || '').trim();
    const knownQuestionLabels = knownLabelsRaw
      ? knownLabelsRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    const runVision = formData.get('runVision') === 'true';

    // ── OCR ─────────────────────────────────────────────────────────────────
    const buffer = Buffer.from(await file.arrayBuffer());
    const images = await processUploadedFile(buffer, file.type);
    const ocrProvider = createOCRSpaceProvider({ engine });
    const pages = await ocrProvider.processPages(images);

    // Serialize pages (strip large raw data — send only what the UI needs)
    const serializedPages = pages.map(page => ({
      pageIndex: page.pageIndex,
      width: page.width,
      height: page.height,
      orientation: page.orientation,
      fullText: page.fullText,
      lines: page.lines.map(l => ({
        text: l.text,
        confidence: l.confidence,
        normalized: l.normalized,
      })),
    }));

    // ── OCR-only mode ────────────────────────────────────────────────────────
    if (!runVision) {
      const ocrLabels = pages.flatMap(page =>
        detectLabels(page.lines, page.pageIndex, knownQuestionLabels)
      );

      return NextResponse.json({
        pageCount: pages.length,
        pages: serializedPages,
        ocrLabels: ocrLabels.map(l => ({
          normalizedLabel: l.normalizedLabel,
          displayLabel: l.displayLabel,
          confidence: l.confidence,
          pageIndex: l.pageIndex,
          normalized: l.normalized,
          rawText: l.rawText,
        })),
        geminiLabels: null,
        boundaries: null,
      });
    }

    // ── Hybrid mode: OCR + Gemini Vision + fusion ─────────────────────────────
    const { ocrLabels, geminiLabels, boundaries } = await debugSegmentation(
      pages,
      knownQuestionLabels,
      images          // PageImage[] — enables Gemini Vision
    );

    return NextResponse.json({
      pageCount: pages.length,
      pages: serializedPages,
      ocrLabels: ocrLabels.map(l => ({
        normalizedLabel: l.normalizedLabel,
        displayLabel: l.displayLabel,
        confidence: l.confidence,
        pageIndex: l.pageIndex,
        normalized: l.normalized,
        rawText: l.rawText,
      })),
      geminiLabels,
      boundaries,
    });
  } catch (error) {
    console.error('[debug/document] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
