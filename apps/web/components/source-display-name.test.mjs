import assert from "node:assert/strict";
import test from "node:test";
import { sourceDisplayName } from "./source-display-name.ts";

test("source labels remove only mixed hexadecimal suffixes and preserve meaningful names", () => {
  assert.equal(sourceDisplayName("Wind-financials-83d02abc.txt"), "Wind-financials.txt");
  assert.equal(sourceDisplayName("Wind-financials-83d02abc.txt", "Financial report"), "Financial report");
  assert.equal(sourceDisplayName("report-83d02abc.PDF", "report-83d02abc.PDF"), "report.PDF");
  for (const name of ["report-20261015.pdf", "stock-600519.txt", "report-2026-10-15.pdf",
    "report-deadbeef.txt", "report-83d02.txt", "report-83d02abc-notes.txt"]) {
    assert.equal(sourceDisplayName(name), name);
  }
});
