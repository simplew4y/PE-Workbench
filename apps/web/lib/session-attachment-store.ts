import { createHash } from "crypto";
import { lstat, readdir, readFile, realpath, rm } from "fs/promises";
import { join, normalize, resolve, sep } from "path";
import type { SessionEntry } from "./types";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ATTACHMENT_SEGMENT = "/meta/session-attachments/";

function safeSessionId(sessionId: string): string {
  return SAFE_SESSION_ID.test(sessionId)
    ? sessionId
    : createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  for (const item of Object.values(value)) collectStrings(item, output);
}

function isPathInside(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

function attachmentDirectoryForPath(filePath: string): string | null {
  const normalizedPath = normalizeSlashes(filePath.trim());
  const markerIndex = normalizedPath.indexOf(ATTACHMENT_SEGMENT);
  if (markerIndex === -1) return null;
  const ownerStart = markerIndex + ATTACHMENT_SEGMENT.length;
  const owner = normalizedPath.slice(ownerStart).split("/")[0];
  if (!SAFE_SESSION_ID.test(owner)) return null;
  return normalize(normalizedPath.slice(0, ownerStart + owner.length));
}

function isRecognizedAttachmentDirectory(directory: string): boolean {
  const normalizedDirectory = normalizeSlashes(directory);
  const markerIndex = normalizedDirectory.lastIndexOf(ATTACHMENT_SEGMENT);
  if (markerIndex === -1) return false;
  const owner = normalizedDirectory.slice(markerIndex + ATTACHMENT_SEGMENT.length);
  return SAFE_SESSION_ID.test(owner) && !owner.includes("/");
}

export function sessionAttachmentDirectory(cwd: string, sessionId: string): string {
  const root = resolve(cwd, "meta", "session-attachments");
  const directory = join(root, safeSessionId(sessionId));
  if (!isPathInside(root, directory)) throw new Error("Invalid session attachment directory");
  return directory;
}

export function collectReferencedAttachmentDirectories(
  entries: SessionEntry[],
): Set<string> {
  const directories = new Set<string>();
  const strings: string[] = [];
  collectStrings(entries, strings);
  for (const text of strings) {
    for (const match of text.matchAll(/(?:Source file path|Extracted text path):\s*([^\r\n]+)/g)) {
      const directory = attachmentDirectoryForPath(match[1]);
      if (directory) directories.add(directory);
    }
  }
  return directories;
}

export function entriesReferenceAttachmentDirectory(entries: SessionEntry[], directory: string): boolean {
  const target = `${normalizeSlashes(directory)}/`;
  const strings: string[] = [];
  collectStrings(entries, strings);
  return strings.some((value) => normalizeSlashes(value).includes(target));
}

/** Unlike the browsing SDK, deletion must not skip corrupt or unreadable files. */
export async function readAttachmentReferenceHistories(root: string): Promise<SessionEntry[][]> {
  const histories: SessionEntry[][] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Cannot prove attachment references through a session symlink");
    if (entry.isDirectory()) histories.push(...await readAttachmentReferenceHistories(path));
    else if (entry.name.endsWith(".jsonl")) {
      const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim());
      const parsed = lines.map((line) => JSON.parse(line));
      if (parsed[0]?.type !== "session") throw new Error("Unreadable session header during attachment cleanup");
      histories.push(parsed as SessionEntry[]);
    }
  }
  return histories;
}

export async function removeUnreferencedAttachmentDirectories(
  candidates: Iterable<string>,
  remainingSessionEntries: SessionEntry[][],
  owner: { cwd: string; sessionId: string },
): Promise<{ removed: string[]; retained: string[] }> {
  const removed: string[] = [];
  const retained: string[] = [];
  const ownedDirectory = sessionAttachmentDirectory(owner.cwd, owner.sessionId);
  for (const candidate of new Set(candidates)) {
    // Text references can retain data, but can NEVER establish ownership.
    if (!isRecognizedAttachmentDirectory(candidate) || resolve(candidate) !== ownedDirectory) {
      retained.push(candidate);
      continue;
    }
    if (remainingSessionEntries.some((entries) => entriesReferenceAttachmentDirectory(entries, candidate))) {
      retained.push(candidate);
      continue;
    }
    try {
      const project = await realpath(owner.cwd);
      const actual = await realpath(candidate);
      if ((await lstat(candidate)).isSymbolicLink()
        || actual !== sessionAttachmentDirectory(project, owner.sessionId)) {
        retained.push(candidate);
        continue;
      }
    } catch {
      // Missing, unreadable, or broken links are not permission to delete.
      retained.push(candidate);
      continue;
    }
    await rm(candidate, { recursive: true, force: true });
    removed.push(candidate);
  }
  return { removed, retained };
}
