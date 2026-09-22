import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { readWorkbookContextSource, type WorkbookFactContext, workbookFactContextSchema } from "../workbook-context.ts";
import { normalizeText, openPeDataset } from "./database.ts";
import type { ExcelCellDetail } from "./excel-cells.ts";
import { getPeExcelRange } from "./excel-range.ts";
import {
	compactReportCitations,
	reportText as markdownText,
	reportMetricLabel,
	valuationOverviewLayout,
} from "./valuation-report-layout.ts";
import { type ReportSectionIssue, validateReportSectionProse } from "./valuation-report-prose.ts";

export const PE_VALUATION_REPORT_PROMPT_SNIPPET =
	"Validate source cells and render a readable valuation report with forecast-year/method comparison tables, formula explanations and compact source links; provide checked operating drivers and qualitative analysis, never invented numeric values";

export interface ReportFactRequest {
	id: string;
	sheet_name: string;
	cell_ref: string;
	expected_label: string;
	expected_period?: string;
	expected_unit?: string;
	display_unit?: string;
	context?: WorkbookFactContext;
	role?: "metric" | "target_price" | "per_share_value" | "enterprise_value" | "equity_value" | "current_price";
	valuation_method?: string;
	period_kind?: "historical" | "forecast" | "current";
}

export interface ReportCalculation {
	id: string;
	operation: "growth" | "change" | "ratio" | "upside" | "product";
	left: string;
	right: string;
}

export interface PeValuationReportOptions {
	docId: string;
	datasetId?: string;
	scope: "overview" | "focused";
	facts: ReportFactRequest[];
	calculations: ReportCalculation[];
	sections: Array<{ title: string; fact_ids: string[]; analysis?: string }>;
}

interface Quantity {
	dimension: string;
	scale: number;
	label: string;
}

interface ReportFact {
	id: string;
	cell: ExcelCellDetail;
	quantity: Quantity;
	base_value: number;
	text: string;
	table_value: string;
	request: ReportFactRequest;
}

export interface PeValuationReportResult {
	doc_id: string;
	status: "ready" | "blocked";
	issues: string[];
	section_issues: ReportSectionIssue[];
	repair_scope?: "sections";
	rendered_report?: string;
	facts: Array<{ id: string; cell: ExcelCellDetail; text: string }>;
	calculations: Array<{ id: string; value: number; text: string }>;
	validation_scope: string;
}

