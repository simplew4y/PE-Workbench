import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({ requests: [] as Record<string, unknown>[], chunks: [] as unknown[] }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: Record<string, unknown>) => {
					mockState.requests.push(structuredClone(params));
					const chunks = mockState.chunks;
					return {
						withResponse: async () => ({
							data: {
								async *[Symbol.asyncIterator]() {
									for (const chunk of chunks) yield chunk;
								},
							},
							response: { status: 200, headers: new Headers() },
						}),
					};
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const qwen = getModel("qwen-token-plan-cn", "qwen3.8-max");
const context: Context = { messages: [{ role: "user", content: "Inspect the workbook.", timestamp: 1 }] };

beforeEach(() => {
	mockState.requests = [];
	mockState.chunks = [{ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }];
});

describe("Qwen3.8 request compatibility", () => {
	it.each(["model samplingParams", "request samplingParams", "onPayload", "compat budget"] as const)(
		"rejects an effort/budget conflict from %s before sending the request",
		async (source) => {
			const model: Model<"openai-completions"> = {
				...qwen,
				...(source === "model samplingParams" ? { samplingParams: { thinking_budget: 4096 } } : {}),
				...(source === "compat budget"
					? { compat: { ...qwen.compat, thinkingTokenBudgetField: "thinking_budget" } }
					: {}),
			};
			const result = await streamSimple(model, context, {
				apiKey: "test",
				reasoning: "xhigh",
				samplingParams: source === "request samplingParams" ? { thinking_budget: 4096 } : undefined,
				onPayload:
					source === "onPayload"
						? (payload) => ({ ...(payload as Record<string, unknown>), thinking_budget: 4096 })
						: undefined,
			}).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(
				"Qwen3.8 does not support reasoning_effort and thinking_budget together",
			);
			expect(mockState.requests).toHaveLength(0);
		},
	);

	it.each(["reasoning_effort", "thinking_budget"] as const)(
		"allows onPayload to resolve the conflict by removing %s",
		async (removedField) => {
			const result = await streamSimple(qwen, context, {
				apiKey: "test",
				reasoning: "xhigh",
				samplingParams: { thinking_budget: 4096 },
				onPayload: (payload) => {
					delete (payload as Record<string, unknown>)[removedField];
				},
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(mockState.requests).toHaveLength(1);
			expect(mockState.requests[0]).not.toHaveProperty(removedField);
			expect(mockState.requests[0]).toHaveProperty(
				removedField === "reasoning_effort" ? "thinking_budget" : "reasoning_effort",
				removedField === "reasoning_effort" ? 4096 : "xhigh",
			);
		},
	);

	it("validates the final Qwen snapshot model name after a payload override", async () => {
		const result = await streamSimple({ ...qwen, id: "research-model" }, context, {
			apiKey: "test",
			reasoning: "medium",
			samplingParams: { model: "qwen3.8-max-0902", thinking_budget: 4096 },
		}).result();

		expect(result.stopReason).toBe("error");
		expect(mockState.requests).toHaveLength(0);
	});

	it.each(["glm-5.2", "qwen3.7-max"])("does not apply the Qwen3.8 restriction to %s", async (modelId) => {
		const result = await streamSimple({ ...qwen, id: modelId }, context, {
			apiKey: "test",
			samplingParams: { reasoning_effort: "high", thinking_budget: 4096 },
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(mockState.requests).toHaveLength(1);
	});

	it("passes a final-answer JSON Schema through request samplingParams", async () => {
		const responseFormat = {
			type: "json_schema",
			json_schema: {
				name: "workbook_fact",
				strict: true,
				schema: {
					type: "object",
					properties: { source_cell: { type: "string" }, value: { type: "number" } },
					required: ["source_cell", "value"],
					additionalProperties: false,
				},
			},
		};
		mockState.chunks = [
			{
				choices: [
					{ delta: { content: '{"source_cell":"Consolidated!AU6","value":17304.9}' }, finish_reason: "stop" },
				],
			},
		];
		const result = await streamSimple(qwen, context, {
			apiKey: "test",
			reasoning: "medium",
			samplingParams: { response_format: responseFormat },
		}).result();

		expect(mockState.requests[0]).toHaveProperty("response_format", responseFormat);
		expect(mockState.requests[0]).toHaveProperty("reasoning_effort", "medium");
		expect(result.content).toEqual([{ type: "text", text: '{"source_cell":"Consolidated!AU6","value":17304.9}' }]);
	});

	it("replays all reasoning_content after streamed tool calls and serialized history restoration", async () => {
		const toolContext: Context = {
			...context,
			tools: [
				{
					name: "read_cell",
					description: "Read a source workbook cell.",
					parameters: Type.Object({ cell: Type.String() }),
				},
			],
		};
		const reasoning = "Read the year header first.\nThen read the matching value.";
		mockState.chunks = [
			{ choices: [{ delta: { reasoning_content: "Read the year header first.\n" }, finish_reason: null }] },
			{ choices: [{ delta: { reasoning_content: "Then read the matching value." }, finish_reason: null }] },
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_read_cell",
									type: "function",
									function: { name: "read_cell", arguments: '{"cell":"Consolidated!' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				choices: [
					{
						delta: { tool_calls: [{ index: 0, function: { arguments: 'AU6"}' } }] },
						finish_reason: "tool_calls",
					},
				],
			},
		];
		const first = await streamSimple(qwen, toolContext, { apiKey: "test", reasoning: "medium" }).result();
		expect(first.stopReason).toBe("toolUse");
		const restoredMessages: Context["messages"] = JSON.parse(
			JSON.stringify([
				...toolContext.messages,
				first,
				{
					role: "toolResult",
					toolCallId: "call_read_cell",
					toolName: "read_cell",
					content: [{ type: "text", text: "17304.9" }],
					isError: false,
					timestamp: 2,
				},
			]),
		);
		mockState.chunks = [{ choices: [{ delta: { content: "Revenue is 17304.9." }, finish_reason: "stop" }] }];
		const second = await streamSimple(
			qwen,
			{ ...toolContext, messages: restoredMessages },
			{ apiKey: "test", reasoning: "medium" },
		).result();

		expect(second.stopReason).toBe("stop");
		expect(mockState.requests).toHaveLength(2);
		expect(mockState.requests[1].messages).toEqual([
			{ role: "user", content: "Inspect the workbook." },
			{
				role: "assistant",
				content: null,
				reasoning_content: reasoning,
				tool_calls: [
					{
						id: "call_read_cell",
						type: "function",
						function: { name: "read_cell", arguments: '{"cell":"Consolidated!AU6"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_read_cell", content: "17304.9" },
		]);
	});
});
