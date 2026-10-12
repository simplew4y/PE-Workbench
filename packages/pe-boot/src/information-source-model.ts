import { createHash } from "node:crypto";
import { Type } from "typebox";
import { ResearchError } from "./research/model.ts";

export const INFORMATION_SOURCE_VERSION = "8";
export const INFORMATION_VIEW_VERSION = "7";
export const INFORMATION_SOURCE_ADAPTERS = [
	{ id: "wind-financials", name: "Wind 财务数据", provider: "wind" },
] as const;
export interface InformationSourceConfig {
	version: string;
	viewVersion: string;
	sourceIds: string[];
	companyName: string;
	companyTicker: string;
	maxQueries: number;
	maxTurns: number;
	defaultPeriods: string[];
	queryPolicy?: "judgment-definitions-v1";
}
export function informationSourceConfig(
	companyName: string,
	ticker: string,
	sourceIds: unknown,
): InformationSourceConfig {
	if (!Array.isArray(sourceIds) || sourceIds.length !== 1 || sourceIds[0] !== "wind-financials")
		throw new ResearchError(400, "请选择已支持的 Wind 财务信息源。");
	const companyTicker = ticker.trim().toUpperCase();
	const year = new Date().getUTCFullYear();
	if (!companyName.trim() || companyName.length > 200 || !/^[A-Z0-9.-]+\.[A-Z]{1,3}$/u.test(companyTicker))
		throw new ResearchError(409, "请补充明确的公司名称和完整 Wind 证券代码，不能根据项目名称猜测。");
	return {
		version: INFORMATION_SOURCE_VERSION,
		queryPolicy: "judgment-definitions-v1",
		viewVersion: INFORMATION_VIEW_VERSION,
		sourceIds: ["wind-financials"],
		companyName: companyName.trim(),
		companyTicker,
		maxQueries: 4,
		maxTurns: 8,
		defaultPeriods: [`${year - 3}年报`, `${year - 2}年报`, `${year - 1}年报`, "最新已披露中报或季报"],
	};
}
export function assertInformationSourceConfig(config: InformationSourceConfig): void {
	if (
		(!(
			config.version === INFORMATION_SOURCE_VERSION &&
			config.viewVersion === INFORMATION_VIEW_VERSION &&
			config.queryPolicy === "judgment-definitions-v1"
		) &&
			!(config.version === "7" && config.viewVersion === "6" && config.queryPolicy === undefined)) ||
		config.maxQueries !== 4 ||
		config.maxTurns !== 8 ||
		!Array.isArray(config.defaultPeriods) ||
		config.defaultPeriods.length !== 4 ||
		config.defaultPeriods[3] !== "最新已披露中报或季报" ||
		config.defaultPeriods
			.slice(0, 3)
			.some(
				(period, index) =>
					typeof period !== "string" ||
					!/^20\d{2}年报$/u.test(period) ||
					period !== `${Number(String(config.defaultPeriods[0]).slice(0, 4)) + index}年报`,
			)
	)
		throw new ResearchError(409, "信息源采集或证据视图版本已变化，请新建运行；旧产物保留。");
	informationSourceConfig(config.companyName, config.companyTicker, config.sourceIds);
}
export const InformationQuerySchema = Type.Object(
	{
		sourceId: Type.Literal("wind-financials"),
		metrics: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
			minItems: 1,
			maxItems: 12,
			description: "具体中文财务指标名，例如营业收入、营业利润、研发费用、授权及服务收入；不要猜测供应商字段代码。",
		}),
		periods: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
			minItems: 1,
			maxItems: 4,
			description:
				"首个查询由服务端固定最近三个年度及最新已披露中报/季报窗口，这里的期间仅作为规划记录；其后补查按此参数查询具体期间，不能把基线旧中报称为最新。",
		}),
		definitionChecks: Type.Optional(
			Type.Array(
				Type.Union([
					Type.Literal("period"),
					Type.Literal("currency"),
					Type.Literal("scope"),
					Type.Literal("role"),
					Type.Literal("definition"),
				]),
				{ maxItems: 5, description: "补查本查询字段缺少的定义；请求不等于核实，仅供应商明确返回的字段可作证据。" },
			),
		),
		purpose: Type.String({ minLength: 1, maxLength: 1000 }),
		judgmentIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 100 }),
		currency: Type.Optional(
			Type.Union(
				[
					Type.Literal("CNY"),
					Type.Literal("HKD"),
					Type.Literal("USD"),
					Type.Literal("GBP"),
					Type.Literal("EUR"),
					Type.Literal("JPY"),
				],
				{ description: "仅在基线或已返回数据明确币种后，用于请求同币种财务数值；返回币种仍以供应商数据为准。" },
			),
		),
	},
	{ additionalProperties: false },
);
export interface InformationQuery {
	sourceId: "wind-financials";
	metrics: string[];
	periods: string[];
	definitionChecks?: ("period" | "currency" | "scope" | "role" | "definition")[];
	purpose: string;
	judgmentIds: string[];
	currency?: "CNY" | "HKD" | "USD" | "GBP" | "EUR" | "JPY";
}
export interface InformationFact {
	line: number;
	metric: string;
	value: string | number | null;
	unit: string | null;
	period: string | null;
	periodKind: "single" | "cumulative" | "unknown";
	currency: string | null;
	role: "fact" | "forecast" | null;
	scope: string | null;
	definition?: string | null;
	companyTicker: string;
	paths: string[];
}
export interface InformationView {
	version: string;
	text: string;
	facts: InformationFact[];
	gaps: string[];
	usable: boolean;
}
export interface InformationSourceAttempt {
	id: string;
	number: number;
	startedAt: string;
	finishedAt: string | null;
	status: "running" | "saved" | "empty" | "failed" | "interrupted";
	error: string | null;
	rawPath?: string;
	rawChecksum?: string;
	viewDocId?: string;
	viewChecksum?: string;
	evidenceId?: string;
	metrics?: string[];
	gaps?: string[];
	elapsedMs?: number;
	executionStartedAt?: string;
}
export interface InformationSourceQueryRecord {
	id: string;
	runId: string;
	query: InformationQuery;
	actualQuery: string;
	actualPeriods?: string[];
	createdAt: string;
	attempts: InformationSourceAttempt[];
}
export interface InformationCollection {
	docIds: string[];
	warnings: string[];
	coverage: "complete" | "partial" | "empty";
	summary: string;
}
export function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function informationHash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
export function informationDisplayText(value: string): string {
	return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}
