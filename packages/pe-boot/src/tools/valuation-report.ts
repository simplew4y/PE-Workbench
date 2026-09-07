import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { normalizeText } from "./database.ts";
import type { ExcelCellDetail } from "./excel-cells.ts";
import { getPeExcelRange } from "./excel-range.ts";
import { resolvePeValuationDate } from "./valuation-date.ts";
import { locatePeValuationOutputs } from "./valuation-output.ts";

export const PE_VALUATION_REPORT_PROMPT_SNIPPET =
	"Validate source-cell labels, periods and units, calculate financial comparisons, and render a valuation report with every located method and version-bound citations; never supply invented numeric values";

export interface ReportFactRequest {
	id: string;
	sheet_name: string;
	cell_ref: string;
	expected_label: string;
	expected_period?: string;
	expected_unit?: string;
	display_unit?: string;
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
}

export interface PeValuationReportResult {
	doc_id: string;
	status: "ready" | "blocked";
	issues: string[];
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
	if (unit === "per_share") return { dimension: "unknown_currency/share", scale: 1, label: "每股金额（币种未确认）" };
	if (unit === "share_count_unspecified_scale")
		return { dimension: "unknown_share_scale", scale: 1, label: "股数原表单位（股／百万股尺度未确认）" };
	if (["x", "multiple", "times"].includes(unit)) return { dimension: "multiple", scale: 1, label: "倍" };
	return undefined;
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function markdownText(value: string): string {
	return value.replace(/[\\`*_[\]<>|#]/gu, "\\$&").replace(/\r?\n/gu, " ");
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
		facts: [],
		calculations: [],
		validation_scope:
			"Source-cell label/period/unit matching, deterministic arithmetic and located-output coverage. Stored formula caches are not recalculated. Narrative is explicitly analyst inference, not independently verified.",
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
		const cell = (range.cells as ExcelCellDetail[])[0];
		if (!cell || cell.numeric_value === undefined || !Number.isFinite(cell.numeric_value)) {
			issues.push(`${location}: numeric source value unavailable`);
			continue;
		}
		if (cell.is_formula && cell.formula_cache_status !== "present") {
			issues.push(`${location}: usable formula cache required`);
			continue;
		}
		if (!request.expected_label.trim() || normalizeText(request.expected_label) !== normalizeText(cell.row_label)) {
			issues.push(`${location}: metric label mismatch; source is ${cell.row_label ?? "missing"}`);
			continue;
		}
		if (
			request.expected_period !== undefined &&
			normalizeText(request.expected_period) !== normalizeText(cell.period)
		) {
			issues.push(`${location}: period mismatch; source is ${cell.period ?? "missing"}`);
			continue;
		}
		if (request.expected_unit !== undefined && request.expected_unit !== cell.unit) {
			issues.push(`${location}: unit mismatch; source is ${cell.unit ?? "missing"}`);
			continue;
		}
		if (cell.period_context?.status === "ambiguous" || cell.unit_context?.status === "ambiguous") {
			issues.push(`${location}: ambiguous period or unit requires source review`);
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
		const text = `${cell.period ? `${markdownText(cell.period)} · ` : ""}${markdownText(cell.row_label ?? location)}：${formatNumber(displayValue)} ${displayQuantity.label}（${origin}）。${cell.markdown_citation}`;
		facts.set(request.id, { id: request.id, cell, quantity: sourceQuantity, base_value: baseValue, text });
		statements.set(request.id, text);
		result.facts.push({ id: request.id, cell, text });
	}

	const inventory = locatePeValuationOutputs(cwd, { docId: options.docId, datasetId: options.datasetId, topK: 25 });
	const outputLocations = new Set(
		inventory.output_groups.flatMap((group) =>
			group.outputs
				.filter((output) => ["target_price", "per_share_value"].includes(output.semantic_role))
				.map((output) => `${output.sheet_name}!${output.cell_ref}`),
		),
	);
	const priceLocations = new Set(
		inventory.cross_check_nodes
			.filter((node) => node.role === "current_price")
			.map((node) => `${node.sheet_name}!${node.cell_ref}`),
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
			text = `${markdownText(left.cell.sheet_name)} 目标结果相对 ${markdownText(right.cell.sheet_name)}!${right.cell.cell_ref} 参考价格：${value >= 0 ? "上行" : "下行"} ${formatNumber(Math.abs(value) * 100)}%（按指定基准补充计算，价格时点未核实）`;
		} else {
			if (
				!left.quantity.dimension.endsWith("/share") ||
				right.quantity.dimension !== "multiple" ||
				!/(?:\beps\b|earnings?\s+per\s+share|每股收益)/iu.test(left.cell.row_label ?? "") ||
				(left.cell.period && right.cell.period && left.cell.period !== right.cell.period)
			) {
				issues.push(
					`${calculation.id}: product requires EPS and a multiple for the same period, or an explicitly undated fixed multiple`,
				);
				continue;
			}
			value = left.base_value * right.base_value;
			text = `${markdownText(left.cell.row_label ?? "每股收益")}（${markdownText(left.cell.period ?? "期间未确认")}）× ${markdownText(right.cell.row_label ?? "倍数")}：${formatNumber(value / left.quantity.scale)} ${left.quantity.label}${!right.cell.period ? "（倍数未标期间，按固定假设补充计算）" : ""}`;
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
	if (options.scope === "overview") {
		if (!inventory.output_inventory_complete)
			issues.push(
				"Valuation output inventory is truncated; inspect individual methods before producing an overview",
			);
		lines.push(
			"## 模型估值结果",
			"",
			"以下为模型填写值或文件保存的公式结果，未刷新行情、未重算整个工作簿。年份、单位与输出角色包含规则推断；覆盖范围是本次定位到的候选结果，不代表整个模型已完成审计。",
			"",
		);
		let outputCount = 0;
		for (const group of inventory.output_groups) {
			const outputs = group.outputs.filter((output) =>
				["target_price", "per_share_value", "dcf_value", "sotp_value"].includes(output.semantic_role),
			);
			if (!outputs.length) continue;
			lines.push(`### ${markdownText(group.sheet_name)}（${group.method}）`, "");
			for (const output of outputs) {
				outputCount++;
				const value =
					output.numeric_value !== undefined &&
					Number.isFinite(output.numeric_value) &&
					(!output.formula || output.formula_cache_status === "present")
						? formatNumber(output.numeric_value)
						: "无法读取可靠缓存";
				lines.push(
					`- ${markdownText(output.label)}：${value} ${markdownText(output.unit === "per_share" ? "每股金额（币种未确认）" : (output.unit ?? "单位尚未确认"))}。${output.score < 0.62 ? "该候选的角色证据较弱，需核对。" : ""}${output.markdown_citations.join(" ")}`,
				);
			}
			if (group.relationships.some((relationship) => relationship.kind === "rounding_consistent"))
				lines.push("- 本组包含取整一致的结果；原始值与取整值分别保留。");
			lines.push("");
		}
		if (!outputCount) issues.push("No sufficiently supported valuation output is available for an overview");
		lines.push("### 参考价格与用途", "");
		for (const price of inventory.cross_check_nodes.filter((node) => node.role === "current_price")) {
			if (price.numeric_value === undefined || !Number.isFinite(price.numeric_value)) continue;
			const uses = price.uses
				.slice(0, 3)
				.map((use) => `${use.sheet_name}!${use.cell_ref}`)
				.join("、");
			lines.push(
				`- ${markdownText(price.sheet_name)}!${price.cell_ref}：${formatNumber(price.numeric_value)}（${price.price_kind === "cached_external" ? "外部函数保存值" : "模型参考值"}，币种按原表核对，取价时间未确认${uses ? `；被 ${markdownText(uses)} 引用` : "；用途未定位"}）。${price.markdown_citation}`,
			);
		}
		const date = resolvePeValuationDate(cwd, {
			docId: options.docId,
			datasetId: options.datasetId,
			allowMetadataFallback: true,
		});
		const dateCitations = date.candidates
			.filter((candidate) => date.selected_candidate_ids.includes(candidate.candidate_id))
			.map((candidate) => candidate.markdown_citation)
			.filter(Boolean)
			.join(" ");
		lines.push(
			"",
			inventory.status === "selected"
				? "主输出由定位规则选出；各方法之间的权重及投资判断仍需模型依据。"
				: "主输出尚有歧义，以上分别保留各方法结果。",
			"",
			"### 日期口径",
			"",
			date.valuation_date
				? `日期解析结果：${date.valuation_date}（状态：${date.status}；来源角色：${date.selected_role ?? "未确定"}）。${dateCitations}`
				: `估值日期尚未确认（${date.status}）。`,
			"文件保存时间、行情取价时间、预测年度和估值日期是不同口径，不能互相替代。",
			"",
		);
	}
	const usedStatements = new Set<string>();
	for (const section of options.sections) {
		const prose = `${section.title} ${section.analysis ?? ""}`;
		const chineseNumericClaim =
			/(?:百分之|千分之|万分之)|[〇零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟点]+\s*(?:年|季度|欧元|美元|人民币|亿|万|股|倍|%|％|个百分点)/u.test(
				prose,
			);
		const quantitativeTrend =
			/(?:毛利率|利润率|税率|营收|收入|每股收益|股数|利润|盈利|目标价|价格|股价).{0,24}(?:扩张|收缩|提升|提高|增加|上升|下降|降低|减少|回落|稳定|增长|下滑|持平)|(?:revenue|sales|margin|tax rate|earnings|EPS|profit|share count|price).{0,24}(?:increas|decreas|ris(?:e|ing)|fall|grow|declin|stable|expand|contract)/iu.test(
				prose,
			);
		if (
			/\p{N}/u.test(section.title) ||
			(section.analysis && /\p{N}|#pe-source|source:|https?:\/\//u.test(section.analysis)) ||
			chineseNumericClaim ||
			quantitativeTrend
		) {
			issues.push(
				`Section ${section.title}: put numeric claims, financial trends and citations in source facts or calculations; keep titles neutral`,
			);
			continue;
		}
		if (section.analysis?.trim() && !section.fact_ids.some((id) => statements.has(id))) {
			issues.push(
				`Section ${section.title}: analyst interpretation requires at least one checked fact or calculation`,
			);
			continue;
		}
		lines.push(`## ${markdownText(section.title)}`, "");
		for (const id of section.fact_ids) {
			const text = statements.get(id);
			if (!text) {
				issues.push(`Section ${section.title}: unknown or invalid fact ${id}`);
				continue;
			}
			if (usedStatements.has(id)) continue;
			usedStatements.add(id);
			lines.push(`- ${text}`);
		}
		if (section.analysis?.trim()) lines.push("", `分析推断：${markdownText(section.analysis.trim())}`);
		lines.push("");
	}
	if (options.scope === "focused" && usedStatements.size === 0)
		issues.push("A focused report must include at least one checked fact or calculation");
	if (!issues.length) {
		result.status = "ready";
		result.rendered_report = lines.join("\n").trim();
	}
	return result;
}

export const peValuationReportTool = defineTool({
	name: "pe_valuation_report",
	label: "PE Valuation Report",
	promptSnippet: PE_VALUATION_REPORT_PROMPT_SNIPPET,
	description:
		"Build the final valuation report from exact source cells. Numeric statements, conversions and financial trends are rendered by code. An overview automatically covers located valuation methods and price inputs. Use neutral headings; qualitative analyst inference must reference checked facts and may not introduce numbers, financial trends or citations. Unspecified share-count scale is disclosed without conversion. A blocked result must be corrected before finalizing; return rendered_report verbatim.",
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
					description: "Exact source row label, including earnings/share-count basis.",
				}),
				expected_period: Type.Optional(
					Type.String({
						description: "Exact financial period from the source header. Never infer valuation date from this.",
					}),
				),
				expected_unit: Type.Optional(Type.String()),
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
							"Qualitative inference tied to fact_ids. Use facts/calculations for all numbers, financial trends and citations, including Chinese numerals; use neutral headings.",
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
