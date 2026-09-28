import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { readWorkbookContextSource, type WorkbookFactContext, workbookFactContextSchema } from "../workbook-context.ts";
import { type Quantity, quantity, resolveSourceQuantity } from "../workbook-units.ts";
import { normalizeText, openPeDataset } from "./database.ts";
import type { PeDriverSensitivityResult } from "./driver-sensitivity.ts";
import type { ExcelCellDetail } from "./excel-cells.ts";
import { getPeExcelRange } from "./excel-range.ts";
import {
	compactReportCitations,
	reportText as markdownText,
	reportMetricLabel,
	valuationOverviewLayout,
} from "./valuation-report-layout.ts";
import {
	findWorkbookImplementationDetail,
	type ReportSectionIssue,
	validateReportSectionProse,
} from "./valuation-report-prose.ts";

export const PE_VALUATION_REPORT_PROMPT_SNIPPET =
	"Validate source cells and render a readable valuation report with compact source links and optional recalculated Top Driver sensitivity; use business labels in prose and keep cell coordinates, formulas, tool logs and full audits out of the main report";

export interface ReportFactRequest {
	id: string;
	sheet_name: string;
	cell_ref: string;
	expected_label: string;
	expected_period?: string;
	expected_unit?: string;
	display_unit?: string;
	factor?: number;
	scenario?: { run_id: string; driver_id: string; direction: "down" | "up" };
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
	sensitivityRunId?: string;
}

interface ReportFact {
	id: string;
	cell: ExcelCellDetail;
	quantity: Quantity;
	base_value: number;
	text: string;
	table_value: string;
	origin: string;
	request: ReportFactRequest;
}

export interface PeValuationReportResult {
	doc_id: string;
	status: "ready" | "blocked";
	issues: string[];
	section_issues: ReportSectionIssue[];
	repair_scope?: "sections";
	rendered_report?: string;
	facts: Array<{
		id: string;
		cell: ExcelCellDetail;
		text: string;
		quantity: Quantity;
		display_quantity: Quantity;
		value: number;
		factor?: number;
		scenario?: ReportFactRequest["scenario"];
	}>;
	calculations: Array<{ id: string; value: number; text: string }>;
	validation_scope: string;
	sensitivity?: { run_id: string; ranked_driver_count: number; result_json: string };
}

const SENSITIVITY_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function signedPercent(value: number | undefined): string {
	if (value === undefined) return "无法按百分比表示";
	return `${value > 0 ? "+" : ""}${formatNumber(value)}%`;
}

function loadSensitivityRun(cwd: string, runId: string): PeDriverSensitivityResult {
	if (!SENSITIVITY_RUN_ID.test(runId)) throw new Error("invalid sensitivity run id");
	const path = join(cwd, "generated", "sensitivity", runId, "result.json");
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid sensitivity result");
	const result = parsed as Partial<PeDriverSensitivityResult>;
	if (
		result.schema_version !== "1.0" ||
		result.run_id !== runId ||
		typeof result.doc_id !== "string" ||
		result.original_unchanged !== true ||
		!result.output ||
		typeof result.output.sheet_name !== "string" ||
		typeof result.output.cell_ref !== "string" ||
		!Array.isArray(result.ranked_drivers) ||
		!result.artifacts ||
		typeof result.artifacts.result_json !== "string"
	)
		throw new Error("incomplete sensitivity result");
	return result as PeDriverSensitivityResult;
}

function sensitivityLayout(
	result: PeDriverSensitivityResult,
	citations: ReadonlyMap<string, string>,
	outputQuantity: Quantity,
): string[] {
	const drivers = result.ranked_drivers.filter((driver) => driver.active_driver).slice(0, 5);
	if (!drivers.length) return [];
	const lines = [
		"## 核心敏感性",
		"",
		`以下排序来自隔离副本中的单变量重算：每次仅将一个上游输入调整 ±${formatNumber(result.shock.percent)}%，其他输入保持不变；原工作簿未修改。`,
		"",
		"| 排名 | 核心假设 | 下行情景的估值变化 | 上行情景的估值变化 | 最大绝对影响 |",
		"| ---: | --- | ---: | ---: | ---: |",
	];
	for (const driver of drivers)
		lines.push(
			`| ${driver.rank} | ${markdownText(driver.label)} ${citations.get(driver.driver_id) ?? ""} | ${signedPercent(driver.down_output_change_percent)} | ${signedPercent(driver.up_output_change_percent)} | ${driver.max_abs_output_change_percent === undefined ? `${formatNumber(driver.max_abs_output_change)} ${outputQuantity.label}` : `${formatNumber(driver.max_abs_output_change_percent)}%`} |`,
		);
	if (result.status === "partial")
		lines.push("", "部分候选输入因非数值、零基数或重算结果不可用而未进入排名；完整原因保留在审计附件中。");
	lines.push("");
	return lines;
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
}

