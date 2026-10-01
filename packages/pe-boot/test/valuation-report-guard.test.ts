import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type {
	BeforeAgentStartEventResult,
	MessageEndEventResult,
} from "../../coding-agent/src/core/extensions/types.ts";
import { registerValuationReportGuard } from "../src/valuation-report-guard.ts";

const PROJECTS: string[] = [];
const PROMPT = "请全面分析这个 Excel 估值模型，生成完整估值报告。";
const REPORT = "## 模型估值结果\n\n- 目标价：2,338.00 欧元。";
const FOCUSED_PROMPT = `请读取当前项目中的 model.xlsx，只做以下局部分析，不修改原工作簿：
1. 用模型中2026年的EPS上下浮动10%，配合18、20、22倍P/E，给出价格表，区分原模型基准和补充设定。
2. 找到原模型中增长率的真正独立输入，将它提高1个百分点，其余原始假设固定。按原模型的实际引用关系，复算2026和2027年的收入、EPS及目标价，列出原基准与变动后的结果，并说明跨期传播、固定条件和复算范围。
最后说明这两项分析分别回答什么问题，第一项能否证明经营驱动敏感性。请给出可核验的工作表、输入角色和公式证据。只回答这些问题，不生成完整投资报告、不查市场数据、不创建框架状态或图表。`;
const LIVE_FOCUSED_PROMPT =
	"请读取当前项目的 model.xlsx，只做局部数值对照表：列出2026和2027年的收入、EPS、目标价原模型基准，保留原单位；收入再给出按元换算的对照。另以2027年目标价为输出，找到增长率的真正独立输入并将它相对上调10%，其余原始假设固定，用可用重算引擎在隔离副本验证，列出2027年收入、EPS、目标价的基准与情景对照，并简述传播机制与固定条件。每项保留可核验来源和单位，说明原值与重算值。不要生成完整投资报告，不查市场数据，不改原工作簿，不创建框架或图表；允许保存重算工具自动产生的审计附件。";

function project(legacy = false): string {
	const cwd = mkdtempSync(join(tmpdir(), "pe-valuation-guard-"));
	PROJECTS.push(cwd);
	mkdirSync(join(cwd, "meta"));
	const database = new DatabaseSync(join(cwd, "meta/collection.sqlite3"));
	try {
		database.exec(`CREATE TABLE documents (
			doc_id TEXT PRIMARY KEY, dataset_id TEXT, original_filename TEXT, file_type TEXT, checksum TEXT
			${legacy ? "" : ", version_no INTEGER DEFAULT 1, is_current INTEGER DEFAULT 1, lifecycle_state TEXT DEFAULT 'active', deleted_at TEXT"}
		); INSERT INTO documents(doc_id,dataset_id,original_filename,file_type,checksum)
		VALUES ('doc-a','dataset-1','Hermes.xlsm','xlsm','hash-a');`);
	} finally {
		database.close();
	}
	return cwd;
}

function update(cwd: string, sql: string): void {
	const database = new DatabaseSync(join(cwd, "meta/collection.sqlite3"));
	try {
		database.exec(sql);
	} finally {
		database.close();
	}
}

