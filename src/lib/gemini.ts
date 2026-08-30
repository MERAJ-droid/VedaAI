import { GoogleGenAI } from '@google/genai';

/** Lazy-initialized Gemini client */
let _ai: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!_ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }
    _ai = new GoogleGenAI({ apiKey });
  }
  return _ai;
}

const MAX_RETRIES = 4;

/** Minimum wait for rate-limit errors. Must exceed the 60s RPM window. */
const RATE_LIMIT_BASE_MS = 65_000;

function isRateLimitError(error: any): boolean {
  return (
    error?.status === 429 ||
    error?.code === 429 ||
    String(error?.message ?? '').includes('429') ||
    String(error?.message ?? '').toLowerCase().includes('rate limit') ||
    String(error?.message ?? '').toLowerCase().includes('quota')
  );
}

/**
 * Retry wrapper with smart backoff:
 * - 429 rate limit → wait ≥65s (clears the 60s RPM window), then 90s cap
 *   Retries at 5s/10s/20s would all fall inside the same 60s window → guaranteed fail again.
 * - Other transient errors → exponential 2s, 4s, 8s
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      return await fn();
    } catch (error: any) {
      attempt++;
      if (attempt >= MAX_RETRIES) throw error;

      const isRateLimit = isRateLimitError(error);
      const delayMs = isRateLimit
        // First retry: 65–68s (past the 60s window). Second: 90s (capped).
        // Jitter prevents thundering herd when multiple requests retry together.
        ? Math.min(90_000, RATE_LIMIT_BASE_MS * Math.pow(1.4, attempt - 1)) + Math.random() * 3_000
        : Math.pow(2, attempt) * 1000 + Math.random() * 1000;

      console.warn(
        `[Gemini] ${isRateLimit ? 'Rate limit' : 'Error'} on attempt ${attempt}/${MAX_RETRIES}. ` +
        `Retrying in ${Math.round(delayMs / 1000)}s...`
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('Max retries exceeded');
}


/**
 * Send a prompt to Gemini and get a structured JSON response.
 */
export async function geminiStructuredRequest<T>(
  prompt: string,
  schema?: Record<string, unknown>,
  model: string = 'gemini-3.5-flash-lite'
): Promise<T> {
  return withRetry(async () => {
    const ai = getClient();

    const config: Record<string, unknown> = {
      responseMimeType: 'application/json',
    };
    if (schema) {
      config.responseSchema = schema;
    }

    const result = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config,
    });

    const text = result.text;
    if (!text) throw new Error('Gemini returned empty response');

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Failed to parse Gemini JSON response: ${text.substring(0, 200)}`);
    }
  });
}

/**
 * Send a plain text prompt to Gemini and get a text response.
 */
export async function geminiTextRequest(
  prompt: string,
  model: string = 'gemini-3.5-flash-lite'
): Promise<string> {
  return withRetry(async () => {
    const ai = getClient();

    const result = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const text = result.text;
    if (!text) throw new Error('Gemini returned empty response');
    return text;
  });
}

/**
 * Send a multimodal request (page images + text prompt) to Gemini and get a structured JSON response.
 *
 * Each image is embedded as inline base64 and annotated with a [Page N] text marker.
 * The text prompt follows all images so Gemini has full visual context first.
 *
 * @param textPrompt - Text prompt describing what to do with the images
 * @param images     - Page images in order: { buffer (PNG), mimeType? }
 * @param schema     - Optional JSON schema for structured output
 * @param model      - Model ID (default: 'gemini-2.5-flash')
 */
export async function geminiVisionStructuredRequest<T>(
  textPrompt: string,
  images: Array<{ buffer: Buffer; mimeType?: string }>,
  schema?: Record<string, unknown>,
  model: string = 'gemini-3.5-flash-lite'
): Promise<T> {
  return withRetry(async () => {
    const ai = getClient();

    // Interleave image data with page-index markers, then append the text prompt
    const imageParts: Array<Record<string, unknown>> = images.flatMap((img, i) => [
      {
        inlineData: {
          mimeType: img.mimeType ?? 'image/png',
          data: img.buffer.toString('base64'),
        },
      },
      { text: `[Page ${i}]` },
    ]);

    const config: Record<string, unknown> = {
      responseMimeType: 'application/json',
    };
    if (schema) {
      config.responseSchema = schema;
    }

    const result = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [...imageParts, { text: textPrompt }],
        },
      ],
      config,
    });

    const text = result.text;
    if (!text) throw new Error('Gemini Vision returned empty response');

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Failed to parse Gemini Vision JSON response: ${text.substring(0, 200)}`);
    }
  });
}
