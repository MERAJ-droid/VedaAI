# Veda AI — Automated Exam Grading Pipeline

> Upload a question paper and a handwritten answer sheet. Veda AI extracts every question, segments every answer, maps them together, highlights the exact regions on the original scan, and grades each response with AI-generated feedback — all in one click.

**🔗 Live Demo:** `https://vedaai-p7ko.onrender.com`
**🔗 Demo Video:** `[PLACEHOLDER — ADD DEMO VIDEO LINK HERE]`

---

## 📋 Assignment Scope — Fully Implemented

Every requirement from the assignment specification has been implemented end-to-end:

| Requirement | Status |
|---|---|
| Upload question paper + answer sheet (PDF/images) | ✅ |
| Show processing progress | ✅ Animated stage-aware progress bar |
| Extract every question in correct printed order | ✅ |
| Treat labelled sub-parts as separate questions (e.g. 11a, 11b) | ✅ |
| Preserve original question numbering | ✅ |
| Handle questions answered out of order | ✅ |
| Handle unanswered questions | ✅ Shown in dedicated "Unanswered" section |
| Handle answers that don't match any question | ✅ Shown in "Unmatched Answers" section |
| Highlight the exact answer region on the answer sheet | ✅ Green bounding box + Q-badge overlay |
| Allow answers to span multiple pages | ✅ Cross-page stitching with continuation detection |
| Grading with marks/scores | ✅ Per-question scoring with color-coded badges |
| Correct/incorrect evaluation | ✅ |
| AI feedback (per question and overall) | ✅ Constructive feedback per answer + overall summary |
| Clear grading summary | ✅ Total score, percentage, tier-based summary |
| Follow the provided Figma design | ✅ Closely follows the reference design |
| Deployed and accessible through a live URL | ✅ |

---

## ✨ Extra Features — Beyond the Assignment

Veda AI has been engineered to handle the complex edge cases that exist in real-world examination papers:

### Intelligent Extraction
- **MCQ Detection & Merging** — Automatically detects when Gemini mistakenly splits MCQ options (A/B/C/D) into separate sub-questions. Uses horizontal layout analysis and spatial grouping to aggressively merge them back into a single question with structured `options[]`.
- **Math & Equation Support** — Accurately extracts and grades mathematical formulas, expressions, and symbolic answers.
- **Numbered Lists Inside Answers** — Distinguishes between a student's internal numbered sub-points (1, 2, 3 inside an answer) and actual new question labels, preventing false boundary splits.
- **Multi-Page Answer Stitching** — Detects pages that start with content but lack a question label at the top, and automatically appends those lines to the previous answer's region across page boundaries.
- **Cascaded & Nested Question Styles** — Handles hierarchical structures like `Q1 → (a) → (i)` with intelligent parent-child ID assignment. If Gemini misses a parent number, the system scans backward through OCR lines to deterministically repair the relationship.
- **Out-of-Order Answer Handling** — Students who answer Q5 before Q2 are handled gracefully through label-based mapping rather than sequential assumptions.
- **MCQ 0-Line Rescue** — When a student writes just a single letter (e.g., "B") horizontally aligned with a question label, the bounding box might miss it. The system expands capture range by 2% into the next slice to rescue the text.

### Polished UI/UX
- **Resizable Split-View (Desktop)** — Draggable divider between the questions panel and the PDF viewer for a customizable workspace.
- **Mobile-Optimized Experience** — Smooth pill-shaped tab switcher for Questions/Answer Sheet, right-side slide-out drawer navigation, and touch-friendly interactions.
- **Interactive PDF Highlight Viewer** — Clicking any question instantly scrolls the PDF viewer to the exact pixel location of the student's handwritten answer, with a green bounding box overlay and a floating Q-number badge.
- **Frosted Glass Desktop Topbar** — 75% opacity white topbar with backdrop blur for a modern aesthetic.
- **Themed Progress Bar** — Grey/orange animated progress bar that displays the current pipeline stage and live percentage during extraction.
- **Confidence Indicators** — Every mapping shows its confidence level (high/medium/low) with color-coded badges and the specific reason it was matched (exact label, fuzzy match, contextual ordering).

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Next.js App Router)                │
│                                                                     │
│  ┌──────────────┐   ┌───────────────────┐   ┌───────────────────┐  │
│  │  Upload Page  │──▶│  /api/process     │──▶│   Results Page    │  │
│  │  (page.tsx)   │   │  (route.ts)       │   │   (results/       │  │
│  │              │   │                   │   │    page.tsx)      │  │
│  └──────────────┘   └─────────┬─────────┘   └───────────────────┘  │
│                               │                                     │
└───────────────────────────────┼─────────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │   PROCESSING PIPELINE  │
                    │                       │
                    │  Step 1: PDF → Images │
                    │  (sharp + pdf-to-img) │
                    │          │            │
                    │  Step 2: OCR          │
                    │  (OCR.space)          │
                    │  Engine 2: printed QP │
                    │  Engine 3: handwritten│
                    │          │            │
                    │  Step 3: Extract Qs   │
                    │  (Gemini AI)          │
                    │          │            │
                    │  Step 4: Segment As   │
                    │  (OCR regex + Gemini  │
                    │   Vision fusion)      │
                    │          │            │
                    │  Step 5: Map A→Q      │
                    │  (4-round matching)   │
                    │          │            │
                    │  Step 6: Validate     │
                    │          │            │
                    │  Step 7: Grade        │
                    │  (Gemini batch eval)  │
                    └───────────────────────┘
