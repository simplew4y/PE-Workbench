import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createHarness,
	getMessageText,
	type Harness,
	type HarnessOptions,
} from "../../coding-agent/test/suite/harness.ts";
import { getPeCapabilityTools, type PeCapabilityOptions } from "../src/capabilities.ts";
import { buildPeSystemPrompt } from "../src/system-prompt.ts";
import { registerPeTools } from "../src/tools/index.ts";
import { peRenderUiTool } from "../src/tools/render-ui.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
	vi.unstubAllEnvs();
});
async function setup(options: PeCapabilityOptions = {}, overrides: HarnessOptions = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pe-capabilities-"));
	directories.push(cwd);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager: SettingsManager.inMemory(),
		systemPrompt: buildPeSystemPrompt(cwd),
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [(pi) => registerPeTools(pi, options)],
	});
	await loader.reload();
	const harness = await createHarness({
		systemPrompt: buildPeSystemPrompt("/workspace"),
		settings: { compaction: { enabled: false } },
		resourceLoader: loader,
		...overrides,
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		mode: "rpc",
		onError: (error) => {
			throw new Error(error.error);
		},
	});
	return harness;
}
const load = (ids: string[]) =>
	fauxAssistantMessage(fauxToolCall("pe_load_capability", { capabilities: ids }), { stopReason: "toolUse" });
const pinned = (messages: AgentMessage[]) =>
	messages.filter((message) => message.role === "custom" && message.customType === "pe-capability-instructions");

