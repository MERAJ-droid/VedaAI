import { BoundingBox, NormalizedBox, NormalizedPolygon, AlignmentResult } from '@/lib/types';

/**
 * Convert 4-vertex normalized polygon (from Document AI normalizedVertices)
 * to an axis-aligned NormalizedBox.
 * Takes min/max of x and y across all 4 vertices.
 */
export function polygonToNormalizedBox(
  vertices: Array<{ x: number; y: number }>
): NormalizedBox {
  if (!vertices || vertices.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const xs = vertices.map(v => v.x ?? 0);
  const ys = vertices.map(v => v.y ?? 0);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Convert NormalizedBox (0–1 range) to pixel BoundingBox given page dimensions.
 */
export function normalizedToBBox(
  normalized: NormalizedBox,
  pageWidth: number,
  pageHeight: number
): BoundingBox {
  return {
    x: Math.round(normalized.x * pageWidth),
    y: Math.round(normalized.y * pageHeight),
    width: Math.round(normalized.width * pageWidth),
    height: Math.round(normalized.height * pageHeight),
  };
}

/**
 * Union multiple BoundingBoxes into one enclosing box.
 * Returns the smallest axis-aligned box that contains all input boxes.
 */
export function unionBBoxes(boxes: BoundingBox[]): BoundingBox {
  if (boxes.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Union multiple NormalizedBoxes into one enclosing box.
 */
export function unionNormalizedBoxes(boxes: NormalizedBox[]): NormalizedBox {
  if (boxes.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Check whether Page.transforms[] represents a trivial (identity) transform.
 * Document AI stores transforms as OpenCV-format matrices.
 * An empty array or a 3x3 identity matrix means no preprocessing was applied.
 */
export function isIdentityTransform(transforms: unknown[]): boolean {
  if (!transforms || transforms.length === 0) {
    return true;
  }
  // If transforms exist, we conservatively treat them as non-trivial.
  // A more sophisticated check could decode the base64 matrix data
  // and verify it's an identity matrix, but for MVP we flag any
  // non-empty transforms array as requiring attention.
  return false;
}

/**
 * Align OCR coordinates to the displayed page surface.
 *
 * Checks Page.transforms[] — if empty/identity, returns coords unchanged.
 * If non-trivial transform exists, flags that Page.image should be used
 * as display surface (Option A) since inverse-transform computation
 * requires decoding OpenCV matrices.
 *
 * @param normalized - The NormalizedBox from Document AI
 * @param transforms - Page.transforms[] from the Document AI response
 * @param pageOrientation - Layout.orientation enum value
 * @returns AlignmentResult with aligned coordinates and fallback flag
 */
export function alignToDisplayPage(
  normalized: NormalizedBox,
  transforms: unknown[],
  pageOrientation: string
): AlignmentResult {
  const isIdentity = isIdentityTransform(transforms);

  if (isIdentity) {
    // No preprocessing was applied — coordinates map directly
    return {
      aligned: { ...normalized },
      useFallbackImage: false,
    };
  }

  // Non-trivial transform detected.
  // For MVP: flag that we should use the preprocessed Page.image
  // instead of the original PDF page for display.
  // The coordinates are correct relative to the preprocessed image.
  return {
    aligned: { ...normalized },
    useFallbackImage: true,
  };
}

/**
 * Convert canonical NormalizedBox (post-alignment, 0–1) to rendered pixel
 * position for overlay on a PDF.js or image viewer.
 */
export function normalizedToRendered(
  normalized: NormalizedBox,
  renderedWidth: number,
  renderedHeight: number
): { x: number; y: number; width: number; height: number } {
  return {
    x: normalized.x * renderedWidth,
    y: normalized.y * renderedHeight,
    width: normalized.width * renderedWidth,
    height: normalized.height * renderedHeight,
  };
}

/**
 * Compute weighted average OCR confidence across multiple lines,
 * weighted by each line's text length (character count).
 * Lines with more text contribute proportionally more to the average.
 */
export function computeWeightedOCRConfidence(
  lines: Array<{ text: string; confidence: number }>
): number {
  if (lines.length === 0) return 0;

  let totalWeight = 0;
  let weightedSum = 0;

  for (const line of lines) {
    const weight = line.text.length;
    if (weight > 0) {
      weightedSum += line.confidence * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
}
