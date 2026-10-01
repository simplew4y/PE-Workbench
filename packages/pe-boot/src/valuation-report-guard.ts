import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openPeDataset, type SqlRow } from "./tools/database.ts";

const WORKBOOK_TOOLS = new Set([
	"pe_document_open",
	"pe_workbook_inspect",
	"pe_workbook_search",
	"pe_excel_render",
	"pe_excel_range",
	"pe_formula_trace",
	"pe_valuation_output_locate",
	"pe_valuation_date_resolve",
	"pe_model_validate",
	"pe_driver_discover",
	"pe_driver_sensitivity",
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

type ReportMode = "overview" | "focused" | "none";

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

function isTrackingOperation(text: string): boolean {
	return /(?:创建|新建|建立|构建|生成|配置|设置|启用|开启|暂停|关闭|更新|刷新|记录|录入|添加|加入|加到|保存).{0,30}(?:股票[追跟]踪|股价[追跟]踪|[追跟]踪(?:表|流程)|模拟(?:交易|买入|卖出|持仓))|\b(?:create|configure|set\s+up|refresh|update|record|add|enable|disable|pause|start|save)\b[^.!?\n]{0,50}\b(?:stock\s+track(?:ing|ers?)|price\s+tracking|tracking\s+(?:table|workflow)|(?:simulated|paper)\s+(?:trade|buy|sell|position)s?)\b/iu.test(
		text,
	);
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
	const trackingOperation = isTrackingOperation(text);
	const explicitReport =
		/(?:生成|撰写|出具|提供|输出|交付|整理|完成).{0,20}(?:(?:完整|整体|全面)(?:的)?(?:估值模型|估值|模型)?报告|估值报告)|\b(?:write|generate|produce|prepare|provide|deliver)\b[^.!?\n]{0,40}\b(?:(?:full|complete|overall)\s+(?:valuation\s+(?:model\s+)?)?report|valuation\s+report)\b/iu.test(
			text,
		);
	// Explicit local scope can span numbered paragraphs; proximity to "valuation model" is not report intent.
	if (
		!explicitReport &&
		/(?:只|仅)\s*(?:做|进行|回答)?\s*(?:以下|上述)?\s*局部(?:模型)?分析|\b(?:only|just)\s+(?:a\s+)?(?:local|focused)\s+(?:model\s+)?analysis\b/iu.test(
			text,
		)
	)
		return false;
	// Creating/refreshing a tracker may require model analysis, but is not itself an overall valuation report.
	if (trackingOperation && !explicitReport) return false;
	// Mechanics and framework research have their own deliverables, not a valuation-report gate.
	if (
		!explicitReport &&
		/(?:投资框架|建模逻辑|预测逻辑|独立假设|底层假设|预测.{0,8}(?:怎么|如何)|怎么.{0,8}预测)|\b(?:investment framework|model mechanics|forecast logic|independent assumptions)\b/iu.test(
			text,
		)
	)
		return false;
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

function requestMode(text: string, imageCount: number): ReportMode {
	// Declining a complete report does not decline a requested local numeric table.
	const reportOptOut =
		/(?:不(?:要|用|必|需要)?|无需|别|勿)\s*(?:再|为此)?\s*(?:给我|给出|提供|生成|输出|创建|制作|写|做|给)?\s*(?:(?:完整|整体|全面)(?:的)?\s*)?(?:投资|估值|模型|研究)?(?:分析)?报告|\b(?:do not|don't|no|without)\s+(?:(?:generate|write|produce|provide)\s+)?(?:(?:a|the)\s+)?(?:(?:full|complete|overall)\s+)?(?:(?:valuation|investment|research)\s+)?report\b/giu;
	const affirmative = text.replace(reportOptOut, "");
	const declinesOverview = affirmative !== text;
	if (!declinesOverview && isOverviewRequest(text, imageCount)) return "overview";
	if (
		isTrackingOperation(affirmative) ||
		/(?:代码|源码|编程|部署|提示词|准确率|准确性|如何优化|怎么优化|修复|截图|截屏|图片|取消|停止|算了|先别|不要继续|不用分析|别分析|\b(?:code|coding|prompt|accuracy|debug|deployment|implementation|cancel|stop|screenshot|image.only)\b|never mind)/iu.test(
			affirmative,
		) ||
		(imageCount > 0 && !/(?:excel|工作簿|\.xlsx\b|\.xlsm\b)/iu.test(affirmative))
	)
		return "none";
	const financial =
		/(?:收入|利润|盈利|现金流|股数|股本|增长率|毛利率|税率|目标价|价格|估值|EPS|P\/E|EBITDA|FCF|\b(?:revenue|earnings|profit|cash flow|shares|growth|margin|tax|price|valuation)\b)/iu.test(
			affirmative,
		);
	const tableRequest = affirmative.replace(
		/(?:不要|不用|无需|别|勿|不)\s*(?:给出|生成|输出|制作|提供|整理|展示|列出|做)?[^。！？\n，,；;]{0,40}(?:表格|数值表|数据表|价格表|收入表|结果表|跨期表|对照表|对比表|比较表|矩阵)/giu,
		"",
	);
	const table =
		/(?:给出|生成|输出|制作|提供|整理|展示|列出|列|做一张|做一个)[^。！？\n]{0,100}(?:表格|数值表|数据表|价格表|收入表|结果表|跨期表|对照表|对比表|比较表|矩阵)|(?:用|以)\s*表格?[^。！？\n]{0,40}(?:给出|列出|展示|比较|对比|呈现)|\b(?:give|generate|produce|provide|show|create|list|compare)\b[^.!?\n]{0,100}\b(?:table|matrix)\b/iu.test(
			tableRequest,
		);
	// Bare 做/给我 are table requests at a clause start, but not in “解释怎么做收入表”.
	const directTable =
		/(?:^|[，,。！？\n：:；;]|并(?:且)?)\s*(?:请|麻烦)?\s*(?:帮我|为我)?\s*(?:只|仅|单独)?\s*(?:做|给我)[^。！？\n，,；;]{0,80}(?:表格|数值表|数据表|价格表|收入表|结果表|跨期表|对照表|对比表|比较表|矩阵)/u.test(
			tableRequest,
		);
	return financial && (table || directTable) ? "focused" : "none";
}

function blockedReport(issues: string[], mode: ReportMode): string {
	const label = mode === "focused" ? "局部数值表" : "整体报告";
	const missing = issues.length ? issues : [`尚未取得当前工作簿${label}的校验结果。`];
	return [
		mode === "focused"
			? "本次数值表尚未通过校验，暂时无法交付未经核验的数字与单位。"
			: "本次估值报告尚未通过校验，暂时无法交付完整报告。",
		"",
		...missing.slice(0, 6).map(
			(issue) =>
				`- ${issue
					.slice(0, 400)
					.replace(/[\\`*_[\]<>|#]/gu, "\\$&")
					.replace(/\s+/gu, " ")}`,
		),
		"",
		`需补齐上述证据或修正冲突，再重新生成经过校验的${label}。`,
	].join("\n");
}

/** Protect the finalized report. Streaming drafts and analyst judgments are not independently verified. */
export function registerValuationReportGuard(pi: ExtensionAPI): void {
	let sessionId: string | undefined;
	let workspace: string | undefined;
	let generation = 0;
	let revision = 0;
	let eligible = false;
	let mode: ReportMode = "none";
	let previousMode: ReportMode = "none";
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
		mode = "none";
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
			previousMode !== "none" &&
			/^(?:请)?(?:继续|继续分析|继续生成|continue|resume)[。.!！\s]*$/iu.test(text.trim());
		clearRun();
		sessionId = ctx.sessionManager.getSessionId();
		workspace = ctx.cwd;
		mode = continuation ? previousMode : requestMode(text, imageCount);
		previousMode = mode;
		if (mode === "none" || !existsSync(join(ctx.cwd, "meta", "collection.sqlite3"))) return;
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
			invalidate(`分析所用文档发生变化，需要重新生成当前版本的${mode === "focused" ? "局部数值表" : "整体报告"}。`);
			selectedDocId = docId;
		}
	}

	pi.on("before_agent_start", (event, ctx) => {
		beginRequest(event.prompt, event.images?.length ?? 0, ctx);
		initialPrompt = event.prompt;
		if (eligible && mode === "focused")
			return {
				message: {
					customType: "pe-focused-numeric-delivery",
					display: false,
					content:
						"This request requires a checked local numeric table, not a whole-model report. Load pe-valuation-report and use pe_valuation_report with scope=focused. Read the original unit context for each fact and use the current tool schema for supported source values, calculations and scenario conditions; never submit invented results. Include all requested numeric comparisons and their explanations in the focused result. Preserve concrete gaps when a requested calculation is unavailable; do not silently replace the task with a smaller baseline-only table. This does not require an overview or full model-understanding review. Return rendered_report verbatim only when status=ready, without rewriting numbers or units. If required tools are unavailable, state the limitation instead of inventing a result.",
				},
			};
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
		previousMode = "none";
		initialPrompt = undefined;
	});
	pi.on("session_tree", () => {
		clearRun();
		previousMode = "none";
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
			issues = [mode === "focused" ? "局部数值表的校验尚未完成。" : "整体报告的校验尚未完成。"];
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
					call.scope === mode &&
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
			if (call.scope !== mode) {
				issues = [
					mode === "focused"
						? "当前请求需要局部数值表，请使用 scope=focused 保留所需结果与说明。"
						: "当前请求需要整体估值报告，局部指标报告不能替代完整校验。",
				];
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
						content: `The current valuation report failed only section prose validation. Continue the existing report request: use section_issues from the latest pe_valuation_report result to revise the affected title/analysis fields, preserving checked facts and calculations. Route numeric claims and observed financial trends through facts/calculations and fact_ids; retain supported qualitative drivers and explicit conditional risks. Replace workbook coordinates, Excel formulas, propagation-path labels and runtime terms with business names and plain-language mechanisms; keep implementation details in evidence metadata. Remove manual citations and unconfirmed metadata commentary. Do not relabel unchecked facts as hypotheses. Do not reread the workbook for prose-only errors. Call pe_valuation_report again for the same doc_id with scope=${mode}, then return rendered_report verbatim only if ready. Preserve all requested comparisons, scenario conditions and explanations; do not silently reduce scope. This is one bounded repair attempt; do not repeat the failed request unchanged.`,
					},
					{ deliverAs: "followUp" },
				);
				repairAttempts++;
				sectionRepair = undefined;
				text = "正在修正报告文字并重新校验。";
			} else text = ready?.text ?? blockedReport(issues, mode);
		} catch {
			invalidate("无法重新核验当前工作簿版本，暂不交付报告。");
			text = blockedReport(issues, mode);
		}
		return {
			message: {
				...message,
				content: [...message.content.filter((block) => block.type === "thinking"), { type: "text" as const, text }],
			},
		};
	});
}