export function informationCurrencyCode(value: string | null | undefined): string | null {
	if (!value?.trim()) return null;
	const currency = value.trim().toUpperCase();
	const codes: Record<string, string> = {
		CNY: "CNY",
		RMB: "CNY",
		人民币: "CNY",
		GBP: "GBP",
		英镑: "GBP",
		USD: "USD",
		美元: "USD",
		HKD: "HKD",
		港元: "HKD",
		港币: "HKD",
		EUR: "EUR",
		欧元: "EUR",
		JPY: "JPY",
		日元: "JPY",
	};
	return codes[currency] ?? currency;
}

/** Only decode complete content blocks. Never reconstruct a JSON table from preview chunks. */
export function renderWindFinancials(response: unknown, companyTicker: string): InformationView {
	const lines = ["# Wind 财务证据", `视图版本：${INFORMATION_VIEW_VERSION}`];
	const facts: InformationFact[] = [];
	const gaps: string[] = [];
	let tables = 0;
	function visit(value: unknown, path: string, depth: number): void {
		if (depth > 8 || !object(value)) return;
		if (Array.isArray(value.columns) && Array.isArray(value.rows)) {
			tables++;
			const columns = value.columns.map((column) =>
				typeof column === "string" ? { name: column } : object(column) ? column : {},
			);
			const names = columns.map((column) => (typeof column.name === "string" ? column.name : ""));
			const codeIndex = names.findIndex((name) =>
				/^(Wind代码|证券代码|windcode|wind_code|ticker|code)$/iu.test(name.trim()),
			);
			if (codeIndex < 0 || names.some((name) => !name)) {
				gaps.push(`数据表 ${tables} 缺少可核对的证券代码或列名。`);
				return;
			}
			for (const [rowIndex, row] of value.rows.entries()) {
				if (!Array.isArray(row) || row.length !== columns.length) {
					gaps.push(`数据表 ${tables} 第 ${rowIndex + 1} 行与表头长度不一致，未猜测字段配对。`);
					continue;
				}
				if (String(row[codeIndex]).trim().toUpperCase() !== companyTicker) {
					gaps.push(`数据表 ${tables} 第 ${rowIndex + 1} 行证券代码不匹配，已排除。`);
					continue;
				}
				lines.push("", `数据表 ${tables} / 数据行 ${rowIndex + 1}`);
				const context = names.flatMap((name, index) =>
					typeof row[index] === "string" || /^(年份|年度|季度|年|year|quarter)$/iu.test(name)
						? [`${informationDisplayText(name)}：${informationDisplayText(String(row[index]))}`]
						: [],
				);
				lines.push(...context);
				for (const [columnIndex, column] of columns.entries()) {
					const cell: unknown = row[columnIndex];
					if (typeof cell !== "number" && cell !== null) continue;
					const metric = names[columnIndex];
					if (cell === null && (column.type === "string" || /名称|时间|日期|报告期|报表类型/u.test(metric)))
						continue;
					if (/^(年份|年度|季度|年|名次|排名|序号|year|quarter|rank|ranking)$/iu.test(metric)) continue;
					const metadataIndexes: number[] = [];
					function companion(suffixes: string[]): string | null {
						const index = names.findIndex((name) =>
							suffixes.some((suffix) => name === `${metric}${suffix}` || name === `${metric}.${suffix}`),
						);
						if (index < 0 || typeof row[index] !== "string" || !String(row[index]).trim()) return null;
						metadataIndexes.push(index);
						return String(row[index]);
					}
					const unit = typeof column.unit === "string" && column.unit.trim() ? column.unit : companion(["单位"]);
					const definition =
						[column.definition, column.description].find(
							(item): item is string => typeof item === "string" && !!item.trim(),
						) ?? companion(["指标定义", "定义"]);
					const periodBasis = companion(["期间类型", "统计口径", "单期或累计"]);
					const roleBasis = companion(["数据角色", "实际或预测", "数据类型"]);
					const fieldCurrency = companion(["币种", "财务币种", "记账本位币"]);
					const fieldScope = companion(["业务口径", "财务口径", "报表类型"]);
					const explicitPeriod = [column.period, column.report_period, column.date].find(
						(label): label is string => typeof label === "string" && !!label.trim(),
					);
					const metricPeriod =
						/20\d{2}年?\s*(?:到|至|-|~|～)\s*20\d{2}/u.test(metric) || /截至.*披露/iu.test(metric)
							? null
							: (/(?:20\d{2}年?(?:年报|年度|全年|中报|半年报|[一二三四]季报)|20\d{2}(?:H[12]|Q[1-4]|年)|(?:Q[1-4]|H[12])\s*FY\s*20\d{2}|FY\s*20\d{2})/iu.exec(
									metric,
								)?.[0] ?? null);
					const fieldPeriodIndex = names.findIndex((name) =>
						[`${metric}报告期`, `${metric}日期`, `${metric}时间`, `${metric}.时间`].includes(name),
					);
					const dateIndex =
						fieldPeriodIndex >= 0
							? fieldPeriodIndex
							: names.findIndex((name) => /^(日期|报告期|报告日期|date|report_period)$/iu.test(name));
					const yearIndex = names.findIndex((name) => /^(年份|年度|年|year)$/iu.test(name));
					const quarterIndex = names.findIndex((name) => /^(季度|quarter)$/iu.test(name));
					const rowPeriod =
						dateIndex >= 0 && typeof row[dateIndex] === "string"
							? String(row[dateIndex])
							: yearIndex >= 0 && typeof row[yearIndex] === "number"
								? `${names[yearIndex]}=${row[yearIndex]}${quarterIndex >= 0 && typeof row[quarterIndex] === "number" ? `，${names[quarterIndex]}=${row[quarterIndex]}` : ""}`
								: null;
					const period = explicitPeriod ?? (fieldPeriodIndex >= 0 ? rowPeriod : null) ?? metricPeriod ?? rowPeriod;
					const periodKind = /累计|全年|年报|中报|半年|cumulative|year.to.date/iu.test(periodBasis ?? "")
						? "cumulative"
						: /单期|单季|single/iu.test(periodBasis ?? "")
							? "single"
							: /^(single|cumulative)$/u.test(String(column.period_kind))
								? (column.period_kind as "single" | "cumulative")
								: /年报|年度|全年|中报|半年报|累计|H1/u.test(`${period ?? ""} ${metricPeriod ?? ""}`)
									? "cumulative"
									: /单季|single quarter/iu.test(period ?? "")
										? "single"
										: "unknown";
					const currencyIndex = names.findIndex((name) => /^(记账本位币|财务币种|币种|currency)$/iu.test(name));
					const currency =
						typeof column.currency === "string"
							? column.currency
							: (fieldCurrency ??
								/CNY|HKD|USD|GBP|EUR|JPY|人民币|RMB|港元|港币|美元|英镑|欧元|日元/iu.exec(unit ?? "")?.[0] ??
								(currencyIndex >= 0 && typeof row[currencyIndex] === "string"
									? String(row[currencyIndex])
									: null));
					const role = /预测|forecast|estimate|20\d{2}E\b/iu.test(
						`${metric} ${column.role ?? ""} ${roleBasis ?? ""}`,
					)
						? "forecast"
						: /实际|\bactual\b|\bfact\b/iu.test(`${metric} ${column.role ?? ""} ${roleBasis ?? ""}`)
							? "fact"
							: null;
					const valueText = cell === null ? "null（供应商未提供数值）" : String(cell);
					const businessPrefix = /^(.*)主营项目(?:收入|成本|毛利(?:率)?)/u.exec(metric)?.[1];
					const scopeIndex =
						businessPrefix !== undefined
							? names.indexOf(`${businessPrefix}主营项目名称`)
							: names.findIndex((name) =>
									/^(业务名称|分部名称|业务范围|segment_name|business_name|row_label)$/iu.test(name),
								);
					const reportTypeIndex = names.findIndex(
						(name) => name === `${metric}.报表类型` || name === `${metric}报表类型`,
					);
					const rowScope =
						[scopeIndex, reportTypeIndex]
							.flatMap((index) =>
								index >= 0 && typeof row[index] === "string" && String(row[index]).trim()
									? [String(row[index])]
									: [],
							)
							.join(" / ") || null;
					const scope =
						[column.scope, column.business, column.parent, column.parent_label, value.scope, value.business].find(
							(label): label is string => typeof label === "string" && !!label.trim(),
						) ??
						fieldScope ??
						rowScope;
					lines.push(
						`证券代码：${companyTicker}；指标：${informationDisplayText(metric)}；值：${valueText}；单位：${informationDisplayText(unit ?? "未提供")}；报告期：${informationDisplayText(period ?? "该字段未明确，不套用最新报告期")}；期间分类：${periodKind}；币种：${informationDisplayText(currency ?? "未明确")}；数据角色：${role ?? "未明确"}；业务口径：${informationDisplayText(scope ?? "该字段未提供")}${definition ? `；指标定义：${informationDisplayText(definition)}` : ""}`,
					);
					facts.push({
						line: lines.length,
						metric,
						value: cell as number | null,
						unit,
						period,
						periodKind,
						currency,
						role,
						scope,
						definition,
						companyTicker,
						paths: [
							...metadataIndexes.flatMap((index) => [
								`${path}.rows[${rowIndex}][${index}]`,
								`${path}.columns[${index}]`,
							]),
							`${path}.columns[${columnIndex}]`,
							`${path}.rows[${rowIndex}][${columnIndex}]`,
							`${path}.rows[${rowIndex}][${codeIndex}]`,
							...(period === rowPeriod && dateIndex >= 0
								? [`${path}.rows[${rowIndex}][${dateIndex}]`, `${path}.columns[${dateIndex}]`]
								: []),
							...(period === rowPeriod && dateIndex < 0 && yearIndex >= 0
								? [
										`${path}.rows[${rowIndex}][${yearIndex}]`,
										`${path}.columns[${yearIndex}]`,
										...(quarterIndex >= 0
											? [`${path}.rows[${rowIndex}][${quarterIndex}]`, `${path}.columns[${quarterIndex}]`]
											: []),
									]
								: []),
							...(scopeIndex >= 0
								? [`${path}.rows[${rowIndex}][${scopeIndex}]`, `${path}.columns[${scopeIndex}]`]
								: []),
							...(reportTypeIndex >= 0
								? [`${path}.rows[${rowIndex}][${reportTypeIndex}]`, `${path}.columns[${reportTypeIndex}]`]
								: []),
							...(currencyIndex >= 0
								? [`${path}.rows[${rowIndex}][${currencyIndex}]`, `${path}.columns[${currencyIndex}]`]
								: []),
						],
					});
					if (cell === null) gaps.push(`${metric} 未提供数值。`);
					if (!unit) gaps.push(`${metric} 未提供单位。`);
					if (!scope) gaps.push(`${metric} 未明确合并、分部或调整后财务口径，不能据此确认与原预测可比。`);
					if (
						/收入|利润|费用|现金|资产|负债|市值|金额|毛利|EBIT|revenue|profit|cost/iu.test(metric) &&
						!/%|百分|率/u.test(unit ?? metric) &&
						!currency
					)
						gaps.push(`${metric} 未明确记账币种，金额换算和跨币种比较需要核查。`);
					if (!period) gaps.push(`${metric} 没有独立的明确报告期，不将行内“最新报告期”套用于该指标。`);
					if (period && periodKind === "unknown")
						gaps.push(`${metric} 的报告期为${period}，未明确单期或累计分类，不自动年化或作为可比偏差。`);
					if (!role) gaps.push(`${metric} 未显式标注实际或预测角色，需核对供应商定义或原公告。`);
				}
			}
			return;
		}
		for (const [key, child] of Object.entries(value)) {
			if (Array.isArray(child))
				for (const [index, entry] of child.entries()) visit(entry, `${path}.${key}[${index}]`, depth + 1);
			else if (object(child)) visit(child, `${path}.${key}`, depth + 1);
		}
	}
	if (object(response) && Array.isArray(response.content))
		for (const [index, block] of response.content.entries()) {
			if (!object(block) || typeof block.text !== "string") continue;
			try {
				visit(JSON.parse(block.text), `response.content[${index}].text::$`, 0);
			} catch {
				gaps.push(`响应块 ${index + 1} 不是已识别的结构化财务表格，原文保留在响应归档。`);
			}
		}
	if (!tables) gaps.push("供应商未返回已识别的财务表格，不能从自由文本猜测字段关系。");
	return {
		version: INFORMATION_VIEW_VERSION,
		text: `${lines.join("\n")}\n`,
		facts,
		gaps: [...new Set(gaps)],
		usable: facts.some((fact) => typeof fact.value === "number"),
	};
}