function quantity(unit: string): Quantity | undefined {
	const currency = /^(EUR|USD|CNY|RMB|HKD|GBP|JPY)(m|bn|_100m|\/share)?$/u.exec(unit);
	if (currency) {
		const suffix = currency[2] ?? "";
		return {
			dimension: `${currency[1]}${suffix === "/share" ? "/share" : ""}`,
			scale: suffix === "m" ? 1e6 : suffix === "bn" ? 1e9 : suffix === "_100m" ? 1e8 : 1,
			label: `${suffix === "m" ? "百万" : suffix === "bn" ? "十亿" : suffix === "_100m" ? "亿" : ""}${currency[1]}${suffix === "/share" ? "/股" : ""}`,
		};
	}
	if (unit === "shares_m" || unit === "shares")
		return {
			dimension: "shares",
			scale: unit === "shares_m" ? 1e6 : 1,
			label: unit === "shares_m" ? "百万股" : "股",
		};
	if (unit === "%") return { dimension: "ratio", scale: 1, label: "%" };
	if (unit === "per_share") return { dimension: "unknown_currency/share", scale: 1, label: "每股金额" };
	if (unit === "share_count_unspecified_scale") return { dimension: "unknown_share_scale", scale: 1, label: "" };
	if (["x", "multiple", "times"].includes(unit)) return { dimension: "multiple", scale: 1, label: "倍" };
	return undefined;
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function periodOrder(period: string): { year: number; grain: string } | undefined {
	const year = /(?:19|20)\d{2}/u.exec(period)?.[0];
	if (!year) return undefined;
	return {
		year: Number(year),
		grain: period
			.toUpperCase()
			.replace(/\s/gu, "")
			.replace(/^FY/u, "")
			.replace(/[EAF]$/u, "")
			.replace(year, ""),
	};
}

/** Only source values and the listed arithmetic are checked. This never recalculates Excel or verifies investment judgments. */
export function buildPeValuationReport(cwd: string, options: PeValuationReportOptions): PeValuationReportResult {
	const issues: string[] = [];
	const result: PeValuationReportResult = {
		doc_id: options.docId,
		status: "blocked",
		issues,
		section_issues: [],
		facts: [],
		calculations: [],
		validation_scope:
			"Original value and context-text matching, deterministic arithmetic. Labels, periods, units and business roles are agent interpretation grounded in the cited context; stored formula caches are not recalculated.",
	};
	const facts = new Map<string, ReportFact>();
	const statements = new Map<string, string>();
	const ids = new Set<string>();
	for (const request of options.facts) {
		if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(request.id) || ids.has(request.id)) {
			issues.push(`Invalid or duplicate fact id: ${request.id}`);
			continue;
		}
		ids.add(request.id);
		const location = `${request.sheet_name}!${request.cell_ref}`;
		if (!/^[A-Z]{1,3}[1-9]\d*$/u.test(request.cell_ref)) {
			issues.push(`${location}: one exact cell is required`);
			continue;
		}
		const range = getPeExcelRange(cwd, {
			docId: options.docId,
			datasetId: options.datasetId,
			sheetName: request.sheet_name,
			cellRange: request.cell_ref,
		});
		const sourceCell = (range.cells as ExcelCellDetail[])[0];
		if (
			!request.context?.label ||
			!request.context.unit ||
			!request.expected_unit ||
			(request.expected_period && !request.context.period)
		) {
			issues.push(`${location}: label, unit and requested period require original context source cells`);
			continue;
		}
		const contextConnection = openPeDataset(cwd, options.datasetId);
		const contextCells: ExcelCellDetail[] = [];
		try {
			for (const context of [request.context.label, request.context.period, request.context.unit])
				if (context)
					contextCells.push(
						readWorkbookContextSource(
							contextConnection.database,
							contextConnection.datasetId,
							options.docId,
							context,
						),
					);
		} catch (error) {
			issues.push(`${location}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		} finally {
			contextConnection.database.close();
		}
		const cell = sourceCell
			? {
					...sourceCell,
					row_label: request.expected_label,
					period: request.expected_period,
					unit: request.expected_unit,
				}
			: undefined;
		if (!cell || cell.numeric_value === undefined || !Number.isFinite(cell.numeric_value)) {
			issues.push(`${location}: numeric source value unavailable`);
			continue;
		}
		if (cell.is_formula && cell.formula_cache_status !== "present") {
			issues.push(`${location}: usable formula cache required`);
			continue;
		}
		if (!request.expected_label.trim()) {
			issues.push(`${location}: metric label is required`);
			continue;
		}
		const sourceQuantity = quantity(cell.unit ?? "");
		const displayQuantity = quantity(request.display_unit ?? cell.unit ?? "");
		if (!sourceQuantity || !displayQuantity || sourceQuantity.dimension !== displayQuantity.dimension) {
			issues.push(`${location}: unresolved or incompatible unit`);
			continue;
		}
		// Excel's percent format scales a stored fraction by 100. Formula text is
		// never evidence of storage scale (it may contain a percent literal).
		const percentIsFraction =
			/%/u.test((cell.number_format ?? "").replace(/"[^"]*"|\\./gu, "")) ||
			/^[-+]?\d[\d,]*(?:\.\d+)?\s*%$/u.test((cell.is_formula ? cell.cached_value : cell.raw_value)?.trim() ?? "");
		if (sourceQuantity.dimension === "ratio" && !percentIsFraction && Math.abs(cell.numeric_value) <= 1) {
			issues.push(`${location}: ambiguous percentage storage; inspect the source format before calculating`);
			continue;
		}
		const baseValue =
			(cell.numeric_value * sourceQuantity.scale) /
			(sourceQuantity.dimension === "ratio" && !percentIsFraction ? 100 : 1);
		const displayValue = sourceQuantity.dimension === "ratio" ? baseValue * 100 : baseValue / displayQuantity.scale;
		const origin = cell.is_formula ? "模型保存值" : "模型填写值";
		const citations = [
			...new Set([cell.markdown_citation, ...contextCells.map((context) => context.markdown_citation)]),
		].join(" ");
		const tableValue = `${formatNumber(displayValue)}${displayQuantity.label ? ` ${displayQuantity.label}` : ""}（${origin}）。${citations}`;
		const text = `${cell.period ? `${markdownText(cell.period)} · ` : ""}${markdownText(reportMetricLabel(cell.row_label ?? location))}：${tableValue}`;
		facts.set(request.id, {
			id: request.id,
			cell,
			quantity: sourceQuantity,
			base_value: baseValue,
			text,
			table_value: tableValue,
			request,
		});
		statements.set(request.id, text);
		result.facts.push({ id: request.id, cell, text });
	}

	const outputLocations = new Set(
		[...facts.values()]
			.filter((fact) => fact.request.role === "target_price" || fact.request.role === "per_share_value")
			.map((fact) => `${fact.cell.sheet_name}!${fact.cell.cell_ref}`),
	);
	const priceLocations = new Set(
		[...facts.values()]
			.filter((fact) => fact.request.role === "current_price")
			.map((fact) => `${fact.cell.sheet_name}!${fact.cell.cell_ref}`),
	);
	for (const calculation of options.calculations) {
		if (ids.has(calculation.id) || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(calculation.id)) {
			issues.push(`Invalid or duplicate calculation id: ${calculation.id}`);
			continue;
		}
		ids.add(calculation.id);
		const left = facts.get(calculation.left);
		const right = facts.get(calculation.right);
		if (!left || !right) {
			issues.push(`${calculation.id}: both inputs must be valid source facts`);
			continue;
		}
		let value: number;
		let text: string;
		const sameDimension =
			left.quantity.dimension === right.quantity.dimension && !left.quantity.dimension.startsWith("unknown_");
		if (calculation.operation === "growth" || calculation.operation === "change") {
			const before = periodOrder(left.cell.period ?? "");
			const after = periodOrder(right.cell.period ?? "");
			if (
				!sameDimension ||
				normalizeText(left.cell.row_label) !== normalizeText(right.cell.row_label) ||
				!before ||
				!after ||
				before.grain !== after.grain ||
				before.year >= after.year
			) {
				issues.push(`${calculation.id}: change needs the same metric, units and comparable ordered periods`);
				continue;
			}
			if (calculation.operation === "growth" && left.base_value <= 0) {
				issues.push(`${calculation.id}: growth requires a positive base`);
				continue;
			}
			value =
				calculation.operation === "growth"
					? right.base_value / left.base_value - 1
					: right.base_value - left.base_value;
			const scaled =
				calculation.operation === "growth" || left.quantity.dimension === "ratio"
					? Math.abs(value) * 100
					: Math.abs(value) / left.quantity.scale;
			const unit =
				calculation.operation === "growth"
					? "%"
					: left.quantity.dimension === "ratio"
						? "个百分点"
						: left.quantity.label;
			text = `${markdownText(left.cell.row_label ?? "指标")}（${markdownText(left.cell.period ?? "")} → ${markdownText(right.cell.period ?? "")}）：${value > 0 ? "上升" : value < 0 ? "下降" : "不变"} ${formatNumber(scaled)} ${unit}`;
		} else if (calculation.operation === "ratio") {
			if (!sameDimension || !left.cell.period || left.cell.period !== right.cell.period || right.base_value === 0) {
				issues.push(`${calculation.id}: ratio requires matching units, periods and nonzero denominator`);
				continue;
			}
			value = left.base_value / right.base_value;
			text = `${markdownText(left.cell.row_label ?? "分子")} ÷ ${markdownText(right.cell.row_label ?? "分母")}（${markdownText(left.cell.period)}）：${formatNumber(value * 100)}%`;
		} else if (calculation.operation === "upside") {
			if (
				!sameDimension ||
				!left.quantity.dimension.endsWith("/share") ||
				right.base_value <= 0 ||
				!outputLocations.has(`${left.cell.sheet_name}!${left.cell.cell_ref}`) ||
				!priceLocations.has(`${right.cell.sheet_name}!${right.cell.cell_ref}`)
			) {
				issues.push(
					`${calculation.id}: upside requires a located per-share output and reference price in the same currency`,
				);
				continue;
			}
			value = left.base_value / right.base_value - 1;
			text = `${markdownText(left.cell.sheet_name)} 目标结果相对 ${markdownText(right.cell.sheet_name)}!${right.cell.cell_ref} 参考价格：${value >= 0 ? "上行" : "下行"} ${formatNumber(Math.abs(value) * 100)}%（按指定基准补充计算）`;
		} else {
			if (
				!left.quantity.dimension.endsWith("/share") ||
				right.quantity.dimension !== "multiple" ||
				(left.cell.period && right.cell.period && left.cell.period !== right.cell.period)
			) {
				issues.push(
					`${calculation.id}: product requires a per-share input and a multiple for the same period, or an explicitly undated fixed multiple`,
				);
				continue;
			}
			value = left.base_value * right.base_value;
			text = `${markdownText(left.cell.row_label ?? "每股收益")}${left.cell.period ? `（${markdownText(left.cell.period)}）` : ""}× ${markdownText(right.cell.row_label ?? "倍数")}：${formatNumber(value / left.quantity.scale)} ${left.quantity.label}`;
		}
		if (!Number.isFinite(value)) {
			issues.push(`${calculation.id}: non-finite result`);
			continue;
		}
		text += `（程序计算）。${left.cell.markdown_citation} ${right.cell.markdown_citation}`;
		statements.set(calculation.id, text);
		result.calculations.push({ id: calculation.id, value, text });
	}

	const lines: string[] = [];
	const notes: string[] = [];
	const appendix: string[] = [];
	if (options.scope === "overview") {
		const outputs = [...facts.values()].filter((fact) =>
			["target_price", "per_share_value", "enterprise_value", "equity_value"].includes(fact.request.role ?? ""),
		);
		const overview = valuationOverviewLayout(
			outputs.map((fact) => ({
				label: fact.cell.row_label ?? fact.cell.cell_ref,
				sheet: fact.cell.sheet_name,
				period: fact.cell.period,
				periodKind: fact.request.period_kind,
				method: fact.request.valuation_method,
				value: fact.table_value,
				formula: fact.cell.formula,
			})),
		);
		lines.push(...overview.lines);
		appendix.push(...overview.appendix);
		if (!overview.outputCount)
			issues.push("An overview requires agent-selected valuation outputs and their source context");
	}
	const usedStatements = new Set<string>();
	for (const [sectionIndex, section] of options.sections.entries()) {
		const { analysis, issues: sectionIssues } = validateReportSectionProse(section, sectionIndex);
		result.section_issues.push(...sectionIssues);
		for (const issue of sectionIssues)
			issues.push(`章节「${section.title}」的 ${issue.field}：${issue.excerpt} — ${issue.repair}`);
		for (const id of section.fact_ids) {
			if (!statements.has(id)) issues.push(`Section ${section.title}: unknown or invalid fact ${id}`);
		}
		if (analysis && !section.fact_ids.some((id) => statements.has(id))) {
			issues.push(
				`Section ${section.title}: analyst interpretation requires at least one checked fact or calculation`,
			);
			continue;
		}
		if (sectionIssues.length) continue;
		if (!section.fact_ids.length && !analysis) continue;
		lines.push(`## ${markdownText(section.title)}`, "");
		const sectionFacts = section.fact_ids.filter((id) => facts.has(id) && !usedStatements.has(id));
		if (sectionFacts.length > 1) {
			lines.push("| 指标 | 期间 | 模型数值 |", "| --- | --- | ---: |");
			for (const id of sectionFacts) {
				const fact = facts.get(id);
				if (!fact || usedStatements.has(id)) continue;
				lines.push(
					`| ${markdownText(reportMetricLabel(fact.cell.row_label ?? fact.cell.cell_ref))} | ${markdownText(fact.cell.period ?? "")} | ${fact.table_value} |`,
				);
				usedStatements.add(id);
			}
			lines.push("");
		}
		for (const id of section.fact_ids) {
			const text = statements.get(id);
			if (!text) continue;
			if (usedStatements.has(id)) continue;
			usedStatements.add(id);
			lines.push(`- ${text}`);
		}
		if (analysis) lines.push("", `分析推断：${markdownText(analysis)}`);
		lines.push("");
	}
	if (
		options.scope === "focused" &&
		!options.sections.some((section) => section.fact_ids.some((id) => statements.has(id)))
	)
		issues.push("A focused report must include at least one checked fact or calculation");
	if (issues.length && issues.length === result.section_issues.length) result.repair_scope = "sections";
	if (!issues.length) {
		result.status = "ready";
		result.rendered_report = compactReportCitations([...lines, ...notes, ...appendix].join("\n").trim());
	}
	return result;
}

export const peValuationReportTool = defineTool({
	name: "pe_valuation_report",
	label: "PE Valuation Report",
	promptSnippet: PE_VALUATION_REPORT_PROMPT_SNIPPET,
	description:
		"Build a valuation report from agent-selected source values and original context cells. Supply canonical labels, periods, units and business roles after reading their sources; context cites the exact label/period/unit text or number format. The tool checks those source facts, saved formula values, compatible conversions and arithmetic, without certifying agent interpretation or recalculating Excel. An overview renders only explicitly selected output facts and their declared valuation methods. Qualitative analysis must reference fact_ids; numbers and observed trends belong in facts/calculations. On repair_scope=sections, correct only the indicated prose. Once ready, return rendered_report verbatim.",
	parameters: Type.Object({
		doc_id: Type.String({ minLength: 1 }),
		dataset_id: Type.Optional(Type.String()),
		scope: Type.Union([Type.Literal("overview"), Type.Literal("focused")]),
		facts: Type.Array(
			Type.Object({
				id: Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,63}$" }),
				sheet_name: Type.String({ minLength: 1 }),
				cell_ref: Type.String({ pattern: "^[A-Z]{1,3}[1-9][0-9]*$" }),
				expected_label: Type.String({
					minLength: 1,
					description:
						"Agent-interpreted metric label grounded in context.label, including earnings/share-count basis.",
				}),
				context: workbookFactContextSchema,
				role: Type.Optional(
					Type.Union([
						Type.Literal("metric"),
						Type.Literal("target_price"),
						Type.Literal("per_share_value"),
						Type.Literal("enterprise_value"),
						Type.Literal("equity_value"),
						Type.Literal("current_price"),
					]),
				),
				valuation_method: Type.Optional(
					Type.String({ description: "Agent-identified valuation method, supported by source context." }),
				),
				period_kind: Type.Optional(
					Type.Union([Type.Literal("historical"), Type.Literal("forecast"), Type.Literal("current")]),
				),
				expected_period: Type.Optional(
					Type.String({
						description: "Exact financial period from the source header. Never infer valuation date from this.",
					}),
				),
				expected_unit: Type.String({
					minLength: 1,
					description:
						"Canonical unit interpreted from context.unit; the tool checks source text and compatible arithmetic, not the interpretation.",
				}),
				display_unit: Type.Optional(
					Type.String({ description: "Canonical compatible unit, e.g. EURm, EUR_100m, EUR/share, shares_m, %." }),
				),
			}),
			{ maxItems: 40 },
		),
		calculations: Type.Array(
			Type.Object({
				id: Type.String(),
				operation: Type.Union([
					Type.Literal("growth"),
					Type.Literal("change"),
					Type.Literal("ratio"),
					Type.Literal("upside"),
					Type.Literal("product"),
				]),
				left: Type.String({ description: "Numerator/earlier-period/target/EPS fact id." }),
				right: Type.String({ description: "Denominator/later-period/reference price/multiple fact id." }),
			}),
			{ maxItems: 30 },
		),
		sections: Type.Array(
			Type.Object({
				title: Type.String({ minLength: 1, maxLength: 100 }),
				fact_ids: Type.Array(Type.String(), { maxItems: 40 }),
				analysis: Type.Optional(
					Type.String({
						maxLength: 3000,
						description:
							"Qualitative inference tied to fact_ids. Use facts/calculations for numbers, years, observed financial trends and citations, including Chinese numerals. Explicit conditional risks are allowed, e.g. 若盈利下降，估值可能承压. Do not disguise unchecked factual claims as hypotheses.",
					}),
				),
			}),
			{ minItems: 1, maxItems: 8 },
		),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		await preparePeDocument(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		const result = buildPeValuationReport(ctx.cwd, {
			docId: params.doc_id,
			datasetId: params.dataset_id,
			scope: params.scope,
			facts: params.facts,
			calculations: params.calculations,
			sections: params.sections,
		});
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
			isError: result.status === "blocked",
		};
	},
});
