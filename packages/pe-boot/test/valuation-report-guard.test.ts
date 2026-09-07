import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageEndEventResult } from "../../coding-agent/src/core/extensions/types.ts";
import { registerValuationReportGuard } from "../src/valuation-report-guard.ts";

const PROJECTS: string[] = [];
const PROMPT = "请全面分析这个 Excel 估值模型，生成完整估值报告。";
const REPORT = "## 模型估值结果\n\n- 目标价：2,338.00 欧元。";

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
	registerValuationReportGuard({
		on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(name, handler);
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
		await emit("before_agent_start", { prompt, images });
		await emit("message_start", { message: { role: "user", content: prompt } });
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
	return { cwd, ctx, session, emit, begin, call, result, finish, message };
}

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
