import { randomUUID } from 'crypto';

const PDF_TTL_MS = parseInt(process.env.PDF_TTL_MS ?? '600000', 10);

interface PdfEntry {
  buffer: Buffer;
  filename: string;
  timer: ReturnType<typeof setTimeout>;
}

const store = new Map<string, PdfEntry>();

export function storePdf(buffer: Buffer, filename: string): string {
  const id = randomUUID();
  const timer = setTimeout(() => {
    store.delete(id);
  }, PDF_TTL_MS);
  // Allow the timer to be garbage-collected without keeping the process alive
  if (timer.unref) timer.unref();
  store.set(id, { buffer, filename, timer });
  return id;
}

export function retrievePdf(id: string): { buffer: Buffer; filename: string } | undefined {
  const entry = store.get(id);
  if (!entry) return undefined;
  return { buffer: entry.buffer, filename: entry.filename };
}
