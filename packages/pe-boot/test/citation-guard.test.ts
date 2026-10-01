import { readFileSync, rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAnswerCitations, excelCitations, registerCitationGuard } from "../src/citation-guard.ts";
import { registerPeDocuments } from "../src/documents.ts";
import { checkExcelCitation, type ExcelCitationSource, sourceId, sourceLink } from "../src/source.ts";
import { peExcelRangeTool } from "../src/tools/excel-range.ts";
import * as reader from "../src/workbook-reader.ts";
import { createDocumentProject } from "./document-fixture.ts";
import { writeWorkbookFixture } from "./workbook-source-fixture.ts";

const id = (range: string, sheet = "Model") => sourceId({ docId: "doc-test", sheet, range });
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("issue 4 citation consistency", () => {
	it.each([
		["B12", "A12"],
		["B13", "A13"],
		["B10", "A10"],
		["B12:B13", "B12"],
	])("rejects a valid id for %s pointing to %s", (label, actual) => {
		expect(checkExcelCitation(`Model!${label}`, id(actual)).status).toBe("mismatch");
	});
	it("compares sheets and normalized exact bounds, not just range overlap", () => {
		expect(checkExcelCitation("Other!B12", id("B12")).reason).toBe("工作表不一致");
		expect(checkExcelCitation("'Model'!$b$12", id("B12:B12")).status).toBe("consistent");
		expect(checkExcelCitation("'O''Brien 模型'!B12", id("B12", "O'Brien 模型")).status).toBe("consistent");
		expect(checkExcelCitation("Model!B12", id("B12:B13")).status).toBe("mismatch");
		expect(checkExcelCitation("来源 1", id("A12")).status).toBe("unverified");
	});
	it("checks literal values, formulas and file identity against the selected cell, not neighbors", () => {
		const source: ExcelCitationSource = {
			filename: "model.xlsx",
			sheet_name: "Model",
			cell_range: "A12",
			cells: [
				{ cell_ref: "A12", row_index: 12, col_index: 1, raw_value: "Target price" },
				{ cell_ref: "B12", row_index: 12, col_index: 2, numeric_value: 75, formula: "=B10*B11" },
			],
		};
		expect(checkExcelCitation("Model!A12 = 75", id("A12"), source).status).toBe("mismatch");
		expect(checkExcelCitation("Model!A12 = =B10*B11", id("A12"), source).status).toBe("mismatch");
		source.cell_range = "B12";
		expect(checkExcelCitation("Model!B12 = 75", id("B12"), source).status).toBe("consistent");
		expect(checkExcelCitation("Model!B12 = 76", id("B12"), source).status).toBe("mismatch");
		expect(checkExcelCitation("Model!B12 = =B10*B11", id("B12"), source).status).toBe("consistent");
		expect(checkExcelCitation("other.xlsx Model!B12", id("B12"), source).reason).toBe("文件名称不一致");
	});
	it("parses formatted/reference citations while ignoring code examples", () => {
		const href = `#pe-source?evidence_id=${encodeURIComponent(id("A12"))}`;
		const text =
			"[**Model!B12**](" +
			href +
			")\n\n[Model!B13][ref]\n\n[ref]: " +
			href +
			"\n\n~~~md\n" +
			sourceLink("Model!B10", id("A10")) +
			"\n~~~\n\n" +
			String.fromCharCode(96) +
			sourceLink("Model!B10", id("A10")) +
			String.fromCharCode(96);
		expect(excelCitations(text).map((citation) => citation.label)).toEqual(["Model!B12", "Model!B13"]);
	});
	it("uses real tool evidence and source contents to reject wrong cells and accept correct citations", async () => {
		const root = createDocumentProject("issue4");
		roots.push(root);
		const docId = String(
			registerPeDocuments(root, "issue4", [
				{
					name: "model.xlsx",
					bytes: readFileSync(new URL("./fixtures/excel-parity.xlsx", import.meta.url)),
				},
			]).documents[0].doc_id,
		);
		writeWorkbookFixture(root, docId, [
			{ sheet: "Model", cell: "A12", value: "Target price" },
			{ sheet: "Model", cell: "B10", value: 3.75 },
			{ sheet: "Model", cell: "B11", value: 20 },
			{ sheet: "Model", cell: "B12", value: "=B10*B11", cached: 75 },
			...Array.from({ length: 29 }, (_, i) => ({ sheet: "Model", cell: `C${i + 1}`, value: i })),
		]);
		const result = await peExcelRangeTool.execute(
			"test",
			{
				doc_id: docId,
				sheet_name: "Model",
				cell_range: "A12:B12",
				include_evidence_ids: true,
			},
			undefined,
			undefined,
			{ cwd: root } as ExtensionContext,
		);
		const cells = (
			result.details as { cells: { cell_ref: string; evidence_id: string; markdown_citation: string }[] }
		).cells;
		const label = cells.find((cell) => cell.cell_ref === "A12")!;
		const number = cells.find((cell) => cell.cell_ref === "B12")!;
		expect(await checkAnswerCitations(root, sourceLink("Model!B12", label.evidence_id))).toHaveLength(1);
		expect(await checkAnswerCitations(root, sourceLink("Model!A12 = 75", label.evidence_id))).toHaveLength(1);
		expect(await checkAnswerCitations(root, sourceLink("Model!B12 = 75", number.evidence_id))).toEqual([]);
		expect(await checkAnswerCitations(root, number.markdown_citation)).toEqual([]);
		for (const draft of [
			`目标价为 75（${label.markdown_citation}）。`,
			`目标价为 75（${sourceLink("来源", label.evidence_id)}）。`,
			`目标价公式为 \`=B10*B11\`（${label.markdown_citation}）。`,
			`| 指标 | 值 | 来源 |\n|---|---|---|\n| 目标价 | 75 | ${label.markdown_citation} |`,
		]) {
			expect((await checkAnswerCitations(root, draft)).join(" ")).toContain("实际仅包含文本");
		}
		for (const draft of [
			`目标价为 75（${number.markdown_citation}）。`,
			`目标价公式为 \`=B10*B11\`（${number.markdown_citation}）。`,
			`| 指标 | 值 | 来源 |\n|---|---|---|\n| 目标价 | 75 | ${number.markdown_citation} |`,
			`行名为 Target price（${label.markdown_citation}）。`,
			`2026 年的行名为 Target price（${label.markdown_citation}）。`,
			`目标价为 75，数值证据 ${number.markdown_citation}，行名证据 ${label.markdown_citation}。`,
			`| 指标 | 值 |\n|---|---|\n| 目标价 ${label.markdown_citation} | 75 ${number.markdown_citation} |`,
			`目标价为 75。\n\n行名为 Target price（${label.markdown_citation}）。`,
		])
			expect(await checkAnswerCitations(root, draft)).toEqual([]);
		const text = result.content.find((block) => block.type === "text")!;
		expect(text.text).toContain(number.markdown_citation);
		const batch = vi.spyOn(reader, "readWorkbookDocumentAsync");
		try {
			const many = Array.from({ length: 29 }, (_, i) =>
				sourceLink(`Model!C${i + 1} = ${i}`, sourceId({ docId, sheet: "Model", range: `C${i + 1}` })),
			).join("\n");
			expect(await checkAnswerCitations(root, many)).toEqual([]);
			expect(batch).toHaveBeenCalledTimes(1);
			expect(
				await checkAnswerCitations(
					root,
					sourceLink("Other!B12", sourceId({ docId, sheet: "Other", range: "B12" })),
				),
			).toHaveLength(1);
		} finally {
			batch.mockRestore();
		}
	});
});

