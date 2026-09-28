import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { createPiResearchEngine } from "../src/research/pi-engine.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

it("runs the real SDK with only scoped evidence and submission tools, without project resources or paid calls", async () => {
	const root = mkdtempSync(join(tmpdir(), "pe-research-sdk-"));
	try {
		mkdirSync(join(root, ".pi/extensions"), { recursive: true });
		writeFileSync(join(root, ".pi/extensions/unsafe.ts"), 'throw new Error("PROJECT_EXTENSION_LOADED");');
		writeFileSync(join(root, "AGENTS.md"), "PROJECT_CONTEXT_MUST_NOT_APPEAR");
		const content = frameworkFixture({
			title: "框架",
			objective: "检查需求",
			horizon: "一年",
			coverageGaps: ["暂无资料"],
			items: [
				{
					id: "demand",
					kind: "hypothesis",
					claim: "需求可能恢复",
					subject: "公司",
					rationale: "用户假设",
					verification: "订单恢复",
					invalidation: "订单下滑",
					origin: "user",
					evidenceIds: [],
				},
			],
		});
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const model: Model<"openai-completions"> = {
			id: "research-test",
			name: "Research test",
			api: "openai-completions",
			provider: "research-test",
			baseUrl: "https://unused.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 8000,
		};
		let calls = 0;
		const provider: Provider = {
			id: model.provider,
			name: "Research test",
			getModels: () => [model],
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test-only" }, source: "test" }) } },
			stream: () => {
				throw new Error("Unexpected raw stream");
			},
			streamSimple: (_model, context) => {
				expect(context.tools?.map((tool) => tool.name).sort()).toEqual(["pe_research_read", "pe_research_submit"]);
				expect(context.systemPrompt).not.toContain("PROJECT_CONTEXT_MUST_NOT_APPEAR");
				const first = calls++ === 0;
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content: first
						? [{ type: "toolCall", id: "submit", name: "pe_research_submit", arguments: content }]
						: [{ type: "text", text: "已提交草稿" }],
					stopReason: first ? "toolUse" : "stop",
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
				stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
				stream.end(message);
				return stream;
			},
		};
		runtime.registerNativeProvider(provider);
		const engine = createPiResearchEngine(root, "dataset_test", runtime, model.provider, model.id);
		expect(
			await engine.generate(
				{ objective: "整理我的假设", inputs: [], asOf: new Date().toISOString() },
				null,
				new AbortController().signal,
			),
		).toEqual(content);
		expect(calls).toBe(1); // A structured submission is terminal; never request a redundant model turn.
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
