import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSessionAttachmentReferences,
  stripSessionAttachmentContext,
  stripSessionAttachmentLabels,
  validateSessionDocuments,
} from "./session-attachments.ts";

const validDocument = {
  name: "report.pdf",
  mimeType: "application/pdf",
  data: Buffer.from("pdf-data").toString("base64"),
  size: 8,
};

test("accepts a supported session document payload", () => {
  assert.equal(validateSessionDocuments([validDocument]), null);
});

test("rejects unsupported formats and unsafe names", () => {
  assert.match(validateSessionDocuments([{ ...validDocument, name: "report.exe" }]), /Unsupported/);
  assert.match(validateSessionDocuments([{ ...validDocument, name: "../report.pdf" }]), /Unsupported/);
  assert.match(validateSessionDocuments([{ ...validDocument, name: "bad\0report.pdf" }]), /Unsupported/);
});

test("rejects too many session documents", () => {
  assert.match(validateSessionDocuments(Array.from({ length: 6 }, () => validDocument)), /maximum of 5/);
});

test("hides internal attachment context from the rendered user message", () => {
  assert.equal(
    stripSessionAttachmentContext("请总结\n\n[附件: report.pdf]\n\n<pi-session-attachment-context>secret"),
    "请总结\n\n[附件: report.pdf]",
  );
});

test("restores previewable attachment metadata and hides generated labels", () => {
  const text = [
    "请总结",
    "[附件: report.pdf]",
    "<pi-session-attachment-context>",
    "Session attachment: report.pdf",
    "Source file path: /project/meta/session-attachments/s1/hash-report.pdf",
    "Extracted text path: /project/meta/session-attachments/s1/hash-report.pdf.extracted.txt",
  ].join("\n");
  assert.deepEqual(parseSessionAttachmentReferences(text), [{
    name: "report.pdf",
    path: "/project/meta/session-attachments/s1/hash-report.pdf",
  }]);
  assert.equal(stripSessionAttachmentLabels(text), "请总结");
});

test("derives the source path for attachments created before source metadata was added", () => {
  const text = [
    "[附件: old.pdf]",
    "<pi-session-attachment-context>",
    "Session attachment: old.pdf",
    "Extracted text path: /project/old.pdf.extracted.txt",
  ].join("\n");
  assert.deepEqual(parseSessionAttachmentReferences(text), [{ name: "old.pdf", path: "/project/old.pdf" }]);
});
