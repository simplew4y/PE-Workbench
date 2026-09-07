import { normalizeText, openPeDataset } from "./database.ts";
import { type ExcelCellDetail, readExcelCellsByBounds } from "./excel-cells.ts";
import type { PeValuationOutputResult, ValuationOutputCandidate } from "./valuation-output.ts";

type Method = "pe" | "ev_ebit" | "ev_ebitda" | "dcf" | "sotp" | "weighted" | "multiples" | "unspecified";

interface OutputView {
	output: ValuationOutputCandidate;
	row: number;
	column: number;
	columnName: string;
	period?: string;
	unit?: string;
	method: Method;
	header?: ExcelCellDetail;
}

const METHOD_NAMES: Record<Method, string> = {
	pe: "市盈率法（P/E）",
	ev_ebit: "企业价值／息税前利润法（EV/EBIT）",
	ev_ebitda: "企业价值／息税折旧摊销前利润法（EV/EBITDA）",
	dcf: "现金流折现法（DCF）",
	sotp: "分部估值法（SOTP）",
	weighted: "综合目标价",
	multiples: "可比倍数法",
	unspecified: "方法未确认",
};

export function reportText(value: string): string {
	return value.replace(/[\\`*_[\]<>|#]/gu, "\\$&").replace(/\r?\n/gu, " ");
}

/** Keep the version-bound source URL intact, including in clients without citation badges. */
export function compactReportCitations(text: string): string {
	return text.replace(/\[(?:\\.|[^\]\\])*\]\((#pe-source\?[^\s)]+)\)/gu, "[来源]($1)");
}

export function reportMetricLabel(label: string): string {
	const labels: Record<string, string> = {
		"weighted target price": "综合目标价",
		"fair value per share": "每股合理价值",
		"target price": "目标价",
		"target multiple": "目标估值倍数",
		"number of shares": "股数",
	};
	return labels[label.trim().toLowerCase()] ?? label;
}

function explicitMethod(text: string): Method | undefined {
	const label = text.toLowerCase().replace(/\s/gu, "");
	if (/^(?:p\/?e|市盈率)(?:法|approach|valuation|估值法?)?$/u.test(label)) return "pe";
	if (/^ev\/?ebitda(?:approach|valuation|法|估值法?)?$/u.test(label)) return "ev_ebitda";
	if (/^ev\/?ebit(?:approach|valuation|法|估值法?)?$/u.test(label)) return "ev_ebit";
	if (/^(?:dcf|discountedcashflow|现金流折现)(?:法|approach|valuation|估值法?)?$/u.test(label)) return "dcf";
	if (/^(?:sotp|sumof(?:the)?parts|分部估值)(?:法|approach|valuation)?$/u.test(label)) return "sotp";
	return undefined;
}

function validValue(output: ValuationOutputCandidate): output is ValuationOutputCandidate & { numeric_value: number } {
	return (
		output.numeric_value !== undefined &&
		Number.isFinite(output.numeric_value) &&
		(!output.formula || output.formula_cache_status === "present")
	);
}

function formatValue(output: ValuationOutputCandidate): string {
	return validValue(output)
		? new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
				output.numeric_value,
			)
		: "缓存不可用";
}

function unitLabel(unit: string | undefined): string {
	if (unit === "per_share") return "每股金额，币种未确认";
	if (unit?.endsWith("/share")) return `${unit.slice(0, -6)}/股`;
	return unit ?? "单位未确认";
}

/** Recognize only explicit, same-sheet averaging formulas; numeric coincidence cannot prove weights. */
function equalWeightInputs(view: OutputView, views: OutputView[]): OutputView[] | undefined {
	const formula = view.output.formula?.replace(/[$\s]/gu, "").toUpperCase() ?? "";
	const match = /^=\+?ROUND\(\(([A-Z]+\d+)\+([A-Z]+\d+)\)\/2,(-?\d+)\)$/u.exec(formula);
	if (!match || !validValue(view.output) || !view.period || !view.unit) return undefined;
	const inputs = match
		.slice(1, 3)
		.map((ref) =>
			views.find((input) => input.output.sheet_name === view.output.sheet_name && input.output.cell_ref === ref),
		);
	if (
		inputs.some(
			(input) => !input || input.period !== view.period || input.unit !== view.unit || !validValue(input.output),
		)
	)
		return undefined;
	const checked = inputs.filter((input): input is OutputView => input !== undefined);
	if (checked[0].output.candidate_id === checked[1].output.candidate_id) return undefined;
	// The printed arithmetic must also reconcile at the report's two-decimal precision.
	if (
		checked.some(
			(input) => Math.abs(Number(input.output.numeric_value?.toFixed(2)) - (input.output.numeric_value ?? 0)) > 1e-9,
		)
	)
		return undefined;
	const average = ((checked[0].output.numeric_value ?? 0) + (checked[1].output.numeric_value ?? 0)) / 2;
	const precision = 10 ** Number(match[3]);
	const rounded = (Math.sign(average) * Math.round(Math.abs(average) * precision)) / precision;
	return Math.abs(rounded - view.output.numeric_value) <= Math.max(1, Math.abs(rounded)) * 1e-9 ? checked : undefined;
}

function outputTable(views: OutputView[]): string[] {
	const lines: string[] = [];
	const buckets = new Map<string, OutputView[]>();
	for (const view of views) {
		const key = JSON.stringify([view.output.sheet_name, view.unit]);
		const bucket = buckets.get(key) ?? [];
		bucket.push(view);
		buckets.set(key, bucket);
	}
	for (const bucket of buckets.values()) {
		lines.push(`**${reportText(bucket[0].output.sheet_name)}** · ${reportText(unitLabel(bucket[0].unit))}`, "");
		// Source columns distinguish repeated years/scenarios and missing periods instead of silently merging them.
		const columns = [...new Set(bucket.map((view) => view.column))].sort((a, b) => a - b);
		const rows = [...new Set(bucket.map((view) => view.row))].sort((a, b) => {
			const left = bucket.find((view) => view.row === a);
			const right = bucket.find((view) => view.row === b);
			return Number(right?.method === "weighted") - Number(left?.method === "weighted") || a - b;
		});
		for (let offset = 0; offset < columns.length; offset += 5) {
			const page = columns.slice(offset, offset + 5);
			const labels = page.map((column) => {
				const periods = [...new Set(bucket.filter((view) => view.column === column).map((view) => view.period))];
				return periods.length === 1 && periods[0] ? reportText(periods[0]) : undefined;
			});
			lines.push(
				`| 估值方法／结果 | ${page
					.map((column, index) => {
						const columnName = bucket.find((view) => view.column === column)?.columnName;
						const label = labels[index];
						return label
							? `${label}${labels.filter((other) => other === label).length > 1 ? `（${columnName}列）` : ""}`
							: `期间待核对（${columnName}列）`;
					})
					.join(" | ")} |`,
				`| --- | ${page.map(() => "---:").join(" | ")} |`,
			);
			for (const row of rows) {
				const rowViews = bucket.filter((view) => view.row === row && page.includes(view.column));
				if (!rowViews.length) continue;
				const first = rowViews[0];
				const method = METHOD_NAMES[first.method];
				const name = first.method === "weighted" ? method : `${method} · ${reportMetricLabel(first.output.label)}`;
				const citation = first.header?.markdown_citation;
				const values = page.map((column, index) => {
					const view = rowViews.find((item) => item.column === column);
					if (!view) return "—";
					const period = !labels[index] && view.period ? `${reportText(view.period)}：` : "";
					return `${period}${formatValue(view.output)}${view.output.score < 0.62 ? "（待核对）" : ""} ${view.output.markdown_citations[0] ?? ""}`;
				});
				lines.push(`| ${reportText(name)}${citation ? ` ${citation}` : ""} | ${values.join(" | ")} |`);
			}
			lines.push("");
		}
	}
	return lines;
}

export function valuationOverviewLayout(
	cwd: string,
	inventory: PeValuationOutputResult,
): { lines: string[]; appendix: string[]; outputCount: number } {
	const views: OutputView[] = [];
	const { database, datasetId } = openPeDataset(cwd, inventory.dataset_id);
	try {
		const contexts = new Map<string, ExcelCellDetail[]>();
		for (const group of inventory.output_groups) {
			for (const output of group.outputs) {
				if (!["target_price", "per_share_value", "dcf_value", "sotp_value"].includes(output.semantic_role))
					continue;
				const match = /^([A-Z]+)(\d+)$/u.exec(output.cell_ref);
				if (!match) continue;
				const row = Number(match[2]);
				const column = [...match[1]].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
				const contextKey = JSON.stringify([output.sheet_name, row]);
				let context = contexts.get(contextKey);
				if (!context) {
					context = readExcelCellsByBounds(
						database,
						datasetId,
						inventory.document.doc_id,
						output.sheet_name,
						{
							rowStart: Math.max(1, row - 59),
							rowEnd: row,
							columnStart: 1,
							columnEnd: 8,
						},
						480,
					);
					contexts.set(contextKey, context);
				}
				const source = readExcelCellsByBounds(
					database,
					datasetId,
					inventory.document.doc_id,
					output.sheet_name,
					{
						rowStart: row,
						rowEnd: row,
						columnStart: column,
						columnEnd: column,
					},
					1,
				)[0];
				const rowLabel = context
					.filter(
						(cell) =>
							cell.row_index === row &&
							cell.col_index < column &&
							!cell.is_formula &&
							cell.numeric_value === undefined &&
							normalizeText(cell.display_value) === normalizeText(output.label),
					)
					.sort((a, b) => b.col_index - a.col_index)[0];
				const header = context
					.filter(
						(cell) =>
							cell.row_index < row &&
							cell.col_index === rowLabel?.col_index &&
							cell.numeric_value === undefined &&
							!cell.is_formula &&
							explicitMethod(cell.display_value ?? ""),
					)
					.sort((a, b) => b.row_index - a.row_index || b.col_index - a.col_index)[0];
				const weighted = /weighted.*target\s*price|加权.*目标价|综合目标价/iu.test(output.label);
				views.push({
					output,
					row,
					column,
					columnName: match[1],
					header: weighted ? undefined : header,
					period: source?.period_context?.status === "ambiguous" ? undefined : (source?.period ?? output.period),
					unit: source?.unit_context?.status === "ambiguous" ? undefined : (source?.unit ?? output.unit),
					method: weighted
						? "weighted"
						: (explicitMethod(output.label) ?? explicitMethod(header?.display_value ?? "") ?? group.method),
				});
			}
		}
	} finally {
		database.close();
	}
	const firstForecast = new Map<string, number>();
	for (const view of views) {
		const forecast = /^(?:FY\s*)?((?:19|20)\d{2})[EF]$/iu.exec(view.period ?? "");
		if (forecast)
			firstForecast.set(
				view.output.sheet_name,
				Math.min(firstForecast.get(view.output.sheet_name) ?? Infinity, Number(forecast[1])),
			);
	}
	const historical = views.filter((view) => {
		const period = /^(?:FY\s*)?((?:19|20)\d{2})A?$/iu.exec(view.period ?? "");
		const forecast = firstForecast.get(view.output.sheet_name);
		return period && forecast !== undefined && Number(period[1]) < forecast;
	});
	const main = views.filter((view) => !historical.includes(view));
	const lines = ["## 估值结果", ""];
	if (views.some((view) => view.method === "weighted")) {
		lines.push(
			"模型列出了各方法的每股估值，以及合并这些结果的综合目标价。先按同一预测年度比较，再看各方法如何形成综合结果。",
			"",
		);
	} else {
		lines.push("以下按工作表、估值方法和期间整理模型结果；不同期间或方法的数值分别保留。", "");
	}
	lines.push(...outputTable(main));
	if (firstForecast.size) lines.push("E/F 表示预测年度，属于盈利或现金流的预测口径。", "");
	if (inventory.status !== "selected") lines.push("当前尚未确认应采用哪一年度、哪一项结果作为主目标价。", "");
	const methods = new Set(views.map((view) => view.method));
	const explanations: string[] = [];
	if (methods.has("pe"))
		explanations.push("市盈率法（P/E）：用利润乘目标市盈率估算股权价值，再除以股数，得到每股价值。");
	if (methods.has("ev_ebit"))
		explanations.push(
			"EV/EBIT 法：用息税前利润乘估值倍数得到企业价值，再结合模型中的现金、债务及其他调整换算为股权价值和每股价值。",
		);
	if (methods.has("ev_ebitda"))
		explanations.push("EV/EBITDA 法：使用扣除利息、税项、折旧及摊销前的利润估算企业价值，再换算为每股价值。");
	if (methods.has("dcf"))
		explanations.push("现金流折现法（DCF）：将未来现金流折算到估值时点；每股结果还取决于股权价值调整和股数口径。");
	if (methods.has("weighted")) {
		explanations.push(
			"综合目标价（Weighted target price）是各估值结果按权重合成的每股价格；Fair value per share 指相应方法的每股合理价值。",
		);
		const weighted = main.find((view) => view.method === "weighted" && equalWeightInputs(view, views));
		const inputs = weighted ? equalWeightInputs(weighted, views) : undefined;
		if (weighted && inputs)
			explanations.push(
				`例如 ${reportText(weighted.period ?? "")}：(${formatValue(inputs[0].output)} + ${formatValue(inputs[1].output)}) ÷ 2 = ${formatValue(weighted.output)}，公式中两项各占 50%（按原表取整）。${[...inputs, weighted].map((view) => view.output.markdown_citations[0]).join(" ")}`,
			);
		else explanations.push("权重需以各期源公式或明确的模型说明为准，不能仅凭结果数值推定。");
	}
	if (explanations.length) lines.push("### 如何理解这些结果", "", ...explanations.flatMap((text) => [text, ""]));
	for (const group of inventory.output_groups) {
		if (group.relationships.some((relationship) => relationship.kind === "rounding_consistent"))
			lines.push(`${reportText(group.sheet_name)} 中存在取整一致的结果，表中保留原始值与取整值。`, "");
	}
	return {
		lines,
		appendix: historical.length
			? ["## 历史期间对照", "", "以下为历史年度列下的模型估值结果。", "", ...outputTable(historical)]
			: [],
		outputCount: views.length,
	};
}
