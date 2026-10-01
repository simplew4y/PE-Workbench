import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createHarness, getAssistantTexts, getMessageText } from "../../coding-agent/test/suite/harness.ts";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { registerPeDocuments } from "../src/documents.ts";
import { sourceId, sourceLink } from "../src/source.ts";
import { registerPeTools } from "../src/tools/index.ts";
import { writeWorkbookFixture } from "./workbook-source-fixture.ts";

it.each([
	[true, "Model!B12"],
	[false, "Model!B12"],
	[true, "Model!A12"],
	[false, "Model!A12"],
	[true, "来源"],
	[false, "来源"],
] as const)(
	"real SDK tool-to-answer flow repairs citations once (repair succeeds=%s, label=%s)",
	async (succeeds, label) => {
		const h = await createHarness({ extensionFactories: [registerPeTools] });
		try {
			for (const dir of ["raw", "meta"]) mkdirSync(join(h.tempDir, dir));
			initializePeCollectionDatabase(join(h.tempDir, "meta/collection.sqlite3"), {
				datasetId: "issue4",
				name: "Issue 4",
			});
			const docId = String(
				registerPeDocuments(h.tempDir, "issue4", [
					{
						name: "model.xlsx",
						bytes: readFileSync(new URL("./fixtures/excel-parity.xlsx", import.meta.url)),
					},
				]).documents[0].doc_id,
			);
			writeWorkbookFixture(h.tempDir, docId, [
				{ sheet: "Model", cell: "A12", value: "Target price" },
				{ sheet: "Model", cell: "B10", value: 3.75 },
				{ sheet: "Model", cell: "B11", value: 20 },
				{ sheet: "Model", cell: "B12", value: "=B10*B11", cached: 75 },
			]);
			const wrongId = sourceId({ docId, sheet: "Model", range: "A12" });
			const correctId = sourceId({ docId, sheet: "Model", range: "B12" });
			const wrong = `目标价为 75。${sourceLink(label, wrongId)}`;
			const correct = `目标价为 75。${sourceLink("model.xlsx Model!B12", correctId)}`;
			h.session.setActiveToolsByName(["pe_excel_range"]);
			let attempts = 0;
			h.setResponses([
				() =>
					fauxAssistantMessage(
						fauxToolCall("pe_excel_range", {
							doc_id: docId,
							sheet_name: "Model",
							cell_range: "A12:B12",
							include_evidence_ids: true,
						}),
						{ stopReason: "toolUse" },
					),
				(context) => {
					const tool = context.messages.find((message) => message.role === "toolResult");
					expect(getMessageText(tool)).toContain(encodeURIComponent(wrongId));
					expect(getMessageText(tool)).toContain(encodeURIComponent(correctId));
					return fauxAssistantMessage(wrong);
				},
				(context) => {
					attempts++;
					expect(context.messages.map(getMessageText).join("\n")).toContain("Recheck this answer");
					return fauxAssistantMessage(succeeds ? correct : wrong);
				},
			]);
			await h.session.prompt("请解释 model.xlsx 中目标价公式并给出单元格来源。");
			expect(attempts).toBe(1);
			expect(h.getPendingResponseCount()).toBe(0);
			const texts = getAssistantTexts(h);
			expect(texts).toContain("检测到引用不一致或无法核验，正在重新核对原始证据。");
			if (succeeds) expect(texts.at(-1)).toBe(correct);
			else expect(texts.at(-1)).toContain("引用核验未通过");
			// The final events consumed by Web and the persisted session both use the checked message.
			const ended = h.eventsOfType("message_end").filter((event) => event.message.role === "assistant");
			expect(getMessageText(ended.at(-1)?.message)).toBe(texts.at(-1));
			expect(
				h.sessionManager
					.getBranch()
					.some((entry) => entry.type === "message" && getMessageText(entry.message) === texts.at(-1)),
			).toBe(true);
		} finally {
			h.cleanup();
		}
	},
	30_000,
);
