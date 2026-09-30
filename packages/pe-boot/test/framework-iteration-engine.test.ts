import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { createResearchDraft, getResearchFramework, publishResearchDraft } from "../src/research/framework.ts";
import {
	createFrameworkIteration,
	type IterationObservations,
	runFrameworkIteration,
} from "../src/research/iteration.ts";
import { createIterationEngine } from "../src/research/iteration-engine.ts";
import { withResearchDatabase } from "../src/research/storage.ts";
import { sourceId } from "../src/source.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

it("uses restricted SDK tools, rejects a fabricated quote and records actual reads", async () => {
	const root = mkdtempSync(join(tmpdir(), "pe-iteration-engine-"));
	try {
		mkdirSync(join(root, "meta"));
		mkdirSync(join(root, ".pi/extensions"), { recursive: true });
		writeFileSync(join(root, ".pi/extensions/unsafe.ts"), 'throw new Error("PROJECT_EXTENSION_LOADED")');
		writeFileSync(join(root, "AGENTS.md"), "UNTRUSTED_PROJECT_INSTRUCTIONS");
		initializePeCollectionDatabase(join(root, "meta/collection.sqlite3"), {
			datasetId: "dataset_test",
			name: "Test",
		});
		const content = frameworkFixture();
		const draft = createResearchDraft(root, "dataset_test", content, [], null);
		const basis = publishResearchDraft(root, "dataset_test", {
			draftId: draft.id,
			revision: 1,
			expectedVersionId: null,
			requestId: "baseline",
		});
		withResearchDatabase(root, "dataset_test", (db) => {
			db.exec(
				"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,status,created_at,updated_at) VALUES('new','dataset_test','new.pdf','new.pdf','hash','pdf','completed','before','before')",
			);
			db.exec(
				"INSERT INTO pdf_pages VALUES('p1','new',1,'Revenue 9 million in Q2','p1','body','{}','good','{}',100,100,0,'[]',0,0,0)",
			);
		});
		const run = createFrameworkIteration(root, "dataset_test", {
			requestId: "run",
			basisVersionId: basis.id,
			modelId: "test",
			uploadIdentity: "hash",
		});
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const model: Model<"openai-completions"> = {
			id: "test",
			name: "Test",
			provider: "pe-platform",
			api: "openai-completions",
			baseUrl: "https://unused.invalid",
			reasoning: false,
			input: ["text"],
			contextWindow: 100000,
			maxTokens: 8000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const output: IterationObservations = {
			observations: [
				{
					id: "rev",
					docId: "new",
					subject: "Company",
					metric: "Revenue",
					value: 9,
					period: "Q2",
					unit: "million",
					role: "fact",
					quote: "revenue 9 million in Q2",
					evidenceIds: [sourceId({ docId: "new", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } })],
					gaps: ["Volume unknown"],
				},
			],
			coverage: [{ docId: "new", readLocations: ["pretend"], gaps: [] }],
		};
		let calls = 0;
		let revision = false;
		const candidate = structuredClone(content);
		candidate.sections.investmentJudgments.items[0].claim = "Revenue is 9 million; volume unknown";
		candidate.sections.evidenceAndChanges.changes.push({
			judgmentIds: ["demand"],
			before: content.sections.investmentJudgments.items[0].claim,
			after: candidate.sections.investmentJudgments.items[0].claim,
			reason: "New quarter",
			evidenceIds: output.observations[0].evidenceIds,
		});
		const patch = {
			sections: {
				currentAssessment: candidate.sections.currentAssessment,
				investmentJudgments: candidate.sections.investmentJudgments,
				evidenceAndChanges: candidate.sections.evidenceAndChanges,
			},
		};
		runtime.registerNativeProvider({
			id: "pe-platform",
			name: "Test",
			getModels: () => [model],
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test-only" }, source: "test" }) } },
			stream() {
				throw new Error("No network allowed");
			},
			streamSimple(_model, context) {
				expect(context.tools?.map((t) => t.name).sort()).toEqual(["pe_iteration_read", "pe_iteration_submit"]);
				expect(context.systemPrompt).not.toContain("UNTRUSTED_PROJECT_INSTRUCTIONS");
				const call = calls++;
				if (revision) {
					const submit = context.tools?.find((t) => t.name === "pe_iteration_submit");
					expect(JSON.stringify(submit?.parameters)).not.toContain("researchSetup");
				}
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content: [
						{
							type: "toolCall",
							id: `call${call}`,
							name: !revision && call === 0 ? "pe_iteration_read" : "pe_iteration_submit",
							arguments: revision
								? call === 0
									? { ...patch, title: "Unauthorized title" }
									: patch
								: call === 0
									? { docId: "new", page: 1 }
									: call === 1
										? {
												...output,
												observations: [
													{ ...output.observations[0], quote: "Revenue 9 million in Q3" },
													{ ...output.observations[0], id: "second", quote: "Revenue 9 billion in Q2" },
												],
											}
										: output,
						},
					],
					stopReason: "toolUse",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end(message);
				return stream;
			},
		});
		const errors: string[] = [];
		const sdk = createIterationEngine(
			root,
			"dataset_test",
			async () => runtime,
			() => {},
			(value) => {
				if (value.error) errors.push(value.error);
			},
		);
		const result = await runFrameworkIteration(
			root,
			"dataset_test",
			run.id,
			{
				...sdk,
				impact: async () => ({ substantive: false, summary: "No change", impacts: [], gaps: ["Volume unknown"] }),
			},
			async () => ({ docIds: ["new"], warnings: [] }),
			AbortSignal.timeout(5000),
		);
		expect(result.status).toBe("no_change");
		expect(calls).toBe(3);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("rev、second");
		const extracted = result.artifacts.find((a) => a.stage === "extract")!.value as IterationObservations;
		expect(extracted.coverage[0].readLocations).toEqual(['{"docId":"new","page":1}']);
		revision = true;
		calls = 0;
		const second = createFrameworkIteration(root, "dataset_test", {
			requestId: "revision",
			basisVersionId: basis.id,
			modelId: "test",
			uploadIdentity: "hash",
		});
		const revised = await runFrameworkIteration(
			root,
			"dataset_test",
			second.id,
			{
				...sdk,
				extract: async () => output,
				impact: async () => ({
					substantive: true,
					summary: "Update demand",
					impacts: [
						{
							judgmentIds: ["demand"],
							sections: ["investmentJudgments"],
							observationIds: ["rev"],
							relation: "supplements",
							comparable: true,
							reason: "New quarter",
							proposedChange: "Record revenue and unknown volume",
							evidenceIds: output.observations[0].evidenceIds,
						},
					],
					gaps: ["Volume unknown"],
				}),
			},
			async () => ({ docIds: ["new"], warnings: [] }),
			AbortSignal.timeout(5000),
		);
		expect(revised.status).toBe("review_required");
		expect(calls).toBe(2);
		const stored = getResearchFramework(root, "dataset_test").drafts.find((d) => d.id === revised.draftId)?.content;
		expect(stored).toEqual(candidate);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
