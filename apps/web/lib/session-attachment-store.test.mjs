import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectReferencedAttachmentDirectories,
  removeUnreferencedAttachmentDirectories,
  sessionAttachmentDirectory,
  readAttachmentReferenceHistories,
} from "./session-attachment-store.ts";

function attachmentEntry(sourcePath) {
  return {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-09-06T00:00:00.000Z",
    message: {
      role: "user",
      content: [
        "<pi-session-attachment-context>",
        "Session attachment: report.pdf",
        `Source file path: ${sourcePath}`,
        `Extracted text path: ${sourcePath}.extracted.txt`,
      ].join("\n"),
    },
  };
}

test("keeps session attachments in the project metadata tree", () => {
  assert.equal(
    sessionAttachmentDirectory("/project", "session-123"),
    "/project/meta/session-attachments/session-123",
  );
  assert.equal(sessionAttachmentDirectory("/project", "../escape").startsWith("/project/meta/session-attachments/"), true);
});

test("malformed surviving sessions abort attachment cleanup instead of losing references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-reference-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "unreadable.jsonl"), '{"type":"session"}\n{"unfinished":');
  await assert.rejects(readAttachmentReferenceHistories(root), SyntaxError);
});

test("finds project attachment directories in session history", () => {
  const parentFile = `${sessionAttachmentDirectory("/project", "parent-session")}/hash-report.pdf`;
  assert.deepEqual(
    [...collectReferencedAttachmentDirectories([
      attachmentEntry(parentFile),
    ])],
    ["/project/meta/session-attachments/parent-session"],
  );
});

test("retains a fork-referenced directory and removes it after the final reference disappears", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pi-session-attachments-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const directory = sessionAttachmentDirectory(project, "parent-session");
  const sourcePath = join(directory, "hash-report.pdf");
  await mkdir(directory, { recursive: true });
  await writeFile(sourcePath, "report");

  const retained = await removeUnreferencedAttachmentDirectories(
    [directory],
    [[attachmentEntry(sourcePath)]],
    { cwd: project, sessionId: "parent-session" },
  );
  assert.deepEqual(retained, { removed: [], retained: [directory] });
  assert.equal(await readFile(sourcePath, "utf8"), "report");

  const removed = await removeUnreferencedAttachmentDirectories([directory], [], { cwd: project, sessionId: "parent-session" });
  assert.deepEqual(removed, { removed: [directory], retained: [] });
  await assert.rejects(readFile(sourcePath, "utf8"), { code: "ENOENT" });
});

test("ordinary text cannot authorize deletion of another session or project", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pi-attachment-ownership-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const foreign = sessionAttachmentDirectory(join(project, "other-project"), "victim");
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "report.pdf"), "keep");
  const candidates = collectReferencedAttachmentDirectories([attachmentEntry(join(foreign, "report.pdf"))]);
  const result = await removeUnreferencedAttachmentDirectories(candidates, [], { cwd: project, sessionId: "attacker" });
  assert.deepEqual(result.removed, []);
  assert.equal(await readFile(join(foreign, "report.pdf"), "utf8"), "keep");
});

test("a symlinked attachment ancestor cannot escape the owning project", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pi-attachment-symlink-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const target = join(project, "unrelated", "session-1");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "report.pdf"), "keep");
  await mkdir(join(project, "meta"));
  await symlink(join(project, "unrelated"), join(project, "meta", "session-attachments"), "dir");
  const candidate = sessionAttachmentDirectory(project, "session-1");
  const result = await removeUnreferencedAttachmentDirectories([candidate], [], { cwd: project, sessionId: "session-1" });
  assert.deepEqual(result.removed, []);
  assert.equal(await readFile(join(target, "report.pdf"), "utf8"), "keep");
});
