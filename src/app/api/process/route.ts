export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { processUploadedFile } from '@/lib/pdf-utils';
import { createOCRSpaceProvider } from '@/lib/ocr/ocr-space';
import { extractQuestions } from '@/lib/extraction/question-extractor';
import { segmentAnswers } from '@/lib/extraction/answer-segmenter';
import { mapAnswersToQuestions } from '@/lib/mapping/mapping-engine';
import { validateMappings } from '@/lib/mapping/validator';
import { gradeAllAnswers, generateOverallSummary } from '@/lib/grading/grader';
import type { ProcessingResult, PageMetadata } from '@/lib/types';

/** Max file size: 40 MB (Document AI sync limit) */
const MAX_FILE_SIZE = 40 * 1024 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  console.log('[api/process] Starting processing pipeline');

  try {
    // ----------------------------------------------------------------
    // Step 1: Parse and validate uploaded files
    // ----------------------------------------------------------------
    const formData = await request.formData();
    const questionPaperFile = formData.get('questionPaper') as File | null;
    const answerSheetFile = formData.get('answerSheet') as File | null;
    const enableGrading = true; // Always run AI grading

    if (!questionPaperFile || !answerSheetFile) {
      return NextResponse.json(
        { error: 'Both questionPaper and answerSheet files are required.' },
        { status: 400 }
      );
    }

    if (questionPaperFile.size > MAX_FILE_SIZE || answerSheetFile.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `Files must be under 40 MB. Document AI sync processing limit.` },
        { status: 400 }
      );
    }

    const [qpBuffer, asBuffer] = await Promise.all([
      questionPaperFile.arrayBuffer().then(ab => Buffer.from(ab)),
      answerSheetFile.arrayBuffer().then(ab => Buffer.from(ab)),
    ]);

    // ----------------------------------------------------------------
    // Step 2: Convert PDFs/images to page images
    // ----------------------------------------------------------------
    console.log('[api/process] Step 2: Converting documents to images');
    const [qpImages, asImages] = await Promise.all([
      processUploadedFile(qpBuffer, questionPaperFile.type),
      processUploadedFile(asBuffer, answerSheetFile.type),
    ]);

    // ----------------------------------------------------------------
    // Step 3: OCR all pages via OCR.space
    // OCR.space free tier: 1 concurrent Engine 3 request — process sequentially.
    // Question paper is printed text → Engine 2 (faster, no concurrency issues)
    // Answer sheet is handwritten → Engine 3
    // ----------------------------------------------------------------
    console.log(`[api/process] Step 3: OCR — ${qpImages.length} QP pages, ${asImages.length} AS pages`);
    const qpOCR = createOCRSpaceProvider({ engine: 2 }); // printed text
    const asOCR = createOCRSpaceProvider({ engine: 3 }); // handwriting

    console.log('[api/process] OCR: processing question paper...');
    const qpPages = await qpOCR.processPages(qpImages);

    console.log('[api/process] OCR: processing answer sheet...');
    const asPages = await asOCR.processPages(asImages);

    // Build page metadata for the frontend (no OCR primitives)
    const answerSheetPageMetadata: PageMetadata[] = asPages.map(p => ({
      pageIndex: p.pageIndex,
      width: p.width,
      height: p.height,
      unit: p.unit,
      orientation: p.orientation,
    }));

    // ----------------------------------------------------------------
    // Step 4: Extract questions from question paper
    // ----------------------------------------------------------------
    console.log('[api/process] Step 4: Extracting questions');
    const questions = await extractQuestions(qpPages);

    if (questions.length === 0) {
      return NextResponse.json(
        { error: 'No questions could be extracted from the question paper. Please check the file quality.' },
        { status: 422 }
      );
    }

    console.log(`[api/process] Extracted ${questions.length} questions`);

    // ----------------------------------------------------------------
    // Step 5: Segment answer regions from answer sheet
    // ----------------------------------------------------------------
    console.log('[api/process] Step 5: Segmenting answer regions');
    const knownQuestionLabels = questions.map(q => q.id);
    // Pass asImages so the hybrid Gemini Vision + OCR fusion pipeline can run.
    // Gemini Vision identifies boundary labels semantically; OCR geometry is authoritative.
    const answers = await segmentAnswers(asPages, knownQuestionLabels, questions, asImages);



    console.log(`[api/process] Segmented ${answers.length} answers`);

    // ----------------------------------------------------------------
    // Step 6: Map answers to questions
    // ----------------------------------------------------------------
    console.log('[api/process] Step 6: Mapping answers to questions');
    const { mappings, unmatchedAnswers, unansweredQuestions } =
      await mapAnswersToQuestions(questions, answers);

    // ----------------------------------------------------------------
    // Step 7: Validate mappings
    // ----------------------------------------------------------------
    console.log('[api/process] Step 7: Validating mappings');
    const validation = validateMappings({ questions, answers, mappings, unmatchedAnswers, unansweredQuestions });
    if (validation.errors.length > 0) {
      console.error('[api/process] Validation errors:', validation.errors);
    }
    if (validation.warnings.length > 0) {
      console.warn('[api/process] Validation warnings:', validation.warnings);
    }

    // ----------------------------------------------------------------
    // Step 8: Optional grading
    // ----------------------------------------------------------------
    let gradingResults;
    let overallSummary;

    if (enableGrading) {
      console.log('[api/process] Step 8: Grading answers');
      gradingResults = await gradeAllAnswers(questions, answers, mappings);
      overallSummary = await generateOverallSummary(questions, gradingResults);
    }

    // ----------------------------------------------------------------
    // Step 9: Build final result (strip OCR primitives)
    // ----------------------------------------------------------------
    const result: ProcessingResult = {
      questions,
      answers,  // answers include regions + confidence, but NOT raw OCR lines
      mappings,
      unmatchedAnswers,
      unansweredQuestions,
      pageMetadata: answerSheetPageMetadata,
      ...(gradingResults && { gradingResults }),
      ...(overallSummary && { overallSummary }),
    };

    console.log('[api/process] Pipeline complete. Returning result.');
    return NextResponse.json(result);

  } catch (error) {
    console.error('[api/process] Pipeline error:', error);

    const message = error instanceof Error ? error.message : String(error);

    // Distinguish known error types
    if (message.includes('GEMINI_API_KEY')) {
      return NextResponse.json({ error: 'Gemini API key not configured.' }, { status: 500 });
    }
    if (message.includes('OCR_SPACE_API_KEY')) {
      return NextResponse.json({ error: 'OCR.space API key not configured.' }, { status: 500 });
    }
    // OCR.space free tier overloaded/gateway error — transient, user should retry
    if (message.includes('503') || message.includes('502') || message.includes('E571') || message.includes('overloaded') || message.includes('throttled')) {
      return NextResponse.json(
        { error: 'The OCR service is temporarily overloaded. Please wait 2–3 minutes and try again.' },
        { status: 503 }
      );
    }
    if (message.includes('OCR.space HTTP 429') || message.includes('Rate limit')) {
      return NextResponse.json(
        { error: 'OCR rate limit reached. Please wait a moment and try again.' },
        { status: 429 }
      );
    }
    if (message.includes('OCR.space error') || message.includes('OCR.space HTTP')) {
      return NextResponse.json({ error: `OCR failed: ${message}` }, { status: 500 });
    }
    if (message.includes('quota') || message.includes('RESOURCE_EXHAUSTED')) {
      return NextResponse.json({ error: 'API quota exceeded. Please try again later.' }, { status: 429 });
    }

    return NextResponse.json(
      { error: `Processing failed: ${message}` },
      { status: 500 }
    );
  }
}