function harness(cwd = project()) {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const repairs: Array<{
		message: Parameters<ExtensionAPI["sendMessage"]>[0];
		options: Parameters<ExtensionAPI["sendMessage"]>[1];
	}> = [];
	registerValuationReportGuard({
		on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(name, handler);
		},
		sendMessage(
			message: Parameters<ExtensionAPI["sendMessage"]>[0],
			options: Parameters<ExtensionAPI["sendMessage"]>[1],
		) {
			repairs.push({ message, options });
		},
	} as unknown as ExtensionAPI);
	const session = { id: "session-a" };
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => session.id },
		signal: undefined,
	} as unknown as ExtensionContext;
	async function emit(name: string, event: Record<string, unknown> = {}) {
		return handlers.get(name)?.({ type: name, ...event } as never, ctx);
	}
	async function begin(prompt = PROMPT, images: unknown[] = []) {
		const result = await emit("before_agent_start", { prompt, images });
		await emit("message_start", { message: { role: "user", content: prompt } });
		return result as BeforeAgentStartEventResult | undefined;
	}
	async function call(id = "report-1", docId = "doc-a", toolName = "pe_valuation_report", scope = "overview") {
		await emit("tool_call", { toolCallId: id, toolName, input: { doc_id: docId, scope } });
	}
	async function result(
		id = "report-1",
		details: Record<string, unknown> = {},
		isError = false,
		toolName = "pe_valuation_report",
	) {
		await emit("tool_result", {
			toolCallId: id,
			toolName,
			input: {},
			isError,
			content: [],
			details: {
				doc_id: "doc-a",
				status: "ready",
				rendered_report: REPORT,
				issues: [],
				validation_scope: "Source values only",
				...details,
			},
		});
	}
	const message = {
		role: "assistant" as const,
		content: [
			{ type: "thinking" as const, thinking: "Retained reasoning", thinkingSignature: "reasoning_content" },
			{ type: "text" as const, text: "Incorrect rewritten price: 9,999 EUR." },
		],
		api: "openai-completions" as const,
		provider: "qwen-token-plan-cn",
		model: "qwen3.8-max",
		timestamp: 42,
		responseId: "response-1",
		usage: {
			input: 3,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 7,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
	};
	async function finish(overrides: Record<string, unknown> = {}) {
		return (await emit("message_end", { message: { ...message, ...overrides } })) as
			| MessageEndEventResult
			| undefined;
	}
	return { cwd, ctx, session, emit, begin, call, result, finish, message, repairs };
}

const SECTION_FAILURE = {
	status: "blocked",
	rendered_report: undefined,
	repair_scope: "sections",
	issues: ["章节「估值方法框架」的 analysis 包含数值，请通过 facts/calculations 表达。"],
	section_issues: [{ section_index: 0, field: "analysis", code: "numeric_claim", excerpt: "目标倍数为 18 倍。" }],
};

function text(result: MessageEndEventResult | undefined): string | undefined {
	return result?.message?.role === "assistant"
		? result.message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("")
		: undefined;
}