function harness() {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const repairs: unknown[] = [];
	registerCitationGuard({
		on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(name, handler);
		},
		sendMessage(message: unknown) {
			repairs.push(message);
		},
	} as unknown as ExtensionAPI);
	let sessionId = "one";
	const ctx = { cwd: "/unused", sessionManager: { getSessionId: () => sessionId } } as ExtensionContext;
	const emit = (name: string, data: Record<string, unknown> = {}) =>
		handlers.get(name)?.({ ...data, type: name } as never, ctx);
	const finish = (text: string, stopReason = "stop") =>
		emit("message_end", {
			message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
		});
	return {
		emit,
		finish,
		repairs,
		changeSession: () => {
			sessionId = "two";
		},
	};
}

it("repairs once, marks repeated failures and resets for a new user request", async () => {
	const h = harness();
	await h.emit("before_agent_start", { prompt: "question" });
	await h.emit("message_start", { message: { role: "user", content: "question" } });
	const bad = sourceLink("Model!B12", id("A12"));
	expect(JSON.stringify(await h.finish(bad))).toContain("正在重新核对");
	expect(h.repairs).toHaveLength(1);
	expect(JSON.stringify(await h.finish(bad))).toContain("引用核验未通过");
	expect(h.repairs).toHaveLength(1);
	await h.emit("message_start", { message: { role: "user", content: "another question" } });
	await h.finish(bad);
	expect(h.repairs).toHaveLength(2);
	h.changeSession();
	expect(await h.finish(bad)).toBeUndefined();
});

it("does not change non-final messages, unrelated answers or valid generic citations", async () => {
	const h = harness();
	await h.emit("before_agent_start", { prompt: "question" });
	expect(await h.finish(sourceLink("Model!B12", id("A12")), "aborted")).toBeUndefined();
	expect(await h.finish("ordinary answer")).toBeUndefined();
	expect(await h.finish(sourceLink("来源", id("A12")))).toBeUndefined();
	expect(h.repairs).toHaveLength(0);
});

it("does not ask the model to repair a source-read failure and clearly labels its self-certified draft", async () => {
	const h = harness();
	await h.emit("before_agent_start", { prompt: "question" });
	const result = JSON.stringify(await h.finish(`已完成逐项重新核验。${sourceLink("Model!B12", id("B12"))}`));
	expect(h.repairs).toHaveLength(0);
	expect(result).toContain("未核验草稿");
	expect(result).toContain("> 已完成逐项重新核验");
	expect(result).toContain("无法读取");
});
