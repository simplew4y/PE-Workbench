import assert from "node:assert/strict";
import test from "node:test";
import { researchCardRevisionChanges } from "./research-card-history.ts";
import { researchProgress, researchProgressMarkdown } from "./research-progress.ts";

function card(id, changes = {}) {
  return { id, datasetId: "byd", kind: "note", title: id, content: id + "正文",
    status: "unverified", archived: false, createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z", revision: 1, evidence: [], frameworkItems: [],
    evidenceIds: [], relatedCardIds: [], frameworkItemIds: [], origin: null, ...changes };
}

test("revision comparison reports only user-visible editable fields", () => {
  const older = card("旧版本");
  const newer = card("新版本", { content: "新内容", status: "confirmed", archived: true, frameworkItemIds: ["thesis-1"] });
  assert.deepEqual(researchCardRevisionChanges(older, newer), ["标题", "内容", "状态", "归档状态", "框架关联"]);
  assert.deepEqual(researchCardRevisionChanges(newer, { ...newer }), []);
});

test("progress and export exclude archived and foreign records without overstating confirmation", () => {
  const cards = [
    card("已归档秘密", { archived: true }), card("其他项目秘密", { datasetId: "catl" }),
    card("利润待核实"), card("现金流问题", { kind: "question", status: "open", updatedAt: "2026-09-03T00:00:00Z" }),
    card("人工保留判断", { status: "confirmed", evidence: [{ id: "page:missing", available: false, citation: null }] }),
  ];
  const before = JSON.stringify(cards);
  const result = researchProgress(cards, "byd");
  assert.equal(result.latest.id, "现金流问题");
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.unverified.length, 1);
  assert.equal(result.evidenceGaps.length, 2);
  const report = researchProgressMarkdown(cards, "byd", "比亚迪", "2026-09-21");
  assert.doesNotMatch(report, /已归档秘密|其他项目秘密/);
  assert.match(report, /待核实 1 项/);
  assert.match(report, /暂不可定位/);
  assert.match(report, /不代表自动核验/);
  assert.equal(JSON.stringify(cards), before);
});

test("export preserves source excerpts and versions; empty progress never claims research is complete", () => {
  const report = researchProgressMarkdown([card("研究结论", {
    revision: 3, content: "修订后的判断",
    origin: { sessionId: "session-a", entryId: "entry-a", excerpt: "最初的判断", messageTimestamp: 1 },
    evidence: [{ id: "page:annual", available: true, citation: "年报第 12 页" }],
  })], "byd", "比亚迪", "2026-09-21");
  for (const text of ["版本：3", "修订后的判断", "最初的判断", "session-a", "entry-a", "年报第 12 页"])
    assert.ok(report.includes(text));
  assert.match(researchProgressMarkdown([], "byd", "比亚迪", "2026-09-21"), /不代表研究已完整/);
});
