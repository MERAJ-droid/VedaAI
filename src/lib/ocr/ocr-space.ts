// NOTE: This file requires Node.js runtime.
// Ensure all API routes that import this file have: export const runtime = 'nodejs'

import sharp from 'sharp';
import type { DocumentOCRProvider } from '@/lib/ocr/provider';
import type { ProcessedPage, OCRBlock, OCRLine, OCRWord, NormalizedBox, BoundingBox } from '@/lib/types';

/** OCR.space API response types */
interface OcrSpaceWord {
  WordText: string;
  Left: number;
  Top: number;
  Height: number;
  Width: number;
}

interface OcrSpaceLine {
  Words?: OcrSpaceWord[];
  LineText: string;
  MaxHeight: number;
  MinTop: number;
}

interface OcrSpaceParsedResult {
  ParsedText: string;
  ErrorMessage: string;
  ErrorDetails: string;
  TextOverlay?: {
    Lines?: OcrSpaceLine[];
    HasOverlay: boolean;
  };
}

interface OcrSpaceResponse {
  ParsedResults?: OcrSpaceParsedResult[];
  IsErroredOnProcessing: boolean;
  ErrorMessage?: string | string[];
  OCRExitCode: number;
}

/**
 * Compress a PNG buffer to stay under the OCR.space 1MB free-tier limit.
 * Reduces quality and/or dimensions until the buffer is under the target size.
 */
async function compressForOCRSpace(
  buffer: Buffer,
  maxBytes: number = 900 * 1024 // 900KB to have some headroom
): Promise<{ buffer: Buffer; width: number; height: number }> {
  let img = sharp(buffer);
  const meta = await img.metadata();
  let width = meta.width || 1000;
  let height = meta.height || 1000;

  // First try: convert to JPEG at 85% quality (much smaller than PNG)
  let compressed = await sharp(buffer)
    .jpeg({ quality: 85 })
    .toBuffer();

  if (compressed.length <= maxBytes) {
    return { buffer: compressed, width, height };
  }

  // Step down quality
  for (const quality of [70, 55, 40]) {
    compressed = await sharp(buffer).jpeg({ quality }).toBuffer();
    if (compressed.length <= maxBytes) {
      return { buffer: compressed, width, height };
    }
  }

  // Resize to reduce dimensions by 50%
  width = Math.round(width * 0.6);
  height = Math.round(height * 0.6);
  compressed = await sharp(buffer)
    .resize(width, height)
    .jpeg({ quality: 70 })
    .toBuffer();

  // Get actual dimensions after resize
  const resizedMeta = await sharp(compressed).metadata();
  width = resizedMeta.width || width;
  height = resizedMeta.height || height;

  return { buffer: compressed, width, height };
}

/**
 * Convert pixel bounding box to normalized (0–1) box.
 */
function pixelToNormalized(
  left: number,
  top: number,
  width: number,
  height: number,
  pageWidth: number,
  pageHeight: number
): NormalizedBox {
  return {
    x: left / pageWidth,
    y: top / pageHeight,
    width: width / pageWidth,
    height: height / pageHeight,
  };
}

/**
 * Send one image to OCR.space and parse the response into a ProcessedPage.
 */
