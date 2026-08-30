// ============================================================
// OCR Layer Types (from Document AI)
// ============================================================

/** 4-vertex polygon as returned by Document AI normalizedVertices */
export interface NormalizedPolygon {
  vertices: Array<{ x: number; y: number }>; // 4 points, 0.0–1.0, Y from top
}

/** Axis-aligned bounding box (computed from polygon) */
export interface BoundingBox {
  x: number;      // left edge (pixels)
  y: number;      // top edge (pixels)
  width: number;
  height: number;
}

/** Normalized axis-aligned bounding box (0.0–1.0) */
export interface NormalizedBox {
  x: number;      // 0.0 – 1.0 relative to page width
  y: number;      // 0.0 – 1.0 relative to page height
  width: number;  // 0.0 – 1.0
  height: number; // 0.0 – 1.0
}

export interface OCRWord {
  text: string;
  bbox: BoundingBox;
  normalized: NormalizedBox;
  confidence: number;       // layout.confidence [0, 1]
}

export interface OCRLine {
  text: string;
  bbox: BoundingBox;
  normalized: NormalizedBox;
  words: OCRWord[];
  confidence: number;       // layout.confidence [0, 1]
  orientation: string;      // Layout.orientation enum value
}

export interface OCRBlock {
  text: string;
  bbox: BoundingBox;
  normalized: NormalizedBox;
  lines: OCRLine[];         // lines within this block
  confidence: number;
}

export interface ProcessedPage {
  pageIndex: number;          // 0-based
  pageNumber: number;         // 1-based (from Document AI)
  width: number;              // dimension.width
  height: number;             // dimension.height
  unit: string;               // dimension.unit (e.g., "pixels")
  orientation: string;        // page-level layout.orientation
  transforms?: unknown[];     // Page.transforms[] (stored for alignment)
  blocks: OCRBlock[];
  lines: OCRLine[];
  words: OCRWord[];
  fullText: string;           // concatenated page text
}

// ============================================================
// Application Layer Types
// ============================================================

export interface MCQOption {
  label: string;   // 'A', 'B', 'C', or 'D'
  text: string;    // Option body text
}

export interface Question {
  id: string;                  // e.g., "11a", "11b", "12"
  number: string;              // Original label: "11 (a)"
  text: string;                // Question stem (for MCQ: stem only, no options)
  type?: 'mcq' | 'subjective' | 'short_answer'; // undefined → treat as subjective
  options?: MCQOption[];       // Populated only when type === 'mcq'
  marks?: number;              // Max marks if printed on paper
  parentNumber?: string;       // "11" for sub-parts
  pageIndex: number;           // Source page in question paper
  verticalPosition: number;    // normalized Y for deterministic ordering
}

export interface AnswerRegion {
  pageIndex: number;
  bbox: BoundingBox;           // Pixel coords
  normalized: NormalizedBox;   // 0–1 coords (canonical, post-alignment)
}

export interface Answer {
  id: string;
  studentLabel: string | null;       // What the student wrote as question number
  rawStudentLabel: string | null;    // Raw OCR text before normalization
  text: string;                      // Full extracted answer text
  selectedOption?: string;           // For MCQ: 'A', 'B', 'C', or 'D' (uppercase)
  regions: AnswerRegion[];           // Can span multiple pages
  ocrConfidence: number;             // Weighted average OCR confidence (weighted by line char count)
  segmentationConfidence: number;    // How confidently the app believes these blocks form one answer
}

export interface AnswerMapping {
  questionId: string;
  answerId: string | null;       // null = unanswered
  confidence: number;            // 0.0 – 1.0
  confidenceLevel: 'high' | 'medium' | 'low';
  reasons: MappingReason[];
}

export type MappingReason =
  | 'exact_label'
  | 'fuzzy_label'
  | 'semantic_match'
  | 'contextual_match'
  | 'parent_to_child'
  | 'llm_reasoning';

export interface UnmatchedAnswer {
  answer: Answer;
  candidateQuestionId?: string;    // Best-guess question if any
  candidateConfidence?: number;
  candidateReason?: string;        // Why it was not auto-mapped
}

export interface GradingResult {
  questionId: string;
  answerId: string | null;
  score: number | null;
  maxScore: number | null;
  status: 'correct' | 'partial' | 'incorrect' | 'unanswered';
  aiFeedback: string;
}

export interface PageMetadata {
  pageIndex: number;
  width: number;
  height: number;
  unit: string;
  orientation: string;
}

export interface ProcessingResult {
  questions: Question[];
  answers: Answer[];
  mappings: AnswerMapping[];
  unmatchedAnswers: UnmatchedAnswer[];
  unansweredQuestions: Question[];
  gradingResults?: GradingResult[];
  overallSummary?: OverallSummary;
  pageMetadata: PageMetadata[];
}

export interface OverallSummary {
  totalScore: number;
  maxScore: number;
  percentage: number;
  overallFeedback: string;
}

// ============================================================
// Label Detection Types
// ============================================================

export interface DetectedLabel {
  rawText: string;           // Raw OCR text: "l1(a)"
  normalizedLabel: string;   // Normalized: "11a"
  displayLabel: string;      // Display format: "11 (a)"
  confidence: number;        // Detection confidence
  pageIndex: number;
  bbox: BoundingBox;
  normalized: NormalizedBox;
  lineIndex: number;         // Which OCR line this was found in
}

// ============================================================
// Processing Pipeline Types
// ============================================================

export interface PageImage {
  buffer: Buffer;
  width: number;
  height: number;
  pageIndex: number;
}

export interface AlignmentResult {
  aligned: NormalizedBox;
  useFallbackImage: boolean;
}

// ============================================================
// Confidence Configuration
// ============================================================

export interface ConfidenceThresholds {
  high: number;    // >= this = high confidence (default: 0.85)
  medium: number;  // >= this = medium confidence (default: 0.5)
  // below medium = low confidence
}

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  high: 0.85,
  medium: 0.5,
};

/** Compute confidence level from a numeric confidence value */
export function getConfidenceLevel(
  confidence: number,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS
): 'high' | 'medium' | 'low' {
  if (confidence >= thresholds.high) return 'high';
  if (confidence >= thresholds.medium) return 'medium';
  return 'low';
}
