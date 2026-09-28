import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import type { ResearchEvidenceProgress } from "../src/research/evidence-validation.ts";
import {
	createResearchDraft,
	createResearchDraftAsync,
	getResearchFramework,
	listResearchContinuations,
	publishResearchDraft,
	publishResearchDraftAsync,
} from "../src/research/framework.ts";
import { collectFrameworkEvidenceIds } from "../src/research/model.ts";
import { renderInvestmentFrameworkMarkdown } from "../src/research/report.ts";
import { researchTransaction, withResearchDatabase } from "../src/research/storage.ts";
import { sourceId } from "../src/source.ts";
import { peFrameworkTool } from "../src/tools/framework.ts";
import * as workbookReader from "../src/workbook-reader.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

const roots: string[] = [];
const datasetId = "async-framework";
function project() {
	const cwd = mkdtempSync(join(tmpdir(), "pe-framework-async-"));
	roots.push(cwd);
	mkdirSync(join(cwd, "meta"));
	mkdirSync(join(cwd, "raw"));
	initializePeCollectionDatabase(join(cwd, "meta/collection.sqlite3"), { datasetId, name: "Test" });
	const bytes = readFileSync(new URL("./fixtures/excel-parity.xlsx", import.meta.url));
	writeFileSync(join(cwd, "raw/model.xlsx"), bytes);
	withResearchDatabase(cwd, datasetId, (database) => {
		database
			.prepare(
				"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,raw_path,status,created_at,updated_at) VALUES('excel',?,'model.xlsx','model.xlsx',?,'xlsx','raw/model.xlsx','completed','before','before')",
			)
			.run(datasetId, createHash("sha256").update(bytes).digest("hex"));
	});
	return cwd;
}