async function callOCRSpace(
  imageBuffer: Buffer,
  imageWidth: number,
  imageHeight: number,
  pageIndex: number,
  apiKey: string,
  engine: number = 3
): Promise<ProcessedPage> {
  const { buffer: compressed, width, height } = await compressForOCRSpace(imageBuffer);

  const formData = new FormData();
  formData.append(
    'base64Image',
    `data:image/jpeg;base64,${compressed.toString('base64')}`
  );
  formData.append('apikey', apiKey);
  formData.append('language', 'eng');
  formData.append('isOverlayRequired', 'true');
  formData.append('OCREngine', String(engine));
  formData.append('scale', 'true');
  formData.append('detectOrientation', 'true');


  const MAX_OCR_ATTEMPTS = 4;
  let response: Response | null = null;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_OCR_ATTEMPTS; attempt++) {
    try {
      const r = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        body: formData,
      });

      // Retry on transient server errors: 502/503 (gateway/overloaded) or 429 (rate limited)
      if (r.status === 502 || r.status === 503 || r.status === 429) {
        const bodyText = await r.text();
        lastError = new Error(`OCR.space HTTP ${r.status}: ${bodyText}`);
        if (attempt < MAX_OCR_ATTEMPTS - 1) {
          const delayMs = 5000 * Math.pow(2, attempt); // 5s, 10s, 20s
          console.warn(
            `[OCR.space] HTTP ${r.status} on attempt ${attempt + 1}/${MAX_OCR_ATTEMPTS}. ` +
            `Retrying in ${delayMs / 1000}s...`
          );
          await new Promise(res => setTimeout(res, delayMs));
          continue;
        }
        throw lastError;
      }

      // Non-retryable HTTP error
      if (!r.ok) {
        throw new Error(`OCR.space HTTP ${r.status}: ${await r.text()}`);
      }

      response = r;
      break;

    } catch (err) {
      // Network-level error (fetch itself threw — e.g. DNS failure, connection refused)
      if (err instanceof Error && (err.message.startsWith('OCR.space HTTP'))) {
        throw err; // already formatted, don't re-wrap
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_OCR_ATTEMPTS - 1) {
        const delayMs = 1000 * Math.pow(2, attempt);
        console.warn(`[OCR.space] Network error on attempt ${attempt + 1}/${MAX_OCR_ATTEMPTS}. Retrying in ${delayMs / 1000}s...`);
        await new Promise(res => setTimeout(res, delayMs));
      }
    }
  }

  if (!response) {
    throw lastError ?? new Error(`Failed to call OCR.space for page ${pageIndex}`);
  }


  const result: OcrSpaceResponse = await response.json();

  if (result.IsErroredOnProcessing) {
    const msg = Array.isArray(result.ErrorMessage)
      ? result.ErrorMessage.join(', ')
      : result.ErrorMessage || 'Unknown OCR error';
    throw new Error(`OCR.space error: ${msg}`);
  }

  const parsedResult = result.ParsedResults?.[0];
  const fullText = parsedResult?.ParsedText ?? '';
  const ocrLines = parsedResult?.TextOverlay?.Lines ?? [];

  // Build OCRWord objects
  const allWords: OCRWord[] = [];
  const lines: OCRLine[] = [];

  for (const ocrLine of ocrLines) {
    if (!ocrLine.Words || ocrLine.Words.length === 0) continue;

    const lineWords: OCRWord[] = ocrLine.Words.map(word => {
      const normalized = pixelToNormalized(word.Left, word.Top, word.Width, word.Height, width, height);
      const bbox: BoundingBox = {
        x: Math.round(word.Left * (imageWidth / width)),
        y: Math.round(word.Top * (imageHeight / height)),
        width: Math.round(word.Width * (imageWidth / width)),
        height: Math.round(word.Height * (imageHeight / height)),
      };
      return {
        text: word.WordText,
        bbox,
        normalized,
        confidence: 0.85, // OCR.space doesn't return per-word confidence; use fixed estimate
      };
    });

    allWords.push(...lineWords);

    // Compute line bounding box from its words
    const lineLeft = Math.min(...ocrLine.Words.map(w => w.Left));
    const lineTop = Math.min(...ocrLine.Words.map(w => w.Top));
    const lineRight = Math.max(...ocrLine.Words.map(w => w.Left + w.Width));
    const lineBottom = Math.max(...ocrLine.Words.map(w => w.Top + w.Height));
    const lineWidth = lineRight - lineLeft;
    const lineHeight = lineBottom - lineTop;

    const normalized = pixelToNormalized(lineLeft, lineTop, lineWidth, lineHeight, width, height);
    const bbox: BoundingBox = {
      x: Math.round(lineLeft * (imageWidth / width)),
      y: Math.round(lineTop * (imageHeight / height)),
      width: Math.round(lineWidth * (imageWidth / width)),
      height: Math.round(lineHeight * (imageHeight / height)),
    };

    lines.push({
      text: ocrLine.LineText,
      bbox,
      normalized,
      words: lineWords,
      confidence: 0.85,
      orientation: 'PAGE_UP',
    });
  }

  // Group lines into blocks by vertical proximity (gap > 2x median line height = new block)
  const blocks: OCRBlock[] = groupLinesIntoBlocks(lines, imageWidth, imageHeight);

  return {
    pageIndex,
    pageNumber: pageIndex + 1,
    width: imageWidth,
    height: imageHeight,
    unit: 'pixels',
    orientation: 'PAGE_UP',
    transforms: undefined, // OCR.space does not preprocess/warp images → identity transform
    blocks,
    lines,
    words: allWords,
    fullText,
  };
}

