/**
 * File store: keeps the answer sheet File/Blob available across page navigations
 * AND page refreshes by combining:
 *
 *  1. Module-level variable  — fast, sync, works for same-session navigation
 *  2. IndexedDB              — persists across hard refreshes, stores raw Blob
 *
 * On refresh: module var is null → results page calls getAnswerSheetFileAsync()
 *             which falls back to IndexedDB and restores the File.
 */

const DB_NAME    = 'vedaai_store';
const DB_VERSION = 1;
const STORE_NAME = 'files';
const FILE_KEY   = 'answer_sheet';

// ── Module-level cache (cleared on refresh) ──────────────────────────────────
let _answerSheetFile: File | null = null;

// ── IndexedDB helpers ────────────────────────────────────────────────────────
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbPut(blob: Blob, name: string, type: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.put({ blob, name, type }, FILE_KEY);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function idbGet(): Promise<File | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.get(FILE_KEY);
    req.onsuccess = () => {
      const row = req.result as { blob: Blob; name: string; type: string } | undefined;
      if (!row) { resolve(null); return; }
      resolve(new File([row.blob], row.name, { type: row.type }));
    };
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.delete(FILE_KEY);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Store the file in memory AND IndexedDB. Call this after a successful upload. */
export function setAnswerSheetFile(file: File): void {
  _answerSheetFile = file;
  // Fire-and-forget — IndexedDB write is async but we don't block the UI
  idbPut(file, file.name, file.type).catch(err =>
    console.warn('[file-store] IndexedDB write failed:', err)
  );
}

/**
 * Sync getter — returns the module-level cached File or null.
 * Use this when you know the file was set in the same session (e.g. just after upload).
 */
export function getAnswerSheetFile(): File | null {
  return _answerSheetFile;
}

/**
 * Async getter — checks module cache first, then falls back to IndexedDB.
 * Use this in the results page useEffect to handle hard refreshes.
 */
export async function getAnswerSheetFileAsync(): Promise<File | null> {
  if (_answerSheetFile) return _answerSheetFile;
  try {
    const file = await idbGet();
    if (file) _answerSheetFile = file; // warm the module cache
    return file;
  } catch (err) {
    console.warn('[file-store] IndexedDB read failed:', err);
    return null;
  }
}

/** Clear both caches. Call this when starting a new upload. */
export async function clearAnswerSheetFile(): Promise<void> {
  _answerSheetFile = null;
  try { await idbDelete(); } catch { /* ignore */ }
}
