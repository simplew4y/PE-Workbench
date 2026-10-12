import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { informationSourceConfig } from "../src/information-source-model.ts";
import { listInformationSourceQueries } from "../src/information-source-store.ts";
import { createResearchDraft, publishResearchDraft } from "../src/research/framework.ts";
import {
	createFrameworkIteration,
	recordIterationDiagnostic,
	recordIterationUsage,
	runFrameworkIteration,
} from "../src/research/iteration.ts";
import { createIterationEngine } from "../src/research/iteration-engine.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

it.each(["submit", "budget", "authentication"] as const)(
	"runs a restricted Pi collector with %s handling",
	async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "pe-source-engine-"));
		try {
			for (const path of ["raw", "meta", ".pi/extensions"]) mkdirSync(join(root, path), { recursive: true });
			writeFileSync(join(root, "AGENTS.md"), "UNTRUSTED_COLLECTION_INSTRUCTIONS");
			writeFileSync(join(root, ".pi/extensions/unsafe.ts"), 'throw new Error("UNSAFE_EXTENSION")');
			initializePeCollectionDatabase(join(root, "meta/collection.sqlite3"), {
				datasetId: "dataset_test",
				name: "Company",
			});
			const draft = createResearchDraft(root, "dataset_test", frameworkFixture(), [], null);
			const version = publishResearchDraft(root, "dataset_test", {
				draftId: draft.id,
				revision: 1,
				expectedVersionId: null,
				requestId: "baseline",
			});
			const run = createFrameworkIteration(root, "dataset_test", {
				requestId: "run",
				basisVersionId: version.id,
				modelId: "test",
				uploadIdentity: "source",
				sourceMode: "sources",
				sourceConfig: informationSourceConfig("Company", "0700.HK", ["wind-financials"]),
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
				maxTokens: 10000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			let calls = 0;
			let windCalls = 0;
			runtime.registerNativeProvider({
				id: "pe-platform",
				name: "Test",
				getModels: () => [model],
				auth: {
					apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test-only" }, source: "test" }) },
				},
				stream() {
					throw new Error("Network forbidden");
				},
				streamSimple(_model, context) {
					expect(context.tools?.map((tool) => tool.name).sort()).toEqual([
						"pe_information_source_fetch",
						"pe_iteration_read",
						"pe_iteration_submit",
					]);
					expect(context.systemPrompt).not.toContain("UNTRUSTED_COLLECTION_INSTRUCTIONS");
					expect(context.systemPrompt).toContain("最多4个不同业务查询");
					expect(context.systemPrompt).toContain("definitionChecks补查");
					const index = calls++;
					const message: AssistantMessage = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: Date.now(),
						content: [
							{
								type: "toolCall",
								id: `call-${index}`,
								name: mode === "submit" && index > 0 ? "pe_iteration_submit" : "pe_information_source_fetch",
								arguments:
									mode === "submit" && index > 0
										? { summary: "取得财务数据", gaps: [] }
										: {
												sourceId: "wind-financials",
												metrics: ["营业收入"],
												periods: ["2025年年报"],
												purpose: "核查需求",
												definitionChecks: ["period", "scope"],
												judgmentIds: ["demand"],
											},
							},
						],
						stopReason: mode === "authentication" ? "error" : "toolUse",
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
					if (mode === "authentication") {
						message.errorMessage = "402 insufficient balance";
						stream.push({ type: "error", reason: "error", error: message });
					} else stream.push({ type: "done", reason: "toolUse", message });
					stream.end(message);
					return stream;
				},
			});
			const sdk = createIterationEngine(
				root,
				"dataset_test",
				async () => runtime,
				(value) => recordIterationUsage(root, "dataset_test", run.id, value),
				(value) => recordIterationDiagnostic(root, "dataset_test", run.id, value),
				async () => {
					windCalls++;
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									data: {
										data: [
											{
												columns: [{ name: "Wind代码" }, { name: "2025年年报营业收入", unit: "亿元" }],
												rows: [["0700.HK", 9]],
											},
										],
									},
									error: null,
								}),
							},
						],
						isError: false,
					};
				},
			);
			const result = await runFrameworkIteration(
				root,
				"dataset_test",
				run.id,
				{
					...sdk,
					extract: async (value) => ({
						observations: [],
						coverage: value.newDocIds.map((docId) => ({
							docId,
							readLocations: ["read"],
							gaps: ["本例只验证采集，不宣称业务研究通过"],
						})),
					}),
					impact: async () => ({ substantive: false, summary: "不修改框架", impacts: [], gaps: [] }),
				},
				async () => {
					throw new Error("Uploads forbidden");
				},
				AbortSignal.timeout(5000),
			);
			expect(
				result.status,
				JSON.stringify({ error: result.error, calls, windCalls, diagnostics: result.diagnostics.slice(-3) }),
			).toBe(mode === "authentication" ? "blocked" : "no_change");
			expect(calls).toBe(mode === "submit" ? 2 : mode === "budget" ? 8 : 1);
			expect(windCalls).toBe(mode === "authentication" ? 0 : 1);
			if (mode !== "authentication") {
				const query = listInformationSourceQueries(root, "dataset_test", run.id)[0];
				expect(query.attempts).toHaveLength(1);
				expect(query.query.definitionChecks).toEqual(["period", "scope"]);
				expect(query.actualQuery).toContain("单季/累计统计口径");
				expect(query.actualQuery).toContain("合并/母公司/分部/调整后报表口径");
				expect(query.actualQuery).toContain("未知返回空");
			}
			if (mode === "budget") expect(result.reviewReasons.join()).toContain("未声明全面覆盖");
			expect(result.versionId).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
