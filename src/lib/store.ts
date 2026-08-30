import { create } from 'zustand';
import type {
  ProcessingResult,
  Question,
  Answer,
  AnswerMapping,
  UnmatchedAnswer,
} from '@/lib/types';

/** Stages displayed during processing (client-side, timed progression) */
export type ProcessingStage =
  | 'idle'
  | 'uploading'
  | 'converting'
  | 'ocr'
  | 'extracting_questions'
  | 'segmenting_answers'
  | 'mapping'
  | 'grading'
  | 'done'
  | 'error';

export const STAGE_LABELS: Record<ProcessingStage, string> = {
  idle: '',
  uploading: 'Uploading documents...',
  converting: 'Converting documents to images...',
  ocr: 'Running OCR (Document AI)...',
  extracting_questions: 'Extracting questions...',
  segmenting_answers: 'Segmenting answer regions...',
  mapping: 'Mapping answers to questions...',
  grading: 'Grading responses...',
  done: 'Processing complete!',
  error: 'An error occurred.',
};

interface AppState {
  // Upload state
  questionPaperFile: File | null;
  answerSheetFile: File | null;

  // Processing state
  processingStage: ProcessingStage;
  errorMessage: string | null;

  // Results state
  result: ProcessingResult | null;

  // Selection state (for the results view)
  selectedQuestionId: string | null;
  selectedUnmatchedAnswerId: string | null;

  // Actions - Upload
  setQuestionPaperFile: (file: File | null) => void;
  setAnswerSheetFile: (file: File | null) => void;

  // Actions - Processing
  setProcessingStage: (stage: ProcessingStage) => void;
  setError: (message: string) => void;
  clearError: () => void;

  // Actions - Results
  setResult: (result: ProcessingResult) => void;
  clearResult: () => void;

  // Actions - Selection
  selectQuestion: (questionId: string | null) => void;
  selectUnmatchedAnswer: (answerId: string | null) => void;

  // Computed getters
  getSelectedQuestion: () => Question | null;
  getSelectedAnswer: () => Answer | null;
  getSelectedMapping: () => AnswerMapping | null;
  getSelectedUnmatchedAnswer: () => UnmatchedAnswer | null;

  // Reset
  reset: () => void;
}

const initialState = {
  questionPaperFile: null,
  answerSheetFile: null,
  processingStage: 'idle' as ProcessingStage,
  errorMessage: null,
  result: null,
  selectedQuestionId: null,
  selectedUnmatchedAnswerId: null,
};

export const useAppStore = create<AppState>((set, get) => ({
  ...initialState,

  // Upload actions
  setQuestionPaperFile: (file) => set({ questionPaperFile: file }),
  setAnswerSheetFile: (file) => set({ answerSheetFile: file }),

  // Processing actions
  setProcessingStage: (stage) => set({ processingStage: stage }),
  setError: (message) => set({ errorMessage: message, processingStage: 'error' }),
  clearError: () => set({ errorMessage: null }),

  // Result actions
  setResult: (result) => set({ result, processingStage: 'done' }),
  clearResult: () => set({ result: null }),

  // Selection actions
  selectQuestion: (questionId) =>
    set({ selectedQuestionId: questionId, selectedUnmatchedAnswerId: null }),
  selectUnmatchedAnswer: (answerId) =>
    set({ selectedUnmatchedAnswerId: answerId, selectedQuestionId: null }),

  // Computed getters
  getSelectedQuestion: () => {
    const { result, selectedQuestionId } = get();
    if (!result || !selectedQuestionId) return null;
    return result.questions.find((q) => q.id === selectedQuestionId) || null;
  },

  getSelectedAnswer: () => {
    const { result, selectedQuestionId } = get();
    if (!result || !selectedQuestionId) return null;
    const mapping = result.mappings.find((m) => m.questionId === selectedQuestionId);
    if (!mapping || !mapping.answerId) return null;
    return result.answers.find((a) => a.id === mapping.answerId) || null;
  },

  getSelectedMapping: () => {
    const { result, selectedQuestionId } = get();
    if (!result || !selectedQuestionId) return null;
    return result.mappings.find((m) => m.questionId === selectedQuestionId) || null;
  },

  getSelectedUnmatchedAnswer: () => {
    const { result, selectedUnmatchedAnswerId } = get();
    if (!result || !selectedUnmatchedAnswerId) return null;
    return (
      result.unmatchedAnswers.find(
        (ua) => ua.answer.id === selectedUnmatchedAnswerId
      ) || null
    );
  },

  // Reset
  reset: () => set(initialState),
}));