afterEach(() => {
	for (const cwd of PROJECTS.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("valuation report final-message guard", () => {
	it.each([
		"请读取当前地平线项目中已上传的估值模型，只做局部模型分析，不修改原工作簿、不查市场数据、不创建框架状态或图表：\n1. 找出2026和2027年的收入、净利润/EPS、目标价或估值，列出原模型基准及其单元格和公式证据。\n2. 找到驱动收入的一个真正独立增长率输入，提高1个百分点。\n3. 给出价格条件表，只回答上述问题。",
		"请读取估值模型，仅进行局部分析：\n核对增长输入和EPS公式。",
		"Read the valuation model. Only focused model analysis: explain the growth input and EPS formula.",
	])("does not mistake explicit local analysis for a whole report: %s", async (prompt) => {
		const run = harness();
		expect(await run.begin(prompt)).toBeUndefined();
		expect(await run.finish()).toBeUndefined();
	});

	it.each([
		FOCUSED_PROMPT,
		LIVE_FOCUSED_PROMPT,
		"不要完整估值报告，只列收入表。",
		"做收入表，保留原始单位。",
		"请给我收入和EPS的数值对照表。",
		"请用表格给出这个工作簿的收入和EPS。",
		"Do not generate a full valuation report; show a revenue table from this workbook.",
	])("protects explicit local numeric tables and supplies a usable focused route: %s", async (prompt) => {
		const run = harness();
		const start = await run.begin(prompt);
		expect(start?.message?.customType).toBe("pe-focused-numeric-delivery");
		expect(start?.message?.display).toBe(false);
		expect(start?.message?.content).toContain("Load pe-valuation-report");
		expect(start?.message?.content).toContain("scope=focused");
		expect(start?.message?.content).toContain("all requested numeric comparisons and their explanations");
		expect(text(await run.finish())).toContain("本次数值表尚未通过校验");
		const focused = "## 局部结果\n\n| 收入 | 110.00 百万CNY |\n\n保留价格条件对照与跨期传播说明。";
		await run.call("focused", "doc-a", "pe_valuation_report", "focused");
		await run.result("focused", { rendered_report: focused });
		expect(text(await run.finish())).toBe(focused);
		expect(text(await run.finish())).not.toContain("9,999");
	});

	it("removes free numeric prefaces and explanations from the live focused-table response", async () => {
		const run = harness();
		await run.begin(LIVE_FOCUSED_PROMPT);
		const focused = "## 局部数值对照\n\n| 收入 | 110.00 百万CNY |\n\n条件和传播说明由报告工具保留。";
		await run.call("focused", "doc-a", "pe_valuation_report", "focused");
		await run.result("focused", { rendered_report: focused });
		const final = await run.finish({
			content: [
				{ type: "text", text: `原模型收入为110元，情景收入为111元。\n\n${focused}\n\n补充说明：EPS增长10%。` },
			],
		});
		expect(text(final)).toBe(focused);
	});

	it("does not widen a local table request into an overview", async () => {
		const run = harness();
		await run.begin(FOCUSED_PROMPT);
		await run.call();
		await run.result();
		expect(text(await run.finish())).toContain("请使用 scope=focused");
	});

	it("blocks unresolved source units in a focused result without retrying it as prose", async () => {
		const run = harness();
		await run.begin(FOCUSED_PROMPT);
		await run.call("focused", "doc-a", "pe_valuation_report", "focused");
		await run.result("focused", { status: "blocked", issues: ["Source says CNY million, expected CNY"] }, true);
		expect(text(await run.finish())).toContain("Source says CNY million, expected CNY");
		expect(text(await run.finish())).not.toContain("9,999");
		expect(run.repairs).toEqual([]);
	});

	it("preserves focused scope and scenario coverage in its bounded prose repair", async () => {
		const run = harness();
		await run.begin(FOCUSED_PROMPT);
		await run.call("focused", "doc-a", "pe_valuation_report", "focused");
		await run.result("focused", SECTION_FAILURE, true);
		await run.finish();
		expect(run.repairs).toHaveLength(1);
		expect(run.repairs[0].message.content).toContain("scope=focused");
		expect(run.repairs[0].message.content).toContain("scenario conditions and explanations");
		await run.call("repaired", "doc-a", "pe_valuation_report", "focused");
		await run.result("repaired");
		expect(text(await run.finish())).toBe(REPORT);
	});

	it("retains focused mode on continue but clears it for a plain explanation", async () => {
		const run = harness();
		await run.begin(FOCUSED_PROMPT);
		await run.call("focused", "doc-a", "pe_valuation_report", "focused");
		await run.result("focused");
		await run.emit("agent_settled");
		const start = await run.begin("继续");
		expect(start?.message?.content).toContain("scope=focused");
		expect(text(await run.finish())).toContain("数值表尚未通过校验");
		await run.begin("只解释EPS公式是什么意思，不生成完整报告");
		expect(await run.finish()).toBeUndefined();
	});

	it("does not require numeric-table delivery without an active workbook", async () => {
		const run = harness();
		update(run.cwd, "UPDATE documents SET is_current=0");
		expect(await run.begin(FOCUSED_PROMPT)).toBeUndefined();
		expect(await run.finish()).toBeUndefined();
	});

	it.each([
		"只回答收入是多少，不要完整报告",
		"请解释这个收入表是怎么计算的",
		"请解释怎么做收入表",
		"请说明给我收入表的步骤",
		"不要给出收入表，只解释EPS公式",
		"请只解释EPS公式和增长率的跨期传播",
		"请修复收入表的代码",
		"请按这张截图给出收入表",
	])("leaves simple questions, explanations and excluded surfaces free: %s", async (prompt) => {
		const run = harness();
		expect(await run.begin(prompt)).toBeUndefined();
		expect(await run.finish()).toBeUndefined();
	});

	it("queues one prose repair when the model stops on a repairable error, then delivers the ready report", async () => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result("report-1", SECTION_FAILURE, true);
		expect(text(await run.finish())).toBe("正在修正报告文字并重新校验。");
		expect(run.repairs).toHaveLength(1);
		expect(run.repairs[0].options).toEqual({ deliverAs: "followUp" });
		expect(run.repairs[0].message.display).toBe(false);
		await run.emit("message_start", { message: { role: "custom", ...run.repairs[0].message } });
		await run.call("repair");
		await run.result("repair");
		expect(text(await run.finish())).toBe(REPORT);
		expect(run.repairs).toHaveLength(1);
	});

	it("does not loop if the automatic prose repair fails", async () => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result("report-1", SECTION_FAILURE, true);
		await run.finish();
		await run.call("repair");
		await run.result("repair", SECTION_FAILURE, true);
		expect(text(await run.finish())).toContain("尚未通过校验");
		expect(run.repairs).toHaveLength(1);
	});

	it("does not interrupt a model that has already corrected a prose error", async () => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result("report-1", SECTION_FAILURE, true);
		await run.call("corrected");
		await run.result("corrected");
		expect(text(await run.finish())).toBe(REPORT);
		expect(run.repairs).toEqual([]);
	});

	it("does not automatically repair source failures or malformed repair requests", async () => {
		for (const details of [
			{ status: "blocked", issues: ["unit mismatch"] },
			{ ...SECTION_FAILURE, section_issues: [] },
			{ ...SECTION_FAILURE, doc_id: "other-book" },
		]) {
			const run = harness();
			await run.begin();
			await run.call();
			await run.result("report-1", details, true);
			expect(text(await run.finish())).toContain("尚未通过校验");
			expect(run.repairs).toEqual([]);
		}
	});

	it.each(["version", "cancel", "source_read", "focused"])("does not retry prose after %s changes", async (change) => {
		const run = harness();
		await run.begin();
		await run.call("report-1", "doc-a", "pe_valuation_report", change === "focused" ? "focused" : "overview");
		await run.result("report-1", SECTION_FAILURE, true);
		if (change === "version") update(run.cwd, "UPDATE documents SET version_no=2");
		if (change === "cancel") await run.emit("message_start", { message: { role: "user", content: "停止" } });
		if (change === "source_read") {
			await run.call("read", "doc-a", "pe_excel_range");
			await run.result("read", {}, true, "pe_excel_range");
		}
		await run.finish();
		expect(run.repairs).toEqual([]);
	});

	it("uses the ready report verbatim while preserving reasoning and response metadata", async () => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result();
		const replacement = await run.finish();
		expect(text(replacement)).toBe(REPORT);
		expect(replacement?.message).toEqual({
			...run.message,
			content: [run.message.content[0], { type: "text", text: REPORT }],
		});
		if (replacement?.message?.role !== "assistant") throw new Error("Expected an assistant replacement");
		expect(replacement.message.content[0]).toBe(run.message.content[0]);
	});

	it("blocks a broad report request even if the model never calls a workbook tool", async () => {
		const run = harness();
		await run.begin();
		expect(text(await run.finish())).toContain("尚未通过校验");
		expect(text(await run.finish())).not.toContain("9,999");
	});

	it.each(["请分析这个模型", "对这个估值模型做全面分析", "analyze this model"])(
		"recognizes an overall model request when an active workbook exists: %s",
		async (prompt) => {
			const run = harness();
			await run.begin(prompt);
			expect(text(await run.finish())).toContain("尚未通过校验");
			await run.call();
			await run.result();
			expect(text(await run.finish())).toBe(REPORT);
		},
	);

	it.each([
		"如何优化估值模型分析报告的准确率？",
		"请修复估值模型分析报告的代码",
		"改进 valuation model analysis prompt",
		"估值模型中的 EPS 怎么算？",
		"请只分析这个估值模型的每股收益",
		"请比较两个估值模型并出报告",
		"只根据这张截图分析估值模型",
		"取消估值模型分析",
		"停止，先别生成估值报告",
		"What is the EPS in this valuation model?",
		"请分析这个模型中的 EPS",
		"analyze this model's EPS",
		"请概括这个 Excel 文件",
		"分析估值模型的预测逻辑，追到独立假设",
		"请分析估值模型，告诉我收入怎么预测的",
		"分析估值模型后生成投资框架",
		"Explain this valuation model's model mechanics",
	])("does not intercept excluded user intent: %s", async (prompt) => {
		const run = harness();
		await run.begin(prompt);
		await run.call();
		await run.result();
		expect(await run.finish()).toBeUndefined();
	});

	it("does not infer workbook scope from an image-only model question", async () => {
		const run = harness();
		await run.begin("请分析这个估值模型", [{ type: "image" }]);
		expect(await run.finish()).toBeUndefined();
	});

	it.each([
		"分析当前估值模型并建立股票追踪表，自动识别股票和模型。",
		"根据估值模型分析结果配置股票跟踪流程。",
		"分析估值模型后记录一笔模拟买入。",
		"分析估值模型并刷新股票追踪，用交互表格展示。",
		"Analyze the valuation model and create a stock tracker with an interactive tracking table.",
		"Review the valuation model and configure stock tracking.",
		"Analyze the valuation model and record a simulated buy.",
		"Explain the valuation model and refresh stock tracking.",
	])("preserves stock-tracking operational output: %s", async (prompt) => {
		const run = harness();
		await run.begin(prompt);
		await run.call("model", "doc-a", "pe_excel_range");
		await run.result("model", {}, false, "pe_excel_range");
		await run.call("tracking", "doc-a", "pe_stock_tracking");
		await run.result("tracking", { kind: "pe_stock_tracking", operation: "configure" }, false, "pe_stock_tracking");
		expect(await run.finish()).toBeUndefined();
		expect(run.repairs).toEqual([]);
	});

	it.each([
		"请分析估值模型，重点解释后续跟踪指标和风险。",
		"请生成完整估值报告，同时建立股票追踪表。",
		"Write a complete valuation report and configure stock tracking.",
		"请解释预测逻辑并生成完整估值报告",
	])("still requires report validation for report intent: %s", async (prompt) => {
		const run = harness();
		await run.begin(prompt);
		expect(text(await run.finish())).toContain("尚未通过校验");
		await run.call();
		await run.result();
		expect(text(await run.finish())).toBe(REPORT);
	});

	it("does not guard projects with no active workbook", async () => {
		const run = harness();
		update(run.cwd, "UPDATE documents SET is_current=0");
		await run.begin();
		expect(await run.finish()).toBeUndefined();
	});

	it("supports legacy document tables without version/lifecycle columns", async () => {
		const run = harness(project(true));
		await run.begin();
		await run.call();
		await run.result();
		expect(text(await run.finish())).toBe(REPORT);
	});

	it.each(["before_agent_start", "message_start"])(
		"clears previous ready results on a new user request via %s",
		async (kind) => {
			const run = harness();
			await run.begin();
			await run.call();
			await run.result();
			if (kind === "before_agent_start") await run.begin();
			else await run.emit("message_start", { message: { role: "user", content: PROMPT } });
			expect(text(await run.finish())).toContain("尚未通过校验");
			await run.result();
			expect(text(await run.finish())).toContain("尚未通过校验");
		},
	);

	it.each(["停止", "只回答 EPS 是多少", "请修改相关代码"])("respects a steering scope change: %s", async (content) => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result();
		await run.emit("message_start", { message: { role: "user", content } });
		expect(await run.finish()).toBeUndefined();
	});

	it("requires fresh validation when continuing a settled report run", async () => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result();
		await run.emit("agent_settled");
		await run.begin("继续");
		expect(text(await run.finish())).toContain("尚未通过校验");
	});

	it.each(["session_start", "session_tree"])("clears scope when receiving %s", async (event) => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result();
		await run.emit(event);
		expect(await run.finish()).toBeUndefined();
	});

	it("does not share state across extension instances or switched sessions", async () => {
		const first = harness();
		const second = harness(first.cwd);
		await first.begin();
		await first.call();
		await first.result();
		await second.begin();
		expect(text(await second.finish())).toContain("尚未通过校验");
		first.session.id = "other-session";
		expect(await first.finish()).toBeUndefined();
	});

	it.each(["error", "aborted", "length", "toolUse"])("preserves assistant terminal state %s", async (stopReason) => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result();
		expect(await run.finish({ stopReason })).toBeUndefined();
	});

	it("preserves tool calls and canceled assistant messages", async () => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result();
		expect(
			await run.finish({ content: [{ type: "toolCall", id: "next", name: "pe_excel_range", arguments: {} }] }),
		).toBeUndefined();
		const abort = new AbortController();
		abort.abort();
		run.ctx.signal = abort.signal;
		expect(await run.finish()).toBeUndefined();
	});

	it("clears ready when the latest report is blocked, and ignores an older late success", async () => {
		const run = harness();
		await run.begin();
		await run.call("old");
		await run.call("new");
		await run.result("new", { status: "blocked", issues: ["Missing DCF output"] });
		await run.result("old");
		expect(text(await run.finish())).toContain("Missing DCF output");
	});

	it("does not allow an older failed report to erase a newer ready report", async () => {
		const run = harness();
		await run.begin();
		await run.call("old");
		await run.call("new");
		await run.result("new");
		await run.result("old", {}, true);
		expect(text(await run.finish())).toBe(REPORT);
	});

	it("invalidates ready on a failed workbook read", async () => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result();
		await run.call("read", "doc-a", "pe_excel_range");
		await run.result("read", {}, true, "pe_excel_range");
		expect(text(await run.finish())).toContain("读取或报告校验失败");
	});

	it("cannot use a focused report in place of the requested whole-model overview", async () => {
		const run = harness();
		await run.begin();
		await run.call("focused", "doc-a", "pe_valuation_report", "focused");
		await run.result("focused");
		expect(text(await run.finish())).toContain("局部指标报告不能替代");
	});

	it.each([
		{ doc_id: "doc-other" },
		{ rendered_report: " " },
		{ status: "ready", issues: ["Unresolved unit"] },
		{ validation_scope: undefined },
		{ status: "blocked", issues: [] },
	])("rejects a malformed or mismatched report result: %j", async (details) => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result("report-1", details);
		expect(text(await run.finish())).toContain("尚未通过校验");
	});

	it("does not accept ready text from untracked tool results", async () => {
		const run = harness();
		await run.begin();
		await run.result();
		expect(text(await run.finish())).toContain("尚未通过校验");
	});

	it("invalidates ready when another workbook is selected and ignores the old result", async () => {
		const run = harness();
		update(
			run.cwd,
			"INSERT INTO documents(doc_id,dataset_id,original_filename,file_type,checksum) VALUES ('doc-b','dataset-1','Other.xlsm','xlsm','hash-b')",
		);
		await run.begin();
		await run.call("old");
		await run.call("new-read", "doc-b", "pe_excel_range");
		await run.result("old");
		expect(text(await run.finish())).toContain("文档发生变化");
		await run.call("new-report", "doc-b");
		await run.result("new-report", { doc_id: "doc-b" });
		expect(text(await run.finish())).toBe(REPORT);
	});

	it("keeps a filename explicitly selected by the user pinned", async () => {
		const run = harness();
		update(
			run.cwd,
			"INSERT INTO documents(doc_id,dataset_id,original_filename,file_type,checksum) VALUES ('doc-b','dataset-1','Other.xlsm','xlsm','hash-b')",
		);
		await run.begin("请分析 Hermes.xlsm 中的整个估值模型");
		await run.call("wrong-book", "doc-b");
		await run.result("wrong-book", { doc_id: "doc-b" });
		expect(text(await run.finish())).toContain("本轮选定");
	});

	it.each([
		"is_current=0",
		"checksum='new-hash'",
		"version_no=2",
		"deleted_at='deleted'",
		"lifecycle_state='archived'",
	])("rechecks current source identity before finalizing: %s", async (change) => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result();
		update(run.cwd, `UPDATE documents SET ${change}`);
		expect(text(await run.finish())).toContain("版本发生变化");
	});

	it("fails closed if source verification throws after a ready result", async () => {
		const run = harness();
		await run.begin();
		await run.call();
		await run.result();
		rmSync(join(run.cwd, "meta/collection.sqlite3"));
		expect(text(await run.finish())).toContain("无法重新核验");
	});
});
