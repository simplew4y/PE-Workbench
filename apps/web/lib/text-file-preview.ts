import { open } from "node:fs/promises";
import { TEXT_PREVIEW_MAX_BYTES, type TextPreviewPage } from "./file-types.ts";

export class BinaryTextPreviewError extends Error {
  constructor() {
    super("Binary files cannot be previewed as text. Download the original file instead.");
  }
}

export function parseTextPreviewPage(value: string | null): number | null {
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : null;
}

/** Read one bounded page, keeping UTF-8 characters intact across page boundaries. */
export async function readTextFilePreview(filePath: string, requestedPage = 0): Promise<{
  content: string;
  size: number;
  textPage: TextPreviewPage;
}> {
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 0) throw new Error("Invalid text preview page");
  const file = await open(filePath, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Not a file");
    const size = stat.size;
    const pageCount = Math.max(1, Math.ceil(size / TEXT_PREVIEW_MAX_BYTES));
    // A watched file may shrink while the user is viewing a later page.
    const page = Math.min(requestedPage, pageCount - 1);
    const nominalStart = page * TEXT_PREVIEW_MAX_BYTES;
    const nominalEnd = Math.min(size, nominalStart + TEXT_PREVIEW_MAX_BYTES);
    const readStart = Math.max(0, nominalStart - 3);
    const buffer = Buffer.alloc(Math.min(size, nominalEnd + 1) - readStart);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, readStart + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let start = Math.min(nominalStart - readStart, bytesRead);
    let end = Math.min(nominalEnd - readStart, bytesRead);
    // Move both boundaries back to the leading byte, so adjacent pages join exactly.
    while (start > 0 && start < bytesRead && (buffer[start] & 0xc0) === 0x80) start--;
    while (end > 0 && end < bytesRead && (buffer[end] & 0xc0) === 0x80) end--;
    const content = buffer.subarray(start, end);
    if (content.includes(0)) throw new BinaryTextPreviewError();
    return {
      content: content.toString("utf8"),
      size,
      textPage: { page, pageCount, byteStart: readStart + start, byteEnd: readStart + end },
    };
  } finally {
    await file.close();
  }
}
