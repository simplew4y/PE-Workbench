export interface ReportSectionIssue {
	section_index: number;
	title: string;
	field: "title" | "analysis";
	code: "numeric_claim" | "financial_trend" | "citation" | "implementation_detail";
	excerpt: string;
	repair: string;
}

const NUMERIC_CLAIM =
	/\p{N}|(?:百分之|千分之|万分之)|[〇零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟点]+\s*(?:年|季度|欧元|美元|人民币|亿|万|股|倍|%|％|个百分点)/u;
const CITATION = /#pe-source|source:|https?:\/\/|\[[^\]]*\]\(/iu;
const FINANCIAL_TREND =
	/(?:毛利率|利润率|税率|营收|收入|每股收益|股数|利润|盈利|目标价|价格|股价|\b(?:revenue|sales|margin|tax rate|earnings|EPS|profit|share count|price)\b)[^，,。！？.!?；;\n]{0,24}?(?:扩张|收缩|提升|提高|增加|上升|下降|降低|减少|回落|稳定|增长|下滑|持平|\b(?:increas\w*|decreas\w*|rise\w*|rising|fall\w*|grow\w*|declin\w*|stable|expand\w*|contract\w*)\b)/giu;
const QUALIFIED_CELL_REFERENCE = /(?:'[^']+'|[^\s，。！？；;()[\]{}]+)!\$?[A-Z]{1,3}\$?[1-9]\d*/iu;
const BARE_CELL_REFERENCE = /(?<![A-Za-z0-9_])\$?([A-Z]{1,3})\$?([1-9]\d*)(?![A-Za-z0-9_])/giu;
const EXCEL_FORMULA =
	/(?:^|[\s：:（(])=[^\s，。！？；;]{2,}|\b(?:ROUND|ROUNDUP|ROUNDDOWN|SUM|AVERAGE|IF|IFS|VLOOKUP|HLOOKUP|XLOOKUP|INDEX|MATCH|OFFSET|INDIRECT|NPV|XNPV|IRR|XIRR)\s*\([^\n。！？；;]*\)/iu;
const INTERNAL_RUNTIME_TERM =
	/\b(?:run[_ -]?output|tool[_ -]?(?:output|result)|driver_id|cell_ref|sheet_name)\b|(?:run|工具)(?:\s*|的)?(?:输出|结果)|(?:公式|单元格)?传播路径/iu;

/** Technical workbook locations remain in evidence metadata, never reader-facing prose. */
export function findWorkbookImplementationDetail(value: string): string | undefined {
	for (const pattern of [EXCEL_FORMULA, INTERNAL_RUNTIME_TERM, QUALIFIED_CELL_REFERENCE]) {
		const match = pattern.exec(value);
		if (match) return match[0].trim();
	}
	for (const match of value.matchAll(BARE_CELL_REFERENCE)) {
		const token = `${match[1]}${match[2]}`.toUpperCase();
		if (/^(?:Q[1-4]|H[1-2])$/u.test(token)) continue;
		return match[0];
	}
	return undefined;
}

/** Hypotheses are still analyst inference; this only avoids treating them as observed trends. */
function isConditionalTrend(clause: string, match: RegExpMatchArray): boolean {
	const before = clause.slice(0, (match.index ?? 0) + match[0].length);
	const after = clause.slice((match.index ?? 0) + match[0].length);
	if (
		/(?:已经|实际|同比|环比|去年|今年|本期|报告期|历史|\b(?:actually|historically|already|last year)\b)/iu.test(
			before,
		)
	)
		return false;
	return (
		/^(?:若|如果|假如|假设|倘若|一旦|在.+(?:条件|情景|假设)下|if\b|assuming\b|under\b|in (?:a|the) .+scenario\b)/iu.test(
			clause.trim(),
		) ||
		/(?:可能|或将|或会|\b(?:may|might|could)\b)[^，,。！？.!?；;\n]*$/iu.test(before) ||
		/^(?:(?:的)?风险|(?:无法兑现|不及预期|低于预期)的风险|可能(?:影响|导致|使|压低|拖累))/u.test(after)
	);
}

export function validateReportSectionProse(
	section: { title: string; analysis?: string },
	sectionIndex: number,
	options: { preserveGaps?: boolean } = {},
): { analysis: string; issues: ReportSectionIssue[] } {
	const issues: ReportSectionIssue[] = [];
	// Keep decimal points and URLs together. Validate only sentences that will be rendered.
	const sentences = (section.analysis ?? "")
		.split(/(?<=[。！？；\n])\s*|(?<=[.!?;])(?=\s|$)\s*/u)
		.filter(
			(sentence) =>
				options.preserveGaps ||
				!/未确认|未核实|未确定|尚未确定|待核|无法确认|无法确定|无法验证|未提供|未找到|未定位|未明确|不明确|未知|缺失|不详|未刷新|未重算/u.test(
					sentence,
				),
		);
	for (const field of ["title", "analysis"] as const) {
		for (const sentence of field === "title" ? [section.title] : sentences) {
			let code: ReportSectionIssue["code"] | undefined;
			if (CITATION.test(sentence)) code = "citation";
			else if (findWorkbookImplementationDetail(sentence)) code = "implementation_detail";
			else if (NUMERIC_CLAIM.test(sentence)) code = "numeric_claim";
			else {
				for (const clause of sentence.split(/[，,。！？.!?；;\n]/u)) {
					if (
						[...clause.matchAll(FINANCIAL_TREND)].some(
							(match) => field === "title" || !isConditionalTrend(clause, match),
						)
					) {
						code = "financial_trend";
						break;
					}
				}
			}
			if (!code) continue;
			issues.push({
				section_index: sectionIndex,
				title: section.title,
				field,
				code,
				excerpt: sentence.trim().slice(0, 200),
				repair:
					code === "implementation_detail"
						? "用业务名称和白话机制重写；单元格坐标、Excel公式、传播路径及工具运行术语只保留在来源证据或审计附件。"
						: field === "title"
							? "改用中性标题，将数值、趋势和引用放入 facts/calculations，并在 fact_ids 中关联。"
							: code === "citation"
								? "移除 analysis 中手写的引用，通过 fact_ids 关联来源，由工具生成引用。"
								: "将数值或已发生的财务趋势放入 facts/calculations，并在 fact_ids 中关联；analysis 保留有依据的定性解释，不把未核验的事实改写成假设。",
			});
		}
	}
	return { analysis: sentences.join(" ").trim(), issues };
}
