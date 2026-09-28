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

export interface ReportOverviewOutput {
	label: string;
	sheet: string;
	period?: string;
	periodKind?: "historical" | "forecast" | "current";
	method?: string;
	value: string;
	formula?: string;
}

/** Render the agent's selected outputs; no additional workbook semantics are inferred here. */
export function valuationOverviewLayout(outputs: ReportOverviewOutput[]): {
	lines: string[];
	appendix: string[];
	outputCount: number;
} {
	const table = (items: ReportOverviewOutput[]): string[] => {
		if (!items.length) return [];
		const lines = ["| 估值方法／结果 | 期间 | 模型数值 |", "| --- | --- | ---: |"];
		for (const output of items)
			lines.push(
				`| ${reportText([output.method, output.label].filter(Boolean).join(" · "))} | ${reportText(output.period ?? "")} | ${output.value} |`,
			);
		lines.push("");
		return lines;
	};
	const historical = outputs.filter((output) => output.periodKind === "historical");
	const current = outputs.filter((output) => output.periodKind !== "historical");
	return {
		lines: ["## 估值结果", "", "以下为本次选择并核对的模型结果。", "", ...table(current)],
		appendix: historical.length ? ["## 历史期间对照", "", ...table(historical)] : [],
		outputCount: outputs.length,
	};
}
