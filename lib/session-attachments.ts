export const MAX_SESSION_DOCUMENTS = 5;
export const MAX_SESSION_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_SESSION_DOCUMENT_TOTAL_BYTES = 40 * 1024 * 1024;

export const SESSION_DOCUMENT_ACCEPT = [
  ".pdf",
  ".xlsx",
  ".xlsm",
  ".docx",
  ".pptx",
  ".csv",
  ".md",
  ".markdown",
  ".txt",
].join(",");

export const SESSION_ATTACHMENT_CONTEXT_START = "<pi-session-attachment-context>";
export const SESSION_ATTACHMENT_CONTEXT_END = "</pi-session-attachment-context>";

export interface AttachedDocument {
  name: string;
  mimeType: string;
  data: string;
  size: number;
}

const SUPPORTED_EXTENSIONS = new Set(SESSION_DOCUMENT_ACCEPT.split(","));

export function sessionDocumentExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export function isSupportedSessionDocument(name: string): boolean {
  return SUPPORTED_EXTENSIONS.has(sessionDocumentExtension(name));
}

export function stripSessionAttachmentContext(text: string): string {
  const marker = text.indexOf(SESSION_ATTACHMENT_CONTEXT_START);
  return marker === -1 ? text : text.slice(0, marker).trimEnd();
}

export interface SessionAttachmentReference {
  name: string;
  path?: string;
}

export function parseSessionAttachmentReferences(text: string): SessionAttachmentReference[] {
  const references = new Map<string, SessionAttachmentReference>();
  for (const match of text.matchAll(/^\[附件: ([^\r\n]+)]$/gm)) {
    references.set(match[1], { name: match[1] });
  }
  const contextStart = text.indexOf(SESSION_ATTACHMENT_CONTEXT_START);
  if (contextStart !== -1) {
    const context = text.slice(contextStart);
    const pattern = /Session attachment: ([^\r\n]+)\r?\n(?:Source file path: ([^\r\n]+)\r?\n)?Extracted text path: ([^\r\n]+)/g;
    for (const match of context.matchAll(pattern)) {
      const extractedPath = match[3];
      references.set(match[1], {
        name: match[1],
        path: match[2] || extractedPath.replace(/\.extracted\.txt$/, ""),
      });
    }
  }
  return [...references.values()];
}

export function stripSessionAttachmentLabels(text: string): string {
  const visible = stripSessionAttachmentContext(text);
  let removed = false;
  const lines = visible.split(/\r?\n/).filter((line) => {
    const generatedLabel = /^\[附件: [^\r\n]+]$/.test(line);
    if (generatedLabel) removed = true;
    return !generatedLabel;
  });
  return removed ? lines.join("\n").trim() : visible;
}

function decodedBytes(data: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) return -1;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor(data.length * 3 / 4) - padding;
}

export function validateSessionDocuments(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "Invalid session documents";
  if (value.length > MAX_SESSION_DOCUMENTS) return `A maximum of ${MAX_SESSION_DOCUMENTS} documents may be attached`;
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") return "Invalid session document";
    const document = item as Partial<AttachedDocument>;
    if (
      typeof document.name !== "string"
      || document.name.length === 0
      || document.name.length > 240
      || document.name === "."
      || document.name === ".."
      || /[\\/\0-\x1f]/.test(document.name)
      || !isSupportedSessionDocument(document.name)
    ) return `Unsupported session document: ${String(document.name ?? "")}`;
    if (typeof document.mimeType !== "string" || typeof document.data !== "string") return "Invalid session document payload";
    const bytes = decodedBytes(document.data);
    if (bytes < 0 || bytes > MAX_SESSION_DOCUMENT_BYTES) return `${document.name} exceeds the 20 MB session attachment limit`;
    total += bytes;
  }
  return total > MAX_SESSION_DOCUMENT_TOTAL_BYTES ? "Session documents exceed the 40 MB total limit" : null;
}
