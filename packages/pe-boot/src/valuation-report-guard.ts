import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openPeDataset, type SqlRow } from "./tools/database.ts";

const WORKBOOK_TOOLS = new Set([
	"pe_document_open",
	"pe_workbook_inspect",
	"pe_excel_range",
	"pe_formula_trace",
	"pe_valuation_output_locate",
	"pe_valuation_date_resolve",
	"pe_model_validate",
	"pe_valuation_report",
]);

interface WorkbookVersion {
	docId: string;
	identity: string;
	names: string[];
}

interface PendingCall {
	generation: number;
	revision: number;
	docId?: string;
	isReport: boolean;
	scope?: unknown;
}

interface ReadyReport {
	docId: string;
	identity: string;
	text: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function activeWorkbooks(cwd: string): Map<string, WorkbookVersion> {
	const { database, datasetId } = openPeDataset(cwd);
	try {
		const columns = new Set(
			database
				.prepare("PRAGMA table_info(documents)")
				.all()
				.map((row) => row.name),
		);
		const filename = ["original_filename", "source_relpath", "filename_key"].find((column) => columns.has(column));
		const excelPredicate = columns.has("file_type")
			? "lower(d.file_type) IN ('xlsx','xlsm')"
			: filename
				? `(lower(d.${filename}) LIKE '%.xlsx' OR lower(d.${filename}) LIKE '%.xlsm')`
				: "0=1";
		const predicates = ["d.dataset_id=?", excelPredicate];
		if (columns.has("deleted_at")) predicates.push("d.deleted_at IS NULL");
		if (columns.has("is_current")) predicates.push("COALESCE(d.is_current,1)=1");
		if (columns.has("lifecycle_state")) predicates.push("COALESCE(d.lifecycle_state,'active')='active'");
		const fields = [
			"doc_id",
			"dataset_id",
			"version_no",
			"checksum",
			"sha256",
			"stored_path",
			"raw_path",
			"original_filename",
			"source_relpath",
			"filename_key",
		].filter((column) => columns.has(column));
		const rows = database
			.prepare(
				`SELECT ${fields.map((column) => `d.${column}`).join(",")} FROM documents d WHERE ${predicates.join(" AND ")}`,
			)
			.all(datasetId) as SqlRow[];
		return new Map(
			rows.flatMap((row) => {
				if (typeof row.doc_id !== "string") return [];
				return [
					[
						row.doc_id,
						{
							docId: row.doc_id,
							identity: JSON.stringify(row),
							names: [row.original_filename, row.source_relpath, row.filename_key].filter(
								(name): name is string => typeof name === "string" && name.length > 0,
							),
						},
					],
				];
			}),
		);
	} finally {
		database.close();
	}
}

function isOverviewRequest(text: string, imageCount: number): boolean {
	if (
		/(?:代码|源码|编程|程序|部署|提示词|准确率|准确性|如何优化|怎么优化|优化流程|优化报告|修复|\b(?:code|coding|prompt|accuracy|debug|deployment|implementation)\b)/iu.test(
			text,
		)
	)
		return false;
	if (
		/(?:取消|停止|算了|先别|不要继续|不用分析|别分析|截图|截屏|图片|\b(?:cancel|stop|screenshot|image.only)\b|never mind)/iu.test(
			text,
		)
	)
		return false;
	const trackingOperation =
		/(?:创建|新建|建立|构建|生成|配置|设置|启用|开启|暂停|关闭|更新|刷新|记录|录入|添加|加入|加到|保存).{0,30}(?:股票[追跟]踪|股价[追跟]踪|[追跟]踪(?:表|流程)|模拟(?:交易|买入|卖出|持仓))|\b(?:create|configure|set\s+up|refresh|update|record|add|enable|disable|pause|start|save)\b[^.!?\n]{0,50}\b(?:stock\s+track(?:ing|ers?)|price\s+tracking|tracking\s+(?:table|workflow)|(?:simulated|paper)\s+(?:trade|buy|sell|position)s?)\b/iu.test(
			text,
		);
	const explicitReport =
		/(?:生成|撰写|出具|提供|输出|交付|整理|完成).{0,20}(?:(?:完整|整体|全面)(?:的)?(?:估值模型|估值|模型)?报告|估值报告)|\b(?:write|generate|produce|prepare|provide|deliver)\b[^.!?\n]{0,40}\b(?:(?:full|complete|overall)\s+(?:valuation\s+(?:model\s+)?)?report|valuation\s+report)\b/iu.test(
			text,
		);
	// Creating/refreshing a tracker may require model analysis, but is not itself an overall valuation report.
	if (trackingOperation && !explicitReport) return false;
	if (imageCount > 0 && !/(?:excel|工作簿|\.xlsx\b|\.xlsm\b)/iu.test(text)) return false;
	if (
		/(?:比较|对比|compare|comparison).{0,40}(?:模型|工作簿|workbooks?|models?)|(?:多个|两个|两份|多份|multiple|two|both).{0,20}(?:模型|工作簿|models?|workbooks?)/iu.test(
			text,
		)
	)
		return false;
	if (
		/(?:只|仅|单独|only|just).{0,35}(?:EPS|每股收益|股数|税率|市盈率|毛利率|收入|目标价|敏感性|公式)|(?:估值模型|valuation model)(?:中|里|的).{0,35}(?:EPS|每股收益|股数|税率|市盈率|公式)|(?:EPS|每股收益|市盈率|税率).{0,12}(?:怎么|如何|为何|为什么|是多少)/iu.test(
			text,
		)
	)
		return false;
	if (
		/(?:分析|解读|评估)\s*(?:这个|该|这份|本)\s*模型(?=[，。！？,.!?\s]|$)|\b(?:analy[sz]e|review|explain)\s+this model\s*(?:[.!?]|$)/iu.test(
			text,
		)
	)
		return true;
	return /(?:分析|解读|评估|审阅|审查|生成|撰写|提供|出具|整理).{0,45}(?:估值模型|估值报告)|(?:估值模型|估值报告).{0,25}(?:分析|解读|报告|评估)|(?:analy[sz]e|review|explain|prepare|write|generate|produce|provide).{0,60}(?:valuation model|valuation report)|valuation model analysis|(?:生成|出具|运行|调用|generate|produce|run).{0,20}pe_valuation_report/iu.test(
		text,
	);
}

function blockedReport(issues: string[]): string {
	const missing = issues.length ? issues : ["尚未取得当前工作簿整体报告的校验结果。"];
	return [
		"本次估值报告尚未通过校验，暂时无法交付完整报告。",
		"",
		...missing.slice(0, 6).map(
			(issue) =>
				`- ${issue
					.slice(0, 400)
					.replace(/[\\`*_[\]<>|#]/gu, "\\$&")
					.replace(/\s+/gu, " ")}`,
		),
		"",
		"需补齐上述证据或修正冲突，再重新生成经过校验的报告。",
	].join("\n");
}

/** Protect the finalized report. Streaming drafts and analyst judgments are not independently verified. */
export function registerValuationReportGuard(pi: ExtensionAPI): void {
	let sessionId: string | undefined;
	let workspace: string | undefined;
	let generation = 0;
	let revision = 0;
	let eligible = false;
	let previousOverview = false;
	let initialPrompt: string | undefined;
	let versions = new Map<string, WorkbookVersion>();
	let lockedDocId: string | undefined;
	let selectedDocId: string | undefined;
	let latestReportCallId: string | undefined;
	let ready: ReadyReport | undefined;
	let sectionRepair: { docId: string; identity: string } | undefined;
	let repairAttempts = 0;
	let issues: string[] = [];
	const calls = new Map<string, PendingCall>();

	function clearRun(): void {
		generation++;
		revision = 0;
		eligible = false;
		ready = undefined;
		sectionRepair = undefined;
		repairAttempts = 0;
		issues = [];
		versions = new Map();
		lockedDocId = undefined;
		selectedDocId = undefined;
		latestReportCallId = undefined;
		calls.clear();
	}

	function sameSession(ctx: ExtensionContext): boolean {
		return sessionId === ctx.sessionManager.getSessionId() && workspace === ctx.cwd;
	}

	function beginRequest(text: string, imageCount: number, ctx: ExtensionContext): void {
		const continuation =
			sameSession(ctx) &&
			previousOverview &&
			/^(?:请)?(?:继续|继续分析|继续生成|continue|resume)[。.!！\s]*$/iu.test(text.trim());
		clearRun();
		sessionId = ctx.sessionManager.getSessionId();
		workspace = ctx.cwd;
		previousOverview = continuation || isOverviewRequest(text, imageCount);
		if (!previousOverview || !existsSync(join(ctx.cwd, "meta", "collection.sqlite3"))) return;
		try {
			versions = activeWorkbooks(ctx.cwd);
			eligible = versions.size > 0;
			const named = [...versions.values()].filter((version) => version.names.some((name) => text.includes(name)));
			lockedDocId = named.length === 1 ? named[0].docId : versions.size === 1 ? [...versions.keys()][0] : undefined;
			selectedDocId = lockedDocId;
		} catch {
			eligible = true;
			issues = ["无法读取项目中的工作簿及版本信息。"];
		}
	}

	function invalidate(reason: string): void {
		ready = undefined;
		sectionRepair = undefined;
		revision++;
		issues = [reason];
	}

	function selectDocument(docId: string): void {
		if (docId !== selectedDocId) {
			invalidate("分析所用文档发生变化，需要重新生成当前版本的整体报告。");
			selectedDocId = docId;
		}
	}

	pi.on("before_agent_start", (event, ctx) => {
		beginRequest(event.prompt, event.images?.length ?? 0, ctx);
		initialPrompt = event.prompt;
	});
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "user") return;
		const content = event.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
		const imageCount = typeof content === "string" ? 0 : content.filter((block) => block.type === "image").length;
		if (sameSession(ctx) && initialPrompt === text) {
			initialPrompt = undefined;
			return;
		}
		initialPrompt = undefined;
		beginRequest(text, imageCount, ctx);
	});
	pi.on("session_start", () => {
		clearRun();
		previousOverview = false;
		initialPrompt = undefined;
	});
	pi.on("session_tree", () => {
		clearRun();
		previousOverview = false;
		initialPrompt = undefined;
	});
	pi.on("agent_settled", () => {
		clearRun();
		initialPrompt = undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		if (!eligible || !sameSession(ctx) || !WORKBOOK_TOOLS.has(event.toolName)) return;
		const input = object(event.input);
		const docId = typeof input?.doc_id === "string" ? input.doc_id : undefined;
		if (docId) selectDocument(docId);
		const isReport = event.toolName === "pe_valuation_report";
		if (isReport) {
			latestReportCallId = event.toolCallId;
			ready = undefined;
			sectionRepair = undefined;
			issues = ["整体报告的校验尚未完成。"];
		}
		calls.set(event.toolCallId, { generation, revision, docId, isReport, scope: input?.scope });
	});
	pi.on("tool_result", (event, ctx) => {
		if (!eligible || !sameSession(ctx)) return;
		const call = calls.get(event.toolCallId);
		if (!call || call.generation !== generation) return;
		calls.delete(event.toolCallId);
		if (call.isReport && event.toolCallId !== latestReportCallId) return;
		if (call.revision !== revision) return;
		try {
			const details = object(event.details);
			const docId =
				typeof details?.doc_id === "string"
					? details.doc_id
					: typeof details?.selected_doc_id === "string"
						? details.selected_doc_id
						: call.docId;
			if (event.isError || (call.isReport && details?.status === "blocked")) {
				invalidate("工作簿读取或报告校验失败，需要补齐证据后重新生成。");
				if (
					call.isReport &&
					Array.isArray(details?.issues) &&
					details.issues.every((issue) => typeof issue === "string") &&
					details.issues.length
				)
					issues = details.issues;
				if (
					call.isReport &&
					call.scope === "overview" &&
					details?.status === "blocked" &&
					details.repair_scope === "sections" &&
					Array.isArray(details.issues) &&
					details.issues.length > 0 &&
					Array.isArray(details.section_issues) &&
					details.section_issues.length === details.issues.length &&
					docId &&
					docId === call.docId &&
					docId === selectedDocId &&
					(!lockedDocId || docId === lockedDocId)
				) {
					const version = versions.get(docId);
					if (version) sectionRepair = { docId, identity: version.identity };
				}
				return;
			}
			if (!call.isReport) {
				if (docId && versions.has(docId)) selectDocument(docId);
				return;
			}
			ready = undefined;
			if (
				call.revision !== revision ||
				!docId ||
				docId !== call.docId ||
				docId !== selectedDocId ||
				(lockedDocId && docId !== lockedDocId)
			) {
				issues = ["报告与本轮选定的工作簿或工具调用不一致。"];
				return;
			}
			if (call.scope !== "overview") {
				issues = ["当前请求需要整体估值报告，局部指标报告不能替代完整校验。"];
				return;
			}
			if (
				details?.status !== "ready" ||
				!Array.isArray(details.issues) ||
				details.issues.length !== 0 ||
				typeof details.rendered_report !== "string" ||
				!details.rendered_report.trim() ||
				typeof details.validation_scope !== "string"
			) {
				issues =
					Array.isArray(details?.issues) &&
					details.issues.every((issue) => typeof issue === "string") &&
					details.issues.length
						? details.issues
						: ["报告工具未返回完整、有效且通过校验的报告。"];
				return;
			}
			const version = versions.get(docId);
			if (!version || activeWorkbooks(ctx.cwd).get(docId)?.identity !== version.identity) {
				issues = ["工作簿版本已变化或不再有效，需要重新选择并校验。"];
				return;
			}
			ready = { docId, identity: version.identity, text: details.rendered_report };
			issues = [];
		} catch {
			invalidate("无法核验报告与当前工作簿版本的一致性。");
		}
	});
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (!eligible || !sameSession(ctx) || message.role !== "assistant") return;
		if (
			ctx.signal?.aborted ||
			message.stopReason !== "stop" ||
			message.content.some((block) => block.type === "toolCall")
		)
			return;
		let text: string;
		try {
			if (ready && activeWorkbooks(ctx.cwd).get(ready.docId)?.identity !== ready.identity)
				invalidate("报告生成后工作簿版本发生变化，需要重新选择并校验。");
			if (sectionRepair && activeWorkbooks(ctx.cwd).get(sectionRepair.docId)?.identity !== sectionRepair.identity)
				invalidate("报告校验后工作簿版本发生变化，需要重新选择并校验。");
			if (!ready && sectionRepair && repairAttempts < 1) {
				pi.sendMessage(
					{
						customType: "pe-valuation-report-repair",
						display: false,
						content:
							"The current valuation report failed only section prose validation. Continue the existing report request: use section_issues from the latest pe_valuation_report result to revise the affected title/analysis fields, preserving checked facts and calculations. Route numeric claims and observed financial trends through facts/calculations and fact_ids; retain supported qualitative drivers and explicit conditional risks. Remove manual citations and unconfirmed metadata commentary. Do not relabel unchecked facts as hypotheses. Do not reread the workbook for prose-only errors. Call pe_valuation_report again for the same doc_id with scope=overview, then return rendered_report verbatim only if ready. This is one bounded repair attempt; do not repeat the failed request unchanged.",
					},
					{ deliverAs: "followUp" },
				);
				repairAttempts++;
				sectionRepair = undefined;
				text = "正在修正报告文字并重新校验。";
			} else text = ready?.text ?? blockedReport(issues);
		} catch {
			invalidate("无法重新核验当前工作簿版本，暂不交付报告。");
			text = blockedReport(issues);
		}
		return {
			message: {
				...message,
				content: [...message.content.filter((block) => block.type === "thinking"), { type: "text" as const, text }],
			},
		};
	});
}