describe("PE capability runtime", () => {
	it("loads research stages with shared state once, restores them, and preserves host permissions", async () => {
		const allowed = ["pe_load_capability", "pe_excel_range", "pe_formula_trace"];
		const h = await setup({}, { allowedToolNames: allowed });
		for (const stage of [
			"business-driver-model",
			"independent-investment-case",
			"expectations-valuation",
			"falsification-monitoring",
			"framework-reviewer",
		]) {
			h.setResponses([load(["investment-framework-builder", stage]), fauxAssistantMessage("done")]);
			await h.session.prompt(`Load research stage: ${stage}`);
			const instructions = getMessageText(
				pinned(await h.session.extensionRunner.emitContext(h.session.messages))[0],
			);
			expect(instructions).toContain(`${stage}/SKILL.md`);
			expect(instructions).toContain("investment-framework-builder/SKILL.md");
			expect(instructions.match(/<workflow_file path=.*references\/state-contract.md/g)).toHaveLength(1);
			expect(instructions).not.toContain("pe-valuation-report/SKILL.md");
			expect(h.session.getActiveToolNames().sort()).toEqual([...allowed].sort());
		}
		await h.session.reload();
		const restored = getMessageText(pinned(await h.session.extensionRunner.emitContext(h.session.messages))[0]);
		expect(restored).toContain("framework-reviewer/SKILL.md");
		expect(restored).toContain("valuation-model-review/references/model-understanding.md");
		expect(restored).not.toMatch(/<workflow_file path=.*expectations-valuation\/SKILL.md/);
		expect(h.eventsOfType("tool_execution_end").every((event) => !event.isError)).toBe(true);
	});

	it("loads model understanding and research without report instructions or widening a read-only host", async () => {
		const allowed = ["pe_load_capability", "pe_excel_range", "pe_formula_trace"];
		const h = await setup({}, { allowedToolNames: allowed });
		h.setResponses([
			load(["pe-investment-research", "pe-financial-model-understanding"]),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("Explain forecasts and prepare research questions");
		const instructions = getMessageText(pinned(await h.session.extensionRunner.emitContext(h.session.messages))[0]);
		for (const name of ["pe-financial-model-reader", "pe-financial-model-understanding", "pe-investment-research"])
			expect(instructions.match(new RegExp(`<workflow_file path=.*${name}/SKILL.md`, "g"))).toHaveLength(1);
		expect(instructions).not.toContain("pe-valuation-report/SKILL.md");
		expect(h.session.getActiveToolNames().sort()).toEqual([...allowed].sort());
		expect(h.eventsOfType("tool_execution_end").every((event) => !event.isError)).toBe(true);
	});

	it("delays UI schemas, then adds the native tool and its instructions on the next real agent turn", async () => {
		const h = await setup();
		expect(h.session.getActiveToolNames()).not.toContain("pe_render_ui");
		expect(h.session.getAllTools().map((tool) => tool.name)).toContain("pe_render_ui");
		const component = {
			kind: "kpi_strip",
			title: "Test fixture",
			metrics: [
				{ label: "Revenue", value: "100" },
				{ label: "Profit", value: "10" },
			],
		};
		h.setResponses([
			(context) => {
				expect(context.tools?.some((tool) => tool.name === "pe_render_ui")).toBe(false);
				expect(context.messages.map(getMessageText).join("\n")).not.toContain("# Component Selection");
				return load(["pe-generative-ui"]);
			},
			(context) => {
				expect(context.tools?.find((tool) => tool.name === "pe_render_ui")?.parameters).toEqual(
					peRenderUiTool.parameters,
				);
				expect(context.messages.map(getMessageText).join("\n")).toContain("# Component Selection");
				expect(
					context.messages.filter((m) => m.role === "toolResult").flatMap((m) => m.addedToolNames ?? []),
				).toEqual(["pe_render_ui"]);
				return fauxAssistantMessage(fauxToolCall("pe_render_ui", { version: 1, component }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const result = context.messages.filter((m) => m.role === "toolResult" && m.toolName === "pe_render_ui");
				expect(result).toHaveLength(1);
				expect(result[0]).toMatchObject({ role: "toolResult", isError: false });
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("Test the capability tool protocol");
		expect(h.getPendingResponseCount()).toBe(0);
		expect(h.eventsOfType("tool_execution_end").every((event) => !event.isError)).toBe(true);
	});

	it("deduplicates dependencies and repeated loads, and replaces workflows when the task changes", async () => {
		const h = await setup();
		h.setResponses([load(["pe-valuation-report"]), load(["pe-valuation-report"]), fauxAssistantMessage("done")]);
		await h.session.prompt("Test instruction loading");
		const context = await h.session.extensionRunner.emitContext(h.session.messages);
		const text = getMessageText(pinned(context)[0]);
		expect(text.match(/<workflow_file path=.*pe-document-retrieval\/SKILL.md/g)).toHaveLength(1);
		expect(text).toContain("repair_scope=sections");
		expect(text).toContain("workbook-verification.md");
		expect(text).toContain("answer-structure.md");
		expect(
			h.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === "pe-capability-state"),
		).toHaveLength(1);
		expect(pinned(await h.session.extensionRunner.emitContext(context))).toHaveLength(1);
		h.setResponses([load(["pe-document-retrieval"]), fauxAssistantMessage("done")]);
		await h.session.prompt("Next task uses retrieval only");
		const next = await h.session.extensionRunner.emitContext(h.session.messages);
		expect(pinned(next)).toHaveLength(1);
		expect(getMessageText(pinned(next)[0])).not.toContain("repair_scope=sections");
	});

	it("recovers instructions and UI after compaction/reload and isolates branch state", async () => {
		const h = await setup();
		const beforeId = h.sessionManager.appendMessage({ role: "user", content: "before loading", timestamp: 1 });
		h.setResponses([load(["pe-generative-ui"]), fauxAssistantMessage("done")]);
		await h.session.prompt("Load visual workflow");
		const kept = h.sessionManager.appendMessage({ role: "user", content: "continue", timestamp: 2 });
		h.sessionManager.appendCompaction("Instructions were removed from the summary.", kept, 100);
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		await h.session.reload();
		const context = await h.session.extensionRunner.emitContext(h.session.messages);
		expect(pinned(context)).toHaveLength(1);
		expect(getMessageText(pinned(context)[0])).toContain("# Component Selection");
		expect(h.session.getActiveToolNames()).toContain("pe_render_ui");
		await h.session.navigateTree(beforeId, { summarize: false });
		expect(pinned(await h.session.extensionRunner.emitContext(h.session.messages))).toHaveLength(0);
		expect(h.session.getActiveToolNames()).not.toContain("pe_render_ui");
	});

	it("preloads tracking instructions without widening its hard tool allow-list", async () => {
		const allowed = ["read", "ls", ...getPeCapabilityTools(["stock-tracking"])];
		const h = await setup({ initialCapabilities: ["stock-tracking"] }, { allowedToolNames: allowed });
		h.setResponses([
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				expect(text).toContain("第一步：判断公司类型");
				expect(context.systemPrompt).toContain("- pe_stock_tracking:");
				expect(context.systemPrompt).not.toContain("- pe_render_ui:");
				expect(context.systemPrompt).not.toContain("- pe_dataset_memo:");
				expect(text).toContain("workbook-verification.md");
				expect(context.tools?.map((tool) => tool.name).sort()).toEqual([...allowed].sort());
				expect(text).not.toContain("# PE Generative UI");
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("Test known entrypoint preload");
		expect(h.getPendingResponseCount()).toBe(0);
	});

	it("refuses lazy tools outside the hard allow-list and preserves disabled regular tools", async () => {
		const h = await setup({}, { allowedToolNames: ["pe_load_capability"] });
		h.setResponses([load(["pe-generative-ui"]), fauxAssistantMessage("done")]);
		await h.session.prompt("Attempt to load excluded UI");
		expect(h.eventsOfType("tool_execution_end")[0].isError).toBe(true);
		expect(h.session.getActiveToolNames()).toEqual(["pe_load_capability"]);
		expect(pinned(await h.session.extensionRunner.emitContext(h.session.messages))).toHaveLength(0);
		h.setResponses([load(["pe-document-retrieval"]), fauxAssistantMessage("done")]);
		await h.session.prompt("Instructions cannot activate forbidden PDF tools");
		expect(h.session.getActiveToolNames()).toEqual(["pe_load_capability"]);
		expect(getMessageText(pinned(await h.session.extensionRunner.emitContext(h.session.messages))[0])).toContain(
			"Unavailable tools: pe_pdf_list",
		);
	});

	it("honors a runtime host policy even when the SDK registry still contains UI", async () => {
		let permit = false;
		const h = await setup({ canActivateTool: () => permit });
		h.setResponses([load(["pe-generative-ui"]), fauxAssistantMessage("done")]);
		await h.session.prompt("Host disabled UI");
		expect(h.eventsOfType("tool_execution_end")[0].isError).toBe(true);
		expect(h.session.getActiveToolNames()).not.toContain("pe_render_ui");
		permit = true;
		h.setResponses([load(["pe-generative-ui"]), fauxAssistantMessage("done")]);
		await h.session.prompt("Host allows UI");
		expect(h.session.getActiveToolNames()).toContain("pe_render_ui");
		permit = false;
		await h.session.reload();
		expect(h.session.getActiveToolNames()).not.toContain("pe_render_ui");
	});

	it("preloads an explicit UI-only entrypoint without requiring a forbidden loader", async () => {
		const h = await setup({ initialCapabilities: ["pe-generative-ui"] }, { allowedToolNames: ["pe_render_ui"] });
		expect(h.session.getActiveToolNames()).toEqual(["pe_render_ui"]);
		h.setResponses([
			(context) => {
				expect(context.messages.map(getMessageText).join("\n")).toContain("# Component Selection");
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("Explicit visual entrypoint");
		expect(h.getPendingResponseCount()).toBe(0);
	});

	it("rejects unknown/disabled capability IDs before changing state", async () => {
		vi.stubEnv("PE_CONSENSUS_ENABLED", "0");
		const h = await setup();
		h.setResponses([load(["../../outside"]), load(["pe-consensus-divergence"]), fauxAssistantMessage("done")]);
		await h.session.prompt("Validate capability IDs");
		expect(h.eventsOfType("tool_execution_end")).toHaveLength(2);
		expect(h.eventsOfType("tool_execution_end").every((event) => event.isError)).toBe(true);
		expect(
			h.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === "pe-capability-state"),
		).toHaveLength(0);
		expect(h.session.getActiveToolNames()).not.toContain("pe_render_ui");
	});

	it("does not inject workflows or restore UI when the host disables every tool", async () => {
		const h = await setup();
		h.setResponses([load(["pe-generative-ui"]), fauxAssistantMessage("done")]);
		await h.session.prompt("Load then disable");
		h.session.setActiveToolsByName([]);
		await h.session.reload({ beforeSessionStart: () => h.session.setActiveToolsByName([]) });
		expect(h.session.getActiveToolNames()).toEqual([]);
		expect(pinned(await h.session.extensionRunner.emitContext(h.session.messages))).toHaveLength(0);
	});

	it("supports rollback and measures the schema payload without claiming model quality", async () => {
		const eager = await setup({ lazyUi: false });
		const lazy = await setup();
		const chars = (h: Harness) =>
			JSON.stringify(
				h.session.agent.state.tools
					.filter((tool) => tool.name.startsWith("pe_"))
					.map(({ name, description, parameters }) => ({ name, description, parameters })),
			).length;
		expect(eager.session.getActiveToolNames()).toContain("pe_render_ui");
		const eagerChars = chars(eager),
			lazyChars = chars(lazy);
		expect(lazyChars).toBeLessThan(eagerChars * 0.6);
		console.info("PE native schema characters (same loader, no model quality claim):", { eagerChars, lazyChars });
	});

	it("preloads explicitly activated UI while retaining native validation", async () => {
		const h = await setup();
		h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "pe_render_ui"]);
		const invalid = fauxAssistantMessage(
			fauxToolCall("pe_render_ui", {
				version: 1,
				component: {
					kind: "financial_trend",
					title: "Bad alignment",
					chart: "line",
					categories: ["2024", "2025"],
					series: [{ name: "Revenue", values: [1] }],
				},
			}),
			{ stopReason: "toolUse" },
		);
		h.setResponses([
			(context) => {
				expect(context.messages.map(getMessageText).join("\n")).toContain("# Component Selection");
				return invalid;
			},
			load(["pe-generative-ui"]),
			invalid,
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("Check instructions and argument validation");
		const results = h.eventsOfType("tool_execution_end");
		expect(results.map((result) => result.isError)).toEqual([true, false, true]);
	});
});