function sameFiniteValue(left: unknown, right: unknown): boolean {
	return (
		typeof left === "number" &&
		typeof right === "number" &&
		Number.isFinite(left) &&
		Number.isFinite(right) &&
		Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-9)
	);
}

function scenarioValue(
	cwd: string,
	options: PeValuationReportOptions,
	datasetId: string,
	cell: ExcelCellDetail,
	scenario: NonNullable<ReportFactRequest["scenario"]>,
	runs: Map<string, PeDriverSensitivityResult>,
): { value: number; origin: string } {
	const run = runs.get(scenario.run_id) ?? loadSensitivityRun(cwd, scenario.run_id);
	runs.set(scenario.run_id, run);
	if (run.doc_id !== options.docId || run.dataset_id !== datasetId)
		throw new Error("Scenario belongs to a different workbook or dataset");
	if (!["completed", "partial"].includes(run.status) || !run.sensitivity_ranking_available)
		throw new Error("Scenario has no measured recalculation");
	if (
		run.shock?.method !== "relative_one_at_a_time" ||
		!Number.isFinite(run.shock.percent) ||
		run.shock.percent <= 0 ||
		!["down", "up"].includes(scenario.direction)
	)
		throw new Error("Scenario shock or direction is invalid");
	const drivers = run.ranked_drivers.filter((candidate) => candidate.driver_id === scenario.driver_id);
	if (drivers.length !== 1) throw new Error("Scenario requires one matching driver");
	const driver = drivers[0];
	const nodes = driver.propagation?.filter(
		(node) => node.sheet_name === cell.sheet_name && node.cell_ref === cell.cell_ref,
	);
	if (nodes?.length !== 1) throw new Error("Scenario has no unique propagated value for this source cell");
	const node = nodes[0];
	const value = scenario.direction === "down" ? node.down_value : node.up_value;
	if (
		!sameFiniteValue(node.baseline_value, cell.numeric_value) ||
		node.is_formula !== cell.is_formula ||
		typeof value !== "number" ||
		!Number.isFinite(value)
	)
		throw new Error("Scenario source baseline or propagated value is invalid");
	const input = (
		getPeExcelRange(cwd, {
			docId: options.docId,
			datasetId,
			sheetName: driver.sheet_name,
			cellRange: driver.cell_ref,
		}).cells as ExcelCellDetail[]
	)[0];
	const output = (
		getPeExcelRange(cwd, {
			docId: options.docId,
			datasetId,
			sheetName: run.output.sheet_name,
			cellRange: run.output.cell_ref,
		}).cells as ExcelCellDetail[]
	)[0];
	if (
		!input ||
		input.is_formula ||
		!sameFiniteValue(input.numeric_value, driver.baseline_input) ||
		!output ||
		!sameFiniteValue(output.numeric_value, run.output.baseline_value) ||
		!sameFiniteValue(driver.baseline_output, run.output.baseline_value) ||
		!sameFiniteValue(
			driver.down_input,
			driver.baseline_input - (Math.abs(driver.baseline_input) * run.shock.percent) / 100,
		) ||
		!sameFiniteValue(
			driver.up_input,
			driver.baseline_input + (Math.abs(driver.baseline_input) * run.shock.percent) / 100,
		)
	)
		throw new Error("Scenario input or output no longer matches the source workbook");
	return {
		value,
		origin: `隔离重算：${markdownText(input.row_label ?? driver.label)}相对${scenario.direction === "down" ? "下调" : "上调"}${formatNumber(run.shock.percent)}%，其余原始输入固定`,
	};
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
			"Original values and context text, source-derived unit dimensions/scales, compatible conversions, deterministic arithmetic and optional saved isolated-workbook scenarios are checked. Labels, periods and business roles remain agent interpretation; ordinary stored formula values are not fresh recalculation.",
	};
	const facts = new Map<string, ReportFact>();
	const statements = new Map<string, string>();
	const ids = new Set<string>();
	const scenarioRuns = new Map<string, PeDriverSensitivityResult>();
	for (const request of options.facts) {
		if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(request.id) || ids.has(request.id)) {
			issues.push(`Invalid or duplicate fact id: ${request.id}`);
			continue;
		}
		ids.add(request.id);
		const location = `${request.sheet_name}!${request.cell_ref}`;
		let invalidBusinessLabel = false;
		for (const [field, value] of [
			["expected_label", request.expected_label],
			["valuation_method", request.valuation_method],
		] as const) {
			const detail = value ? findWorkbookImplementationDetail(value) : undefined;
			if (detail) {
				issues.push(
					`${location}: ${field} must be a business label, not workbook implementation detail (${detail})`,
				);
				invalidBusinessLabel = true;
			}
		}
		if (invalidBusinessLabel) continue;
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
		let sourceQuantity: Quantity;
		try {
			const unitCell = contextCells[contextCells.length - 1];
			sourceQuantity = resolveSourceQuantity({
				text:
					request.context.unit.field === "number_format"
						? (unitCell.number_format ?? "")
						: (unitCell.display_value ?? ""),
				field: request.context.unit.field,
				expectedUnit: request.expected_unit,
				metricLabel: contextCells[0].display_value,
			});
		} catch (error) {
			issues.push(`${location}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const displayQuantity = request.display_unit ? quantity(request.display_unit) : sourceQuantity;
		if (!displayQuantity || sourceQuantity.dimension !== displayQuantity.dimension) {
			issues.push(`${location}: unresolved or incompatible unit`);
			continue;
		}
		let rawValue = cell.numeric_value;
		let origin = cell.is_formula ? "模型保存值" : "模型填写值";
		try {
			if (request.factor !== undefined && request.scenario)
				throw new Error("Use either a supplemental factor or a recalculated scenario, never both");
			if (request.factor !== undefined) {
				if (!Number.isFinite(request.factor)) throw new Error("Supplemental factor must be finite");
				rawValue *= request.factor;
				origin = `补充条件：原值×${formatNumber(request.factor)}`;
			}
			if (request.scenario) {
				const selected = scenarioValue(
					cwd,
					options,
					String(range.dataset_id),
					cell,
					request.scenario,
					scenarioRuns,
				);
				rawValue = selected.value;
				origin = selected.origin;
			}
			if (!Number.isFinite(rawValue)) throw new Error("Non-finite scenario or supplemental value");
		} catch (error) {
			issues.push(`${location}: ${error instanceof Error ? error.message : String(error)}`);
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
			(rawValue * sourceQuantity.scale) / (sourceQuantity.dimension === "ratio" && !percentIsFraction ? 100 : 1);
		const displayValue = sourceQuantity.dimension === "ratio" ? baseValue * 100 : baseValue / displayQuantity.scale;
		if (!Number.isFinite(baseValue) || !Number.isFinite(displayValue)) {
			issues.push(`${location}: non-finite unit conversion`);
			continue;
		}
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
			origin,
			request,
		});
		statements.set(request.id, text);
		result.facts.push({
			id: request.id,
			cell,
			text,
			quantity: sourceQuantity,
			display_quantity: displayQuantity,
			value: rawValue,
			factor: request.factor,
			scenario: request.scenario,
		});
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
			const conditionChange =
				calculation.operation === "change" &&
				left.cell.sheet_name === right.cell.sheet_name &&
				left.cell.cell_ref === right.cell.cell_ref &&
				left.cell.period === right.cell.period &&
				JSON.stringify([left.request.factor, left.request.scenario]) !==
					JSON.stringify([right.request.factor, right.request.scenario]);
			if (
				!sameDimension ||
				normalizeText(left.cell.row_label) !== normalizeText(right.cell.row_label) ||
				(!conditionChange && (!before || !after || before.grain !== after.grain || before.year >= after.year))
			) {
				issues.push(
					`${calculation.id}: change needs the same metric and units, with comparable ordered periods or different verified conditions of the same source cell`,
				);
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
			const comparison = conditionChange
				? `${markdownText(left.cell.period ?? "")}，${left.origin} → ${right.origin}`
				: `${markdownText(left.cell.period ?? "")} → ${markdownText(right.cell.period ?? "")}`;
			text = `${markdownText(left.cell.row_label ?? "指标")}（${comparison}）：${value > 0 ? "上升" : value < 0 ? "下降" : "不变"} ${formatNumber(scaled)} ${unit}`;
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
			text = `${markdownText(left.cell.row_label ?? "目标结果")}相对${markdownText(right.cell.row_label ?? "参考价格")}：${value >= 0 ? "上行" : "下行"} ${formatNumber(Math.abs(value) * 100)}%（按指定基准补充计算）`;
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
			text = `${markdownText(left.cell.row_label ?? "每股收益")}${left.cell.period ? `（${markdownText(left.cell.period)}）` : ""} ${formatNumber(left.base_value / left.quantity.scale)} ${left.quantity.label} × ${markdownText(right.cell.row_label ?? "倍数")} ${formatNumber(right.base_value)} 倍：${formatNumber(value / left.quantity.scale)} ${left.quantity.label}${left.request.factor !== undefined || right.request.factor !== undefined ? "（补充条件测算）" : ""}`;
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
	const overviewLines: string[] = [];
	const sensitivityLines: string[] = [];
	const appendix: string[] = [];
	if (options.sensitivityRunId) {
		try {
			const sensitivity = loadSensitivityRun(cwd, options.sensitivityRunId);
			const outputLocation = `${sensitivity.output.sheet_name}!${sensitivity.output.cell_ref}`;
			const selectedOutput = [...facts.values()].find(
				(fact) =>
					["target_price", "per_share_value", "enterprise_value", "equity_value"].includes(
						fact.request.role ?? "",
					) && `${fact.cell.sheet_name}!${fact.cell.cell_ref}` === outputLocation,
			);
			if (sensitivity.doc_id !== options.docId) issues.push("Sensitivity result belongs to a different workbook");
			else if (!selectedOutput) issues.push("Sensitivity output must match one selected valuation output fact");
			else if (!sensitivity.sensitivity_ranking_available) issues.push("Sensitivity run has no measured ranking");
			else {
				const citations = new Map<string, string>();
				for (const driver of sensitivity.ranked_drivers.filter((item) => item.active_driver).slice(0, 5)) {
					if (findWorkbookImplementationDetail(driver.label)) {
						issues.push(`Sensitivity driver requires a business label: ${driver.driver_id}`);
						continue;
					}
					const range = getPeExcelRange(cwd, {
						docId: options.docId,
						datasetId: options.datasetId,
						sheetName: driver.sheet_name,
						cellRange: driver.cell_ref,
					});
					const cell = (range.cells as ExcelCellDetail[])[0];
					const tolerance = Math.max(1e-9, Math.abs(driver.baseline_input) * 1e-9);
					if (
						!cell ||
						cell.is_formula ||
						cell.numeric_value === undefined ||
						Math.abs(cell.numeric_value - driver.baseline_input) > tolerance
					) {
						issues.push(
							`Sensitivity driver no longer matches source input: ${driver.sheet_name}!${driver.cell_ref}`,
						);
						continue;
					}
					citations.set(driver.driver_id, cell.markdown_citation);
				}
				if (!issues.length)
					sensitivityLines.push(...sensitivityLayout(sensitivity, citations, selectedOutput.quantity));
				result.sensitivity = {
					run_id: sensitivity.run_id,
					ranked_driver_count: sensitivity.ranked_drivers.length,
					result_json: sensitivity.artifacts.result_json,
				};
			}
		} catch (error) {
			issues.push(`Cannot validate sensitivity run: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
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
		overviewLines.push(...overview.lines);
		appendix.push(...overview.appendix);
		if (!overview.outputCount)
			issues.push("An overview requires agent-selected valuation outputs and their source context");
	}
	const usedStatements = new Set<string>();
	for (const [sectionIndex, section] of options.sections.entries()) {
		const { analysis, issues: sectionIssues } = validateReportSectionProse(section, sectionIndex, {
			preserveGaps: options.scope === "focused",
		});
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
			lines.push("| 指标 | 期间 | 数值与口径 |", "| --- | --- | ---: |");
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
		const renderedReport = compactReportCitations(
			[...lines, ...overviewLines, ...sensitivityLines, ...appendix].join("\n").trim(),
		);
		const visibleReport = renderedReport.replace(/\]\([^)]*\)/gu, "]");
		const implementationDetail = findWorkbookImplementationDetail(visibleReport);
		if (implementationDetail)
			issues.push(`Rendered report exposes workbook implementation detail: ${implementationDetail}`);
		else {
			result.status = "ready";
			result.rendered_report = renderedReport;
		}
	}
	return result;
}

