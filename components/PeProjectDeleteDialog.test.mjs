import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./PeProjectDeleteDialog.tsx", import.meta.url), "utf8");

test("renders project deletion as an accessible application modal", () => {
  assert.match(source, /createPortal/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-labelledby="pe-project-delete-title"/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.target === event\.currentTarget/);
  assert.match(source, /cancelButtonRef\.current\?\.focus/);
});

test("keeps the destructive action and errors inside the modal", () => {
  assert.match(source, /role="alert"/);
  assert.match(source, /t\("project\.confirmDelete"\)/);
  assert.match(source, /background: "#dc2626"/);
  assert.match(source, /disabled=\{busy\}/);
});