```

### Tech Stack
| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| State Management | Zustand |
| PDF Rendering | react-pdf + pdfjs |
| Image Processing | sharp |
| OCR | OCR.space (Engine 2 for print, Engine 3 for handwriting) |
| AI Model | Gemini 3.5 Flash Lite (via Google GenAI SDK) |
| File Persistence | IndexedDB (client-side, no database needed) |
| UI Components | shadcn/ui + Radix primitives |

---

## 🔬 Pipeline Deep Dive

### Step 1 — Document Ingestion
PDFs are converted to page images at 150 DPI using `pdf-to-img` and `sharp`. Images are compressed to JPEG under 900KB to stay within OCR.space's free-tier 1MB limit.

### Step 2 — Dual-Engine OCR
The question paper (printed text) is processed with **OCR Engine 2** for speed and accuracy. The answer sheet (handwriting) uses **OCR Engine 3**, which is optimized for handwritten text recognition. Each page is processed sequentially with a 5-second cooldown to respect free-tier rate limits. Every word gets a pixel-accurate bounding box, which is normalized to `[0.0, 1.0]` coordinates for resolution-independent rendering.

### Step 3 — Question Extraction
OCR text is serialized into a compact spatial context format (70% smaller than raw JSON) and passed to Gemini. The AI extracts each question with its number, marks, type (`short_answer`, `long_answer`, `mcq`), and parent-child relationships. Post-processing applies two critical fixers:
- **`fixSubquestionIds`** — Scans backward through OCR lines to repair orphaned sub-questions (e.g., `(i)` without its parent `5` becomes `5i`).
- **`detectAndFixMCQSplits`** — Detects when MCQ options were incorrectly classified as sub-questions and merges them back into a single question with `options[]`.

### Step 4 — Answer Segmentation (Hybrid OCR + Vision Fusion)
This is the most complex step. It runs two independent detection pipelines and fuses their results:

1. **OCR Regex Pipeline** — Scans every OCR line for question-number patterns (`Q1`, `1.`, `1)`, `(a)`, `(i)`, etc.) using regex.
2. **Gemini Vision Pipeline** — Sends the raw page images to Gemini's multimodal vision model, which semantically identifies answer boundaries even in messy handwriting that OCR regex would miss.
3. **Fusion** — `fuseLabels()` merges both pipelines. OCR provides the authoritative bounding box coordinates; Gemini provides the semantic confidence. A multi-signal confidence score is computed for each boundary candidate.
4. **5 Post-Fusion Guards** reject false positives:
   - MCQ option suffixes disguised as question labels
   - Standalone roman numerals without explicit parent context
   - Duplicate labels on the same page
   - Labels with coordinates outside expected ranges
   - Low-confidence candidates below threshold
5. **Cross-Page Continuation** — Pages that start with answer text but no label at the top (Y > 0.12) are stitched onto the previous answer.

### Step 5 — Answer-to-Question Mapping
A 4-round matching algorithm with decreasing confidence:

| Round | Strategy | Confidence |
|---|---|---|
| 1 | **Exact label match** — `answer.studentLabel` matches `question.id` or `question.number` exactly | 0.95 |
| 2 | **Fuzzy label match** — Text similarity algorithm finds the closest matching question label | 0.70–0.94 |
| 3 | **Contextual ordering** — Sequential assignment for remaining unlabeled answers | 0.55 |
| 4 | **Unmatched** — Remaining answers go to the "Unmatched" bucket with candidate suggestions | — |

Parent-to-child fallback: If a student writes just "5" but the paper only has "5(a)" and "5(b)", the system intelligently assigns the answer to the parent's children.

### Step 6 — Validation
Sanity-checks all mappings to prevent corrupted states:
- No mapping references an unknown question or answer ID
- No answer is double-mapped to multiple questions
- All normalized coordinates are within `[0.0, 1.0]`

### Step 7 — AI Grading
All question-answer pairs are batched into a single Gemini prompt to minimize API calls and avoid rate limits. The AI evaluates each answer against its question context and returns:
- **Score** (out of max marks)
- **Status** (`correct`, `partially_correct`, `incorrect`, `unanswered`)
- **AI Feedback** (constructive, per-question commentary)

An overall summary is generated with total score, percentage, and tier-based feedback (Outstanding / Good / Needs Improvement).

---

## 🛡️ Resilience & Error Handling

- **OCR Retry Loop** — 4 attempts with exponential backoff (5s → 10s → 20s) specifically targeting HTTP 502, 503, and 429 errors from OCR.space's free tier.
- **Gemini Rate Limit Bypass** — On 429 errors, forces a 65-second wait to explicitly clear Google's 60-second RPM quota window before retrying. Capped at 90s max.
- **Graceful Grading Degradation** — If batch grading fails, answers are marked as "reviewable" rather than crashing the entire pipeline.
- **IndexedDB File Persistence** — The answer sheet PDF is stored in IndexedDB so hard page refreshes on the results page don't lose the uploaded file.

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- A free [Gemini API key](https://aistudio.google.com/)
- A free [OCR.space API key](https://ocr.space/ocrapi)

### Installation
```bash
git clone https://github.com/YOUR_USERNAME/veda-ai.git
cd veda-ai
npm install
```

### Environment Variables
Create a `.env.local` file in the project root:
```env
GEMINI_API_KEY=your_gemini_api_key_here
OCR_SPACE_API_KEY=your_ocr_space_api_key_here
```

### Run Locally
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production Build
```bash
npm run build
npm run start
```

---

## 🌐 Deployment

The app is fully optimized for deployment on **Vercel** (recommended) or **Render**.

The codebase includes built-in automatic timeout pacing (5s between OCR requests) and DPI compression (150 DPI default) to survive free-tier shared-IP rate limits on cloud hosting platforms.

Set the following environment variables on your hosting provider:
- `GEMINI_API_KEY`
- `OCR_SPACE_API_KEY`

---

## 📁 Project Structure

```
src/
├── app/
│   ├── page.tsx                    # Upload page with progress bar
│   ├── results/page.tsx            # Results dashboard (split-view)
│   ├── api/process/route.ts        # Main processing pipeline API
│   ├── globals.css                 # Theme gradients & responsive styles
│   └── layout.tsx                  # Root layout with sidebar
├── components/
│   ├── Sidebar.tsx                 # Navigation (desktop + mobile drawer)
│   └── results/
│       ├── AnswerSheetViewer.tsx    # PDF renderer with highlight overlays
│       ├── AnswerPanel.tsx         # Answer text + grading feedback
│       ├── QuestionCard.tsx        # Question summary card
│       ├── QuestionList.tsx        # Scrollable question list
│       ├── GradingSummary.tsx      # Overall grading summary
│       └── ConfidenceBadge.tsx     # Mapping confidence indicator
├── lib/
│   ├── extraction/
│   │   ├── question-extractor.ts   # Gemini-powered question extraction
│   │   └── answer-segmenter.ts     # Hybrid OCR+Vision answer segmentation
│   ├── mapping/
│   │   ├── mapping-engine.ts       # 4-round answer-to-question mapping
│   │   └── validator.ts            # Mapping sanity checks
│   ├── grading/
│   │   └── grader.ts              # Batch AI grading + summary
│   ├── ocr/
│   │   └── ocr-space.ts           # OCR.space provider with retry logic
│   ├── gemini.ts                   # Gemini client with rate-limit bypass
│   ├── prompts.ts                  # Centralized AI prompts
│   ├── types.ts                    # TypeScript interfaces
│   ├── store.ts                    # Zustand global state
│   ├── file-store.ts              # IndexedDB file persistence
│   └── pdf-utils.ts               # PDF-to-image conversion
└── public/assets/                  # Static assets & icons
```

---

## 🤖 AI Model & API

- **Model:** Gemini 3.5 Flash Lite (via `@google/genai` SDK)
- **Usage:** Question extraction, answer boundary detection (vision), semantic mapping, and batch grading
- **Tier:** Free tier — no billing required

---

## ⚠️ Assumptions & Limitations

- **File size:** 40MB max per document (recommended for optimal performance)
- **OCR.space free tier:** 25,000 requests/month, 500/day. Large documents with many pages may hit daily limits.
- **Gemini free tier:** RPM/TPM limits apply. The 65-second rate-limit bypass handles this automatically, but very large batches may still experience throttling.
- **No authentication:** As per assignment requirements — no login system.
- **No database:** All state is held in-memory (Zustand) and IndexedDB (file persistence). Refreshing the upload page clears the processing results.

---

## 📝 License

MIT
