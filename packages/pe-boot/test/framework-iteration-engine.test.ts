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
	type IterationImpacts,
	type IterationObservations,
	runFrameworkIteration,
} from "../src/research/iteration.ts";
import { createIterationEngine } from "../src/research/iteration-engine.ts";
import { withResearchDatabase } from "../src/research/storage.ts";
import { sourceId } from "../src/source.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

it.each(["tool", "text", "stubborn", "error"] as const)(
	"handles %s completion with restricted SDK tools and validated submissions",
	async (completion) => {
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
					"INSERT INTO pdf_pages VALUES('p1','new',1,'Revenue 9 million in Q2；經營虧損','p1','body','{}','good','{}',100,100,0,'[]',0,0,0)",
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
						quote: "Revenue 9 million in Q2；經營虧損",
						evidenceIds: [sourceId({ docId: "new", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } })],
						gaps: ["Volume unknown"],
						context: {
							periodKind: "single",
							asOf: null,
							scope: "Company",
							basisQuote: "Revenue 9 million in Q2；經營虧損",
							eventKind: "none",
							reviewReasons: [],
						},
					},
				],
				coverage: [{ docId: "new", readLocations: ["pretend"], gaps: [] }],
			};
			let calls = 0;
			let revision = false;
			let impactMode = false;
			const impactOutput: IterationImpacts = {
				substantive: true,
				summary: "补充收入",
				gaps: [],
				impacts: [0, 1].map(() => ({
					judgmentIds: ["demand"],
					sections: ["investmentJudgments"],
					observationIds: ["rev"],
					relation: "supplements",
					comparable: true,
					comparisonBasis: { period: "Q2", periodKind: "single", scope: "Company" },
					reason: "新增季度",
					proposedChange: "补充收入",
					evidenceIds: output.observations[0].evidenceIds,
				})),
			};
			const candidate = structuredClone(content);
			candidate.sections.researchSetup.informationCutoff = null;
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
					researchSetup: candidate.sections.researchSetup,
					currentAssessment: candidate.sections.currentAssessment,
					investmentJudgments: candidate.sections.investmentJudgments,
					evidenceAndChanges: candidate.sections.evidenceAndChanges,
				},
			};
			runtime.registerNativeProvider({
				id: "pe-platform",
				name: "Test",
				getModels: () => [model],
				auth: {
					apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test-only" }, source: "test" }) },
				},
				stream() {
					throw new Error("No network allowed");
				},
				streamSimple(_model, context) {
					expect(context.tools?.map((t) => t.name).sort()).toEqual(["pe_iteration_read", "pe_iteration_submit"]);
					expect(context.systemPrompt).not.toContain("UNTRUSTED_PROJECT_INSTRUCTIONS");
					expect(context.systemPrompt).toContain("统一使用简体中文");
					expect(context.systemPrompt).toContain("quote、context.basisQuote 必须保留原文，不做繁简转换");
					const rawCall = calls++;
					const call = !revision && completion === "text" && rawCall >= 2 ? rawCall - 1 : rawCall;
					const textOnly =
						!revision && completion !== "tool" && rawCall >= 1 && (completion === "stubborn" || rawCall === 1);
					if (revision) {
						const submit = context.tools?.find((t) => t.name === "pe_iteration_submit");
						expect(JSON.stringify(submit?.parameters)).toContain("researchSetup");
					}
					const message: AssistantMessage = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: Date.now(),
						content: textOnly
							? [{ type: "text", text: "Analysis complete; waiting for user input." }]
							: [
									{
										type: "toolCall",
										id: `call${call}`,
										name:
											!revision && !impactMode && call === 0 ? "pe_iteration_read" : "pe_iteration_submit",
										arguments: impactMode
											? call === 0
												? {
														...impactOutput,
														impacts: [
															{
																...impactOutput.impacts[0],
																sections: ["currentAssessment"],
																comparisonBasis: { period: "Q1", periodKind: "single", scope: "Other" },
															},
															impactOutput.impacts[1],
														],
													}
												: { impactUpdates: [{ index: 0, impact: impactOutput.impacts[0] }] }
											: revision
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
																	{ ...output.observations[0], id: "second" },
																],
															}
														: { observations: output.observations },
									},
								],
						stopReason: textOnly && completion === "error" ? "error" : textOnly ? "stop" : "toolUse",
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
					if (message.stopReason === "error") {
						message.errorMessage = "402 insufficient balance";
						stream.push({ type: "error", reason: "error", error: message });
					} else stream.push({ type: "done", reason: textOnly ? "stop" : "toolUse", message });
					stream.end(message);
					return stream;
				},
			});
			const errors: string[] = [];
			let completionReminders = 0;
			const sdk = createIterationEngine(
				root,
				"dataset_test",
				async () => runtime,
				() => {},
				(value) => {
					if (value.error) errors.push(value.error);
					if (value.tool === "pe_iteration_completion_retry") completionReminders++;
				},
			);
			const result = await runFrameworkIteration(
				root,
				"dataset_test",
				run.id,
				{
					...sdk,
					impact: async () => ({
						substantive: false,
						summary: "No change",
						impacts: [],
						gaps: ["Volume unknown"],
					}),
				},
				async () => ({ docIds: ["new"], warnings: [] }),
				AbortSignal.timeout(5000),
			);
			if (completion === "error") {
				expect(result.status).toBe("blocked");
				expect(calls).toBe(2);
				expect(completionReminders).toBe(0);
				expect(result.draftId).toBeNull();
				return;
			}
			if (completion === "stubborn") {
				expect(result.status).toBe("failed");
				expect(result.error).toContain("最多两次");
				expect(calls).toBe(4);
				expect(completionReminders).toBe(2);
				expect(result.draftId).toBeNull();
				return;
			}
			expect(result.status).toBe("no_change");
			expect(calls).toBe(completion === "text" ? 4 : 3);
			expect(completionReminders).toBe(completion === "text" ? 1 : 0);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("rev");
			const extracted = result.artifacts.find((a) => a.stage === "extract")!.value as IterationObservations;
			expect(extracted.observations.map((observation) => observation.id)).toEqual(["rev", "second"]);
			expect(extracted.observations[0].quote).toBe(output.observations[0].quote);
			expect(extracted.observations[0].context.basisQuote).toBe(output.observations[0].context.basisQuote);
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
								comparisonBasis: { period: "Q2", periodKind: "single", scope: "Company" },
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
			const stored = getResearchFramework(root, "dataset_test").drafts.find(
				(d) => d.id === revised.draftId,
			)?.content;
			expect(stored).toEqual(candidate);
			if (completion === "tool") {
				revision = false;
				impactMode = true;
				calls = 0;
				errors.length = 0;
				run.newDocIds = ["new"];
				const analyzed = await sdk.impact(run, content, output, AbortSignal.timeout(5000));
				expect(analyzed).toEqual(impactOutput);
				expect(calls).toBe(2);
				expect(errors).toHaveLength(1);
				expect(errors[0]).toContain("investmentJudgments");
				expect(errors[0]).toContain("比较期间或口径");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
