// NOTE: This file requires Node.js runtime (not Edge).
// Ensure all API routes that import this file have: export const runtime = 'nodejs'

import {
  DocumentProcessorServiceClient,
  protos,
} from '@google-cloud/documentai';
import type { DocumentOCRProvider } from '@/lib/ocr/provider';
import type { ProcessedPage, OCRBlock, OCRLine, OCRWord, NormalizedBox, BoundingBox } from '@/lib/types';
import {
  polygonToNormalizedBox,
  normalizedToBBox,
  alignToDisplayPage,
} from '@/lib/ocr/coordinate-utils';

type IDocument = protos.google.cloud.documentai.v1.IDocument;
type IPage = protos.google.cloud.documentai.v1.Document.IPage;
type ITextAnchor = protos.google.cloud.documentai.v1.Document.ITextAnchor;
type ILayout = protos.google.cloud.documentai.v1.Document.Page.ILayout;

/** Extract text from a textAnchor using the master text string */
function getText(
  textAnchor: ITextAnchor | null | undefined,
  fullText: string
): string {
  if (!textAnchor?.textSegments?.length) return '';
  return textAnchor.textSegments
    .map(seg => {
      const start = Number(seg.startIndex || 0);
      const end = Number(seg.endIndex || 0);
      return fullText.substring(start, end);
    })
    .join('');
}