/**
 * Group OCR lines into paragraph blocks using vertical gap heuristic.
 */
function groupLinesIntoBlocks(
  lines: OCRLine[],
  pageWidth: number,
  pageHeight: number
): OCRBlock[] {
  if (lines.length === 0) return [];

  // Compute median line height
  const heights = lines.map(l => l.normalized.height);
  heights.sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 0.02;

  const blocks: OCRBlock[] = [];
  let currentBlock: OCRLine[] = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prevLine = lines[i - 1];
    const currLine = lines[i];
    const gap = currLine.normalized.y - (prevLine.normalized.y + prevLine.normalized.height);

    if (gap > 2 * medianHeight) {
      // New block
      blocks.push(buildBlock(currentBlock, pageWidth, pageHeight));
      currentBlock = [currLine];
    } else {
      currentBlock.push(currLine);
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(buildBlock(currentBlock, pageWidth, pageHeight));
  }

  return blocks;
}

function buildBlock(lines: OCRLine[], pageWidth: number, pageHeight: number): OCRBlock {
  const text = lines.map(l => l.text).join('\n');

  const minX = Math.min(...lines.map(l => l.normalized.x));
  const minY = Math.min(...lines.map(l => l.normalized.y));
  const maxX = Math.max(...lines.map(l => l.normalized.x + l.normalized.width));
  const maxY = Math.max(...lines.map(l => l.normalized.y + l.normalized.height));

  const normalized: NormalizedBox = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  const bbox: BoundingBox = {
    x: Math.round(minX * pageWidth),
    y: Math.round(minY * pageHeight),
    width: Math.round((maxX - minX) * pageWidth),
    height: Math.round((maxY - minY) * pageHeight),
  };

  const avgConfidence =
    lines.reduce((sum, l) => sum + l.confidence, 0) / lines.length;

  return { text, bbox, normalized, lines, confidence: avgConfidence };
}

/** OCR.space provider implementing DocumentOCRProvider */
class OCRSpaceProvider implements DocumentOCRProvider {
  private apiKey: string;
  private engine: number;

  constructor(options: { engine?: number } = {}) {
    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) {
      throw new Error('OCR_SPACE_API_KEY environment variable is not set');
    }
    this.apiKey = apiKey;
    this.engine = options.engine ?? 3; // Default: Engine 3 (handwriting)
  }

  async processPages(
    images: Array<{ buffer: Buffer; pageIndex: number }>
  ): Promise<ProcessedPage[]> {
    console.log(`[OCRSpace] Processing ${images.length} page images with Engine ${this.engine}`);

    // Always process sequentially — Engine 3 free tier allows only 1 concurrent request
    const results: ProcessedPage[] = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];

      const meta = await sharp(img.buffer).metadata();
      const width = meta.width || 0;
      const height = meta.height || 0;

      const page = await callOCRSpace(
        img.buffer,
        width,
        height,
        img.pageIndex,
        this.apiKey,
        this.engine
      );
      results.push(page);

      console.log(
        `[OCRSpace] Page ${img.pageIndex + 1}: ${page.lines.length} lines, ${page.words.length} words`
      );

      // Delay between pages to stay within rate limits (1.5s for Engine 3, 0.5s for Engine 2)
      if (i < images.length - 1) {
        await new Promise(r => setTimeout(r, this.engine === 3 ? 1500 : 500));
      }
    }

    return results;
  }
}

/**
 * Create an OCR.space provider instance.
 * Requires environment variable:
 * - OCR_SPACE_API_KEY  (get free key at https://ocr.space/OCRAPI)
 *
 * Free tier: 25,000 requests/month, 500/day, 1MB/image, no credit card required.
 * Engine 2 = printed text (fast). Engine 3 = handwriting (slower, 1 concurrent req limit).
 * No image preprocessing/warping → transforms[] is always identity.
 *
 * @param options.engine - OCR engine: 2 for printed text, 3 for handwriting (default: 3)
 */
export function createOCRSpaceProvider(options: { engine?: number } = {}): DocumentOCRProvider {
  return new OCRSpaceProvider(options);
}