function evidenceContent(ranges = ["B7"], docId = "excel") {
	const value = frameworkFixture();
	const evidenceIds = ranges.map((range) =>
		sourceId({ docId, location: { kind: "excel", sheet: "Valuation", range } }),
	);
	value.sections.currentAssessment.evidenceIds = evidenceIds;
	value.sections.investmentJudgments.items[0].evidenceIds = evidenceIds;
	value.sections.investmentJudgments.items[0].origin = "research";
	value.sections.evidenceAndChanges.sources = evidenceIds.map((evidenceId) => ({
		evidenceId,
		description: "模型原始单元格",
		quality: "原文件",
		limitations: "未独立复核",
	}));
	return value;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("asynchronous framework proposals", () => {
	it("validates 32 unique citations in one batch without holding a write transaction or rereading synchronously", async () => {
		const cwd = project();
		const content = evidenceContent(Array.from({ length: 32 }, (_, index) => `A${index + 1}`));
		const original = structuredClone(content);
		const progress: ResearchEvidenceProgress[] = [];
		const read = vi
			.spyOn(workbookReader, "readWorkbookDocumentAsync")
			.mockImplementation(async (_db, _datasetId, _docId, request) => {
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
				const concurrent = new DatabaseSync(join(cwd, "meta/collection.sqlite3"), { timeout: 50 });
				try {
					researchTransaction(concurrent, () =>
						concurrent.exec("UPDATE research_frameworks SET current_version_id=current_version_id"),
					);
				} finally {
					concurrent.close();
				}
				// The saved document must stay bound to the submitted payload throughout the await.
				content.title = "Changed by caller while running";
				return { ranges: request.ranges!.map((range) => ({ ...range, exists: true })) };
			});
		const draft = await createResearchDraftAsync(cwd, datasetId, content, ["excel"], null, {
			onProgress: (event) => progress.push(event),
		});
		expect(read).toHaveBeenCalledTimes(1);
		expect(read.mock.calls[0][3]).toMatchObject({ action: "validate", ranges: expect.any(Array) });
		expect(read.mock.calls[0][3].ranges).toHaveLength(32);
		expect(draft.content).toEqual(original);
		expect(collectFrameworkEvidenceIds(draft.content)).toHaveLength(32);
		expect(progress[0]).toMatchObject({ completed: 0, total: 32 });
		expect(progress.at(-1)).toMatchObject({ completed: 32, total: 32, phase: "validated" });
		expect(getResearchFramework(cwd, datasetId)).toMatchObject({
			currentVersionId: null,
			drafts: [{ id: draft.id }],
		});
	});

	it("uses the real workbook validator, displays the complete saved report, and returns only a short model receipt", async () => {
		const cwd = project();
		const content = evidenceContent(["B7", "B5"]);
		const updates: string[] = [];
		const result = await peFrameworkTool.execute(
			"proposal",
			{ operation: "propose", content, docIds: ["excel"], expectedVersionId: null },
			undefined,
			(update) => {
				for (const block of update.content) if (block.type === "text") updates.push(block.text);
			},
			{ cwd } as Parameters<typeof peFrameworkTool.execute>[4],
		);
		const state = getResearchFramework(cwd, datasetId);
		expect(state.currentVersionId).toBeNull();
		expect(state.drafts).toHaveLength(1);
		expect(state.drafts[0].content).toEqual(content);
		expect(result.details).toMatchObject({ rendered_report: renderInvestmentFrameworkMarkdown(content) });
		const receipt = result.content.find((block) => block.type === "text")!;
		expect(receipt.type).toBe("text");
		if (receipt.type !== "text") throw new Error("Expected text receipt");
		expect(JSON.parse(receipt.text)).toMatchObject({ draftId: state.drafts[0].id, status: "open" });
		expect(receipt.text).not.toContain("rendered_report");
		expect(receipt.text).not.toContain("schemaVersion");
		expect(receipt.text).not.toContain("Return rendered_report verbatim");
		expect(updates.some((text) => text.includes("0/2"))).toBe(true);
		expect(updates.some((text) => text.includes("2/2"))).toBe(true);
	}, 20_000);

	it("rejects a missing cell with its document and range while preserving the existing draft", async () => {
		const cwd = project();
		const existing = createResearchDraft(cwd, datasetId, frameworkFixture(), [], null);
		await expect(
			createResearchDraftAsync(cwd, datasetId, evidenceContent(["B7", "XFD1000"]), ["excel"], null),
		).rejects.toThrow("excel Valuation!XFD1000");
		expect(getResearchFramework(cwd, datasetId).drafts.map((draft) => draft.id)).toEqual([existing.id]);
	}, 20_000);

	it("never writes a draft when cancelled before or immediately after source validation", async () => {
		const cwd = project();
		const read = vi
			.spyOn(workbookReader, "readWorkbookDocumentAsync")
			.mockImplementation(async (_db, _datasetId, _docId, request) => ({
				ranges: request.ranges!.map((range) => ({ ...range, exists: true })),
			}));
		const before = AbortSignal.abort(new Error("Stopped before reading"));
		await expect(
			createResearchDraftAsync(cwd, datasetId, evidenceContent(), ["excel"], null, { signal: before }),
		).rejects.toThrow("Stopped before reading");
		expect(read).not.toHaveBeenCalled();
		const controller = new AbortController();
		await expect(
			createResearchDraftAsync(cwd, datasetId, evidenceContent(), ["excel"], null, {
				signal: controller.signal,
				onProgress: (event) => {
					if (event.phase === "validated") controller.abort(new Error("Stopped before save"));
				},
			}),
		).rejects.toThrow("Stopped before save");
		expect(getResearchFramework(cwd, datasetId).drafts).toEqual([]);
	});

	it.each(["version", "source", "file"] as const)(
		"rechecks %s changes made while asynchronous validation runs",
		async (change) => {
			const cwd = project();
			vi.spyOn(workbookReader, "readWorkbookDocumentAsync").mockImplementation(
				async (_db, _datasetId, _docId, request) => {
					await new Promise<void>((resolve) => setTimeout(resolve, 5));
					if (change === "version") {
						const competing = createResearchDraft(cwd, datasetId, frameworkFixture(), [], null);
						publishResearchDraft(cwd, datasetId, {
							draftId: competing.id,
							revision: 1,
							expectedVersionId: null,
							requestId: "competing",
						});
					} else if (change === "source") {
						withResearchDatabase(cwd, datasetId, (database) =>
							database.exec("UPDATE documents SET sha256='changed' WHERE doc_id='excel'"),
						);
					} else appendFileSync(join(cwd, "raw/model.xlsx"), "changed");
					return { ranges: request.ranges!.map((range) => ({ ...range, exists: true })) };
				},
			);
			await expect(createResearchDraftAsync(cwd, datasetId, evidenceContent(), ["excel"], null)).rejects.toThrow(
				"changed",
			);
			const state = getResearchFramework(cwd, datasetId);
			expect(state.drafts.filter((draft) => draft.status === "open")).toEqual([]);
		},
	);

	it("rejects foreign or unselected citations before starting any workbook process", async () => {
		const cwd = project();
		const read = vi.spyOn(workbookReader, "readWorkbookDocumentAsync");
		await expect(createResearchDraftAsync(cwd, datasetId, evidenceContent(), [], null)).rejects.toThrow("outside");
		await expect(
			createResearchDraftAsync(cwd, datasetId, evidenceContent(["A1"], "foreign"), ["excel"], null),
		).rejects.toThrow("outside");
		expect(read).not.toHaveBeenCalled();
		expect(getResearchFramework(cwd, datasetId).drafts).toEqual([]);
	});

	it("ends a proposal after exhausted reader timeouts with a visible failure instead of asking for another document", async () => {
		const cwd = project();
		vi.spyOn(workbookReader, "readWorkbookDocumentAsync").mockRejectedValue(
			Object.assign(new Error("Workbook reader failed for excel Valuation!B7 after 2 attempts"), {
				code: "ETIMEDOUT",
				attempts: 2,
			}),
		);
		const result = await peFrameworkTool.execute(
			"exhausted",
			{ operation: "propose", content: evidenceContent(), docIds: ["excel"], expectedVersionId: null },
			undefined,
			undefined,
			{ cwd } as Parameters<typeof peFrameworkTool.execute>[4],
		);
		expect(result.terminate).toBe(true);
		expect(result.details).toMatchObject({
			kind: "pe_framework_error",
			code: "ETIMEDOUT",
			attempts: 2,
			retryExhausted: true,
			error: expect.stringContaining("本次草案未保存"),
			technicalError: expect.stringContaining("Valuation!B7"),
			instruction: expect.stringContaining("Do not regenerate"),
		});
		expect(getResearchFramework(cwd, datasetId).drafts).toEqual([]);
	});

	it("still throws non-timeout errors and does not classify them as exhausted retries", async () => {
		const cwd = project();
		vi.spyOn(workbookReader, "readWorkbookDocumentAsync").mockRejectedValue(
			Object.assign(new Error("Original file changed"), { code: "ENOENT", attempts: 2 }),
		);
		await expect(
			peFrameworkTool.execute(
				"changed",
				{ operation: "propose", content: evidenceContent(), docIds: ["excel"], expectedVersionId: null },
				undefined,
				undefined,
				{ cwd } as Parameters<typeof peFrameworkTool.execute>[4],
			),
		).rejects.toThrow("Original file changed");
		expect(getResearchFramework(cwd, datasetId).drafts).toEqual([]);
	});
});

describe("asynchronous user confirmation", () => {
	it("validates in a batch without a write lock, publishes once with the continuation receipt, and never rereads an idempotent retry", async () => {
		const cwd = project();
		const content = evidenceContent(Array.from({ length: 32 }, (_, index) => `A${index + 1}`));
		const read = vi
			.spyOn(workbookReader, "readWorkbookDocumentAsync")
			.mockImplementation(async (_db, _datasetId, _docId, request) => {
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
				withResearchDatabase(cwd, datasetId, (database) =>
					researchTransaction(database, () =>
						database.exec("UPDATE research_frameworks SET current_version_id=current_version_id"),
					),
				);
				return { ranges: request.ranges!.map((range) => ({ ...range, exists: true })) };
			});
		const draft = await createResearchDraftAsync(cwd, datasetId, content, ["excel"], null);
		const request = {
			draftId: draft.id,
			revision: 1,
			expectedVersionId: null,
			requestId: "confirm",
			continuation: { sessionId: "session", toolCallId: "proposal" },
		};
		const version = await publishResearchDraftAsync(cwd, datasetId, request);
		expect(version.content).toEqual(content);
		expect(read).toHaveBeenCalledTimes(2);
		expect(read.mock.calls[1][3].ranges).toHaveLength(32);
		expect(await publishResearchDraftAsync(cwd, datasetId, request)).toEqual(version);
		expect(read).toHaveBeenCalledTimes(2);
		expect(getResearchFramework(cwd, datasetId)).toMatchObject({
			currentVersionId: version.id,
			versions: [{ id: version.id }],
			drafts: [{ id: draft.id, status: "published" }],
		});
		expect(listResearchContinuations(cwd, datasetId)).toMatchObject([{ versionId: version.id, status: "pending" }]);
		await expect(publishResearchDraftAsync(cwd, datasetId, { ...request, revision: 2 })).rejects.toThrow(
			"different input",
		);
	});

	it.each(["cancel", "draft", "source", "file"] as const)(
		"preserves the unpublished draft if %s changes while validating confirmation",
		async (change) => {
			const cwd = project();
			const read = vi
				.spyOn(workbookReader, "readWorkbookDocumentAsync")
				.mockImplementation(async (_db, _datasetId, _docId, request) => ({
					ranges: request.ranges!.map((range) => ({ ...range, exists: true })),
				}));
			const draft = await createResearchDraftAsync(cwd, datasetId, evidenceContent(), ["excel"], null);
			const controller = new AbortController();
			read.mockImplementation(async (_db, _datasetId, _docId, request) => {
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
				if (change === "cancel") controller.abort(new Error("Cancelled confirmation"));
				else if (change === "draft")
					withResearchDatabase(cwd, datasetId, (database) =>
						database.prepare("UPDATE research_drafts SET revision=revision+1 WHERE draft_id=?").run(draft.id),
					);
				else if (change === "source")
					withResearchDatabase(cwd, datasetId, (database) =>
						database.exec("UPDATE documents SET sha256='changed' WHERE doc_id='excel'"),
					);
				else appendFileSync(join(cwd, "raw/model.xlsx"), "changed");
				return { ranges: request.ranges!.map((range) => ({ ...range, exists: true })) };
			});
			await expect(
				publishResearchDraftAsync(
					cwd,
					datasetId,
					{ draftId: draft.id, revision: 1, expectedVersionId: null, requestId: "confirm" },
					{ signal: controller.signal },
				),
			).rejects.toThrow(change === "cancel" ? "Cancelled confirmation" : "changed");
			expect(getResearchFramework(cwd, datasetId)).toMatchObject({
				currentVersionId: null,
				versions: [],
				drafts: [{ id: draft.id, status: "open" }],
			});
			expect(listResearchContinuations(cwd, datasetId)).toEqual([]);
		},
	);
});
