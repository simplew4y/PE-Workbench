import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { insertModelVersion, withModelUpdateDatabase } from "../src/model-update-storage.ts";
import { type AutomaticSetup, validateAutomaticSetup } from "../src/research/automatic-setup.ts";
import { createResearchDraft, getResearchFramework, publishResearchDraft } from "../src/research/framework.ts";
import { createFrameworkIteration } from "../src/research/iteration.ts";
import { createIterationEngine } from "../src/research/iteration-engine.ts";
import { frameworkFixture } from "./fixtures/framework.ts";
import { workbookSourceFixture } from "./workbook-source-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const { root, datasetId, docId } = await workbookSourceFixture();
	roots.push(root);
	const basis = frameworkFixture({ title: "测试公司 000001.SZ 投资框架" });
	const draft = createResearchDraft(root, datasetId, basis, [docId], null);
	const version = publishResearchDraft(root, datasetId, {
		draftId: draft.id,
		revision: 1,
		expectedVersionId: null,
		requestId: "initial",
	});
	const run = createFrameworkIteration(root, datasetId, {
		requestId: "identify",
		basisVersionId: version.id,
		modelId: "test",
		uploadIdentity: "existing-files",
	});
	const setup: AutomaticSetup = {
		companyName: "测试公司",
		companyTicker: "000001.SZ",
		valuationDate: "2026-08-31",
		identitySources: [],
		dateSource: { sheet: "Valuation", cell: "B1", text: "2026-08-31T00:00:00" },
		dateLabelSource: { sheet: "Valuation", cell: "A1", text: "Valuation Date" },
		model: {
			expectedRevision: 0,
			docId,
			baseVersionId: null,
			valuationDate: "2026-08-31",
			mappings: [
				{
					id: "cash-flow",
					subject: "测试公司",
					metric: "Free cash flow",
					period: "2026Q3",
					periodKind: "single",
					asOf: null,
					unit: "CNY",
					scope: "公司",
					currency: "CNY",
					role: "actual",
					sheet: "DCF",
					cell: "B2",
					expectedValue: 100,
					judgmentIds: ["demand"],
					sensitivity: "现金流影响每股价值",
				},
			],
			outputs: [{ key: "每股价值", sheet: "DCF", cell: "B7" }],
		},
		summary: "已找到估值模型、估值日期和现金流输入。",
	};
	return { root, datasetId, docId, basis, version, run, setup };
}

it.each(["formula", "old-value", "wrong-date", "wrong-company", "outside-file"])(
	"rejects automatically inferred %s instead of writing an unsupported model change",
	async (condition) => {
		const { root, datasetId, basis, run, setup } = await fixture();
		if (condition === "formula") {
			setup.model.mappings[0].cell = "B7";
			setup.model.mappings[0].expectedValue = 200;
		}
		if (condition === "old-value") setup.model.mappings[0].expectedValue = 99;
		if (condition === "wrong-date") {
			setup.valuationDate = "2026-08-30";
			setup.model.valuationDate = setup.valuationDate;
		}
		if (condition === "wrong-company") setup.companyTicker = "9999.HK";
		if (condition === "outside-file") setup.model.docId = "outside";
		expect(() => validateAutomaticSetup(root, datasetId, run, basis, setup)).toThrow();
		expect(getResearchFramework(root, datasetId).versions).toHaveLength(1);
	},
);

it.each([null, "adopted-model"])(
	"the restricted LLM reads writable inputs and discovers current version %s without configuration",
	async (versionId) => {
		const { root, datasetId, docId, basis, run, setup } = await fixture();
		if (versionId) {
			const source = withModelUpdateDatabase(
				root,
				datasetId,
				(db) => db.prepare("SELECT stored_path,raw_path FROM documents WHERE doc_id=?").get(docId)!,
			);
			const bytes = readFileSync(join(root, String(source.stored_path || source.raw_path)));
			const path = `generated/model-updates/${docId}/${versionId}/model.xlsx`;
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), bytes);
			withModelUpdateDatabase(root, datasetId, (db) =>
				insertModelVersion(
					db,
					{
						version_id: versionId,
						dataset_id: datasetId,
						doc_id: docId,
						parent_version_id: null,
						state: "reviewed",
						file_relpath: path,
						file_sha256: createHash("sha256").update(bytes).digest("hex"),
						manifest_json: "{}",
						created_at: run.createdAt,
					},
					true,
				),
			);
			setup.model.baseVersionId = versionId;
		}
		expect(validateAutomaticSetup(root, datasetId, run, basis, setup)).toEqual(setup);
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
			contextWindow: 64000,
			maxTokens: 8000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		let calls = 0;
		runtime.registerNativeProvider({
			id: "pe-platform",
			name: "Test",
			getModels: () => [model],
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test-only" }, source: "test" }) } },
			stream() {
				throw new Error("Network is not used in this test");
			},
			streamSimple(_model, context) {
				expect(context.tools?.map((tool) => tool.name).sort()).toEqual([
					"pe_iteration_read",
					"pe_iteration_submit",
				]);
				expect(context.systemPrompt).toContain("不要求用户选择文件、绑定输入或填写日期");
				const call = calls++;
				if (call === 2)
					expect(
						context.messages
							.filter((message) => message.role === "toolResult")
							.flatMap((message) => message.content)
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n"),
					).toContain(`model_version_id=${JSON.stringify(versionId)}`);
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					stopReason: "toolUse",
					content: [
						{
							type: "toolCall",
							id: `prepare-${call}`,
							name: call === 1 ? "pe_iteration_read" : "pe_iteration_submit",
							arguments:
								call === 1
									? {
											docId,
											action: "read",
											ranges: [
												{ sheet: "Valuation", range: "A1:B1" },
												{ sheet: "DCF", range: "A2:B2" },
											],
										}
									: setup,
						},
					],
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
		const engine = createIterationEngine(
			root,
			datasetId,
			async () => runtime,
			() => {},
			(diagnostic) => {
				if (diagnostic.error) errors.push(diagnostic.error);
			},
		);
		const result = await engine.prepare!(run, basis, AbortSignal.timeout(10_000)).catch((error: unknown) => {
			throw new Error(JSON.stringify(errors), { cause: error });
		});
		expect(result).toEqual(setup);
		expect(calls).toBe(3);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("读取工具核对每个模型输入");
		expect(getResearchFramework(root, datasetId).versions).toHaveLength(1);
	},
	20_000,
);
