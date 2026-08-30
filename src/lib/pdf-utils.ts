import { pdf } from 'pdf-to-img';
import sharp from 'sharp';
import type { PageImage } from '@/lib/types';

/**
 * Convert a PDF buffer to an array of page images (PNG).
 * Uses pdf-to-img for PDF rendering and sharp for image processing.
 *
 * @param pdfBuffer - The raw PDF file buffer
 * @param dpi - Target DPI for rendering (default: 200)
 * @returns Array of PageImage objects with buffer, dimensions, and page index
 */
export async function pdfToImages(
  pdfBuffer: Buffer,
  dpi: number = Number(process.env.OCR_TARGET_DPI || 200)
): Promise<PageImage[]> {
  const pages: PageImage[] = [];

  try {
    const pdfPages = await pdf(pdfBuffer, {
      scale: dpi / 72, // pdf-to-img uses scale factor relative to 72 DPI
    });

    let pageIndex = 0;
    for await (const pageBuffer of pdfPages) {
      const imgBuffer = Buffer.from(pageBuffer);
      const metadata = await sharp(imgBuffer).metadata();

      pages.push({
        buffer: imgBuffer,
        width: metadata.width || 0,
        height: metadata.height || 0,
        pageIndex,
      });

      pageIndex++;
    }
  } catch (error) {
    throw new Error(
      `Failed to convert PDF to images: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (pages.length === 0) {
    throw new Error('PDF contains no pages');
  }

  console.log(`[pdf-utils] Converted PDF to ${pages.length} page images at ${dpi} DPI`);
  return pages;
}

/**
 * Process an uploaded image file (not PDF) into a PageImage.
 * Reads dimensions via sharp.
 *
 * @param imageBuffer - The raw image file buffer
 * @param pageIndex - The page index (0 for single images)
 * @returns PageImage object
 */
export async function imageToPageImage(
  imageBuffer: Buffer,
  pageIndex: number = 0
): Promise<PageImage> {
  const metadata = await sharp(imageBuffer).metadata();

  // Convert to PNG for consistent format
  const pngBuffer = await sharp(imageBuffer).png().toBuffer();

  return {
    buffer: pngBuffer,
    width: metadata.width || 0,
    height: metadata.height || 0,
    pageIndex,
  };
}

/**
 * Detect whether a buffer is a PDF based on magic bytes.
 */
export function isPDF(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString() === '%PDF-';
}

/**
 * Get MIME type from a buffer by checking magic bytes.
 */
export function detectMimeType(buffer: Buffer): string {
  if (isPDF(buffer)) return 'application/pdf';

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // TIFF: 49 49 or 4D 4D
  if ((buffer[0] === 0x49 && buffer[1] === 0x49) || (buffer[0] === 0x4d && buffer[1] === 0x4d)) {
    return 'image/tiff';
  }
  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }
  // GIF: 47 49 46
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif';
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }

  return 'application/octet-stream';
}

/**
 * Process uploaded files (PDF or images) into PageImage arrays.
 * Handles both PDFs (multi-page) and individual images.
 *
 * @param buffer - The uploaded file buffer
 * @param mimeType - The MIME type of the file (optional, auto-detected if not provided)
 * @returns Array of PageImage objects
 */
export async function processUploadedFile(
  buffer: Buffer,
  mimeType?: string
): Promise<PageImage[]> {
  const detectedType = mimeType || detectMimeType(buffer);

  if (detectedType === 'application/pdf') {
    return pdfToImages(buffer);
  }

  // Single image
  const pageImage = await imageToPageImage(buffer, 0);
  return [pageImage];
}