/** Extract NormalizedBox from a Layout's boundingPoly */
function extractNormalized(layout: ILayout | null | undefined): NormalizedBox {
  const vertices = layout?.boundingPoly?.normalizedVertices;
  if (!vertices || vertices.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return polygonToNormalizedBox(
    vertices.map(v => ({ x: v.x ?? 0, y: v.y ?? 0 }))
  );
}

/** Get orientation string from a Layout */
function getOrientation(layout: ILayout | null | undefined): string {
  const orientation = layout?.orientation;
  if (!orientation) return 'PAGE_UP';
  // orientation may be a number (enum) or string
  if (typeof orientation === 'number') {
    const map: Record<number, string> = {
      0: 'ORIENTATION_UNSPECIFIED',
      1: 'PAGE_UP',
      2: 'PAGE_RIGHT',
      3: 'PAGE_DOWN',
      4: 'PAGE_LEFT',
    };
    return map[orientation] ?? 'PAGE_UP';
  }
  return String(orientation);
}

/** Parse a single Document AI page into a ProcessedPage */
function parsePage(
  page: IPage,
  fullText: string,
  pageIndexOverride: number
): ProcessedPage {
  const pageNumber = page.pageNumber ?? pageIndexOverride + 1;
  const pageIndex = pageIndexOverride;
  const width = page.dimension?.width ?? 0;
  const height = page.dimension?.height ?? 0;
  const unit = page.dimension?.unit ?? 'pixels';
  const orientation = getOrientation(page.layout);
  const transforms = (page.transforms as unknown[]) ?? [];

  // Parse tokens (words)
  const words: OCRWord[] = (page.tokens ?? []).map(token => {
    const text = getText(token.layout?.textAnchor, fullText).trim();
    const normalized = extractNormalized(token.layout);
    const bbox = normalizedToBBox(normalized, width, height);
    const confidence = token.layout?.confidence ?? 0;
    return { text, bbox, normalized, confidence };
  });

  // Parse lines
  const lines: OCRLine[] = (page.lines ?? []).map(line => {
    const text = getText(line.layout?.textAnchor, fullText);
    const normalized = extractNormalized(line.layout);
    const bbox = normalizedToBBox(normalized, width, height);
    const confidence = line.layout?.confidence ?? 0;
    const lineOrientation = getOrientation(line.layout);

    // Associate words that overlap with this line's vertical range
    const lineWords = words.filter(w => {
      const wMidY = w.normalized.y + w.normalized.height / 2;
      const lineTop = normalized.y;
      const lineBottom = normalized.y + normalized.height;
      return wMidY >= lineTop - 0.01 && wMidY <= lineBottom + 0.01;
    });

    return { text, bbox, normalized, words: lineWords, confidence, orientation: lineOrientation };
  });

  // Parse blocks
  const blocks: OCRBlock[] = (page.blocks ?? []).map(block => {
    const text = getText(block.layout?.textAnchor, fullText);
    const normalized = extractNormalized(block.layout);
    const bbox = normalizedToBBox(normalized, width, height);
    const confidence = block.layout?.confidence ?? 0;

    // Associate lines that overlap with this block's bounding box
    const blockLines = lines.filter(l => {
      const lMidY = l.normalized.y + l.normalized.height / 2;
      const lMidX = l.normalized.x + l.normalized.width / 2;
      return (
        lMidY >= normalized.y - 0.01 &&
        lMidY <= normalized.y + normalized.height + 0.01 &&
        lMidX >= normalized.x - 0.01 &&
        lMidX <= normalized.x + normalized.width + 0.01
      );
    });

    return { text, bbox, normalized, lines: blockLines, confidence };
  });

  const fullTextPage = page.lines
    ? lines.map(l => l.text).join('\n')
    : getText(page.layout?.textAnchor, fullText);

  return {
    pageIndex,
    pageNumber,
    width,
    height,
    unit,
    orientation,
    transforms: transforms.length > 0 ? transforms : undefined,
    blocks,
    lines,
    words,
    fullText: fullTextPage,
  };
}

/** Google Document AI provider implementation */
class GoogleDocumentAIProvider implements DocumentOCRProvider {
  private client: DocumentProcessorServiceClient;
  private processorName: string;

  constructor() {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const location = process.env.GOOGLE_CLOUD_LOCATION || 'us';
    const processorId = process.env.DOCUMENT_AI_PROCESSOR_ID;
    const credentialsBase64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;

    if (!projectId || !processorId || !credentialsBase64) {
      throw new Error(
        'Missing required env vars: GOOGLE_CLOUD_PROJECT_ID, DOCUMENT_AI_PROCESSOR_ID, GOOGLE_APPLICATION_CREDENTIALS_BASE64'
      );
    }

    const credentials = JSON.parse(
      Buffer.from(credentialsBase64, 'base64').toString('utf-8')
    );

    const apiEndpoint = `${location}-documentai.googleapis.com`;
    this.client = new DocumentProcessorServiceClient({
      apiEndpoint,
      credentials,
    });

    this.processorName = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  }

  async processPages(
    images: Array<{ buffer: Buffer; pageIndex: number }>
  ): Promise<ProcessedPage[]> {
    console.log(`[DocumentAI] Processing ${images.length} page images`);

    // Process with concurrency limit of 5 to avoid rate limits
    const CONCURRENCY = 5;
    const results: ProcessedPage[] = [];

    for (let i = 0; i < images.length; i += CONCURRENCY) {
      const batch = images.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(img => this.processSinglePage(img))
      );
      results.push(...batchResults);
    }

    // Sort by pageIndex
    results.sort((a, b) => a.pageIndex - b.pageIndex);
    console.log(`[DocumentAI] Processed ${results.length} pages successfully`);
    return results;
  }

  private async processSinglePage(img: {
    buffer: Buffer;
    pageIndex: number;
  }): Promise<ProcessedPage> {
    const request = {
      name: this.processorName,
      rawDocument: {
        content: img.buffer.toString('base64'),
        mimeType: 'image/png',
      },
    };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [result] = await this.client.processDocument(request);
        const document = result.document as IDocument;

        if (!document) {
          throw new Error('Document AI returned no document');
        }

        const fullText = document.text ?? '';
        const pages = document.pages ?? [];

        if (pages.length === 0) {
          // Return empty page
          return {
            pageIndex: img.pageIndex,
            pageNumber: img.pageIndex + 1,
            width: 0,
            height: 0,
            unit: 'pixels',
            orientation: 'PAGE_UP',
            blocks: [],
            lines: [],
            words: [],
            fullText: '',
          };
        }

        // Each image = one page in Document AI
        return parsePage(pages[0], fullText, img.pageIndex);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(
          `[DocumentAI] Attempt ${attempt + 1} failed for page ${img.pageIndex}:`,
          lastError.message
        );
        if (attempt < 2) {
          // Exponential backoff: 1s, 2s
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError ?? new Error(`Failed to process page ${img.pageIndex}`);
  }
}

/**
 * Create a Google Document AI provider instance.
 * Requires environment variables:
 * - GOOGLE_CLOUD_PROJECT_ID
 * - GOOGLE_CLOUD_LOCATION (default: 'us')
 * - DOCUMENT_AI_PROCESSOR_ID
 * - GOOGLE_APPLICATION_CREDENTIALS_BASE64
 */
export function createGoogleDocumentAIProvider(): DocumentOCRProvider {
  return new GoogleDocumentAIProvider();
}

