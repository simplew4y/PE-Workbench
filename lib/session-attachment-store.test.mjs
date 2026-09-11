import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectReferencedAttachmentDirectories,
  removeUnreferencedAttachmentDirectories,
  sessionAttachmentDirectory,
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
  );
  assert.deepEqual(retained, { removed: [], retained: [directory] });
  assert.equal(await readFile(sourcePath, "utf8"), "report");

  const removed = await removeUnreferencedAttachmentDirectories([directory], []);
  assert.deepEqual(removed, { removed: [directory], retained: [] });
  await assert.rejects(readFile(sourcePath, "utf8"), { code: "ENOENT" });
});