export const peValuationReportTool = defineTool({
	name: "pe_valuation_report",
	label: "PE Valuation Report",
	promptSnippet: PE_VALUATION_REPORT_PROMPT_SNIPPET,
	description:
		"Build a human-readable valuation overview or focused quantitative answer from selected source values and original context cells. Source unit text determines currency, dimension and scale; expected_unit is an assertion, display_unit requests a compatible numeric conversion. For conditional EPS/multiple tables use fact.factor and product calculations; for upstream model scenarios use fact.scenario referencing saved propagation values. Preserve all requested cases and qualitative explanations in sections. If sensitivity_run_id is supplied, validate the saved run and render measured Top Drivers. An overview renders only selected valuation outputs and methods. Numbers and observed trends belong in facts/calculations; qualitative analysis references fact_ids. Once ready, return rendered_report verbatim.",
	parameters: Type.Object({
		doc_id: Type.String({ minLength: 1 }),
		dataset_id: Type.Optional(Type.String()),
		scope: Type.Union([Type.Literal("overview"), Type.Literal("focused")]),
		sensitivity_run_id: Type.Optional(
			Type.String({
				pattern: "^[0-9a-fA-F-]{36}$",
				description:
					"Run ID returned by pe_driver_sensitivity. The report validates the saved result against this workbook and selected output before rendering measured Top Drivers.",
			}),
		),
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
						"Assert the source unit, e.g. CNYm, EUR/share, shares_m, %. Must match the currency, dimension and scale parsed independently from original context.unit. Do not use the desired display unit here.",
				}),
				display_unit: Type.Optional(
					Type.String({ description: "Canonical compatible unit, e.g. EURm, EUR_100m, EUR/share, shares_m, %." }),
				),
				factor: Type.Optional(
					Type.Number({
						description:
							"User-requested supplemental multiplier of this original fact, e.g. 0.9/1/1.1 for an EPS or P/E condition table. Preserves source units and labels the value as a supplemental condition, never as an upstream model recalculation. For unit conversions use display_unit instead. Mutually exclusive with scenario.",
					}),
				),
				scenario: Type.Optional(
					Type.Object(
						{
							run_id: Type.String({ pattern: "^[0-9a-fA-F-]{36}$" }),
							driver_id: Type.String({ minLength: 1 }),
							direction: Type.Union([Type.Literal("down"), Type.Literal("up")]),
						},
						{
							description:
								"Read this exact source cell's propagated value from a saved pe_driver_sensitivity run. The run, source baseline and driver are verified; units are inherited from this cell's original context. Never submit a manually calculated scenario number.",
						},
					),
				),
			}),
			{ maxItems: 40 },
		),
		calculations: Type.Array(
			Type.Object({
				id: Type.String(),
				operation: Type.Union(
					[
						Type.Literal("growth"),
						Type.Literal("change"),
						Type.Literal("ratio"),
						Type.Literal("upside"),
						Type.Literal("product"),
					],
					{
						description:
							"growth compares ordered periods. change compares ordered periods, or different verified factor/scenario conditions of the exact same source cell; condition changes are not time-series growth.",
					},
				),
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
			sensitivityRunId: params.sensitivity_run_id,
		});
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
			isError: result.status === "blocked",
		};
	},
});
