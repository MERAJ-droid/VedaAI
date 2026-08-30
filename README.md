# VedaAI — AI Assessment Extraction & Answer Mapping

Upload a question paper and a student's handwritten answer sheet. The app automatically extracts questions, segments answers with spatial coordinates, and maps them together — letting you click any question to highlight the exact region of the answer sheet where the student wrote their response.

## Features

- 📄 **Upload** question papers and answer sheets as PDF or images
- 🔍 **OCR** powered by Google Document AI (Enterprise Document OCR) with bounding boxes
- 🧠 **Semantic understanding** via Gemini 2.5 Flash
- 🗺️ **Precise spatial highlighting** — click a question → highlight exact answer region on the PDF
- 📋 **Sub-part handling** — questions like 11(a), 11(b) treated as separate entries
- 🔀 **Edge case handling** — out-of-order answers, multi-page answers, unanswered questions, unmatched answers
- ✅ **Optional AI grading** — per-question scores + overall feedback

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 (App Router, TypeScript) |
| OCR / Geometry | Google Document AI — Enterprise Document OCR |
| Semantic AI | Gemini 2.5 Flash (`@google/genai`) |
| PDF Rendering | react-pdf (PDF.js) |
| UI | Tailwind CSS + shadcn/ui |
| State | Zustand |
| Deployment | Vercel |

## Architecture

```
Upload → PDF-to-image → Document AI OCR → Question Extraction → Answer Segmentation → Mapping → Results UI
                              ↑                    ↑                      ↑               ↑
                         owns geometry          Gemini            Gemini (labels)      Gemini
```

**Key principle**: Document AI is the authoritative source of spatial geometry. Gemini never generates coordinates — it only interprets meaning.

## Setup

### 1. Clone and install

```bash
cd veda-ai
npm install
```

### 2. Set up environment variables

```bash
cp .env.local.example .env.local
```

Fill in `.env.local`:

| Variable | How to get it |
|----------|---------------|
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com) → Get API key |
| `GOOGLE_CLOUD_PROJECT_ID` | Your GCP project ID |
| `GOOGLE_CLOUD_LOCATION` | `us` (or `eu`) |
| `DOCUMENT_AI_PROCESSOR_ID` | See below |
| `GOOGLE_APPLICATION_CREDENTIALS_BASE64` | See below |

### 3. Create a Document AI processor

1. Go to [Google Cloud Console → Document AI](https://console.cloud.google.com/ai/document-ai)
2. Create a processor: **Enterprise Document OCR**
3. Note the **Processor ID** from the processor details page

### 4. Create a service account

```bash
# Create service account
gcloud iam service-accounts create vedaai-sa --display-name="VedaAI Service Account"

# Grant Document AI role
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:vedaai-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/documentai.apiUser"

# Download key
gcloud iam service-accounts keys create service-account.json \
  --iam-account=vedaai-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com

# Base64 encode (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))
```

Paste the output as `GOOGLE_APPLICATION_CREDENTIALS_BASE64` in `.env.local`.

### 5. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Use the debug viewer at [http://localhost:3000/debug/document](http://localhost:3000/debug/document) to validate OCR coordinate alignment before testing the full pipeline.

## Deployment to Vercel

1. Push to GitHub
2. Import the repo in Vercel
3. Add all environment variables from `.env.local` to Vercel project settings
4. Deploy — Vercel auto-detects Next.js

The `vercel.json` sets a 5-minute timeout for the processing route (needed for large documents).

## Limitations

- **File size**: 40 MB max (Document AI sync API limit)
- **Page count**: 15 pages max per document (Document AI sync limit)
- **Document AI free tier**: 1,000 pages/month
- **Gemini free tier**: RPM/TPM limits apply; large documents may hit rate limits
