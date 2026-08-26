import { ProcessedPage, PageImage } from '@/lib/types';

/**
 * Abstract interface for document OCR providers.
 * Only dedicated OCR/document-layout services implement this interface.
 * Gemini does NOT implement it — Gemini is used for semantic interpretation only.
 */
export interface DocumentOCRProvider {
  /**
   * Process a batch of page images through OCR.
   * Returns structured page data with text, bounding boxes, and confidence scores.
   *
   * @param images - Array of page images with their buffers and indices
   * @returns ProcessedPage[] with blocks, lines, words, and spatial data
   */
  processPages(
    images: Array<{ buffer: Buffer; pageIndex: number }>,
  ): Promise<ProcessedPage[]>;
}
