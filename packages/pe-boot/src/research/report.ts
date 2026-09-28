import { isFrameworkDocument } from "./content-access.ts";
import type { StoredFrameworkContent } from "./model.ts";

export { getFrameworkCoverageGaps, getFrameworkItems, isFrameworkDocument } from "./content-access.ts";
export type { FrameworkContent, FrameworkItem, LegacyFrameworkContent, StoredFrameworkContent } from "./model.ts";

export const FRAMEWORK_SECTION_TITLES = {
	researchSetup: "一、研究设定",
	currentAssessment: "二、当前判断",
	businessModel: "三、公司如何创造价值",
	investmentJudgments: "四、投资判断与其他解释",
	valuation: "五、市场预期、估值与回报",
	monitoring: "六、什么情况下我们错了",
	evidenceAndChanges: "七、证据、未知问题与版本变化",
} as const;

function prose(value: string): string {
	return value
		.replace(/[\\`*_{}[\]()#+\-.!|~$]/g, "\\$&")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replace(/\r\n?|\n/g, "<br>");
}
type TableCell = string | number | null | { markdown: string };
function cell(value: TableCell): string {
	return value !== null && typeof value === "object" ? value.markdown : prose(String(value ?? "待补充"));
}
function table(headers: string[], rows: TableCell[][], empty: string): string {
	if (rows.length === 0) return empty;
	return [
		`| ${headers.map(cell).join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
	].join("\n");
}
function references(ids: string[]): string {
	return ids.map((id, index) => `[依据 ${index + 1}](#pe-source?evidence_id=${encodeURIComponent(id)})`).join(" ");
}
function citationCell(ids: string[], empty = ""): TableCell {
	return ids.length ? { markdown: references(ids) } : empty;
}
function bullets(values: string[], empty: string): string {
	return values.length ? values.map((value) => `- ${prose(value)}`).join("\n") : empty;
}
function diagramLabel(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "#quot;")
		.replaceAll(String.fromCharCode(96), "")
		.replace(/[\r\n]/g, " ")
		.slice(0, 120);
}
function driverDiagram(drivers: Array<{ from: string; to: string }>): string {
	if (!drivers.length) return "业务驱动关系尚待证据支持。";
	const nodes = new Map<string, string>();
	for (const driver of drivers) {
		for (const label of [driver.from, driver.to]) {
			if (!nodes.has(label)) nodes.set(label, `D${nodes.size}`);
		}
	}
	return [
		"~~~mermaid",
		"flowchart LR",
		...[...nodes].map(([label, id]) => `  ${id}["${diagramLabel(label)}"]`),
		...drivers.map((driver) => `  ${nodes.get(driver.from)} --> ${nodes.get(driver.to)}`),
		"~~~",
	].join("\n");
}
const kindNames = {
	thesis: "投资判断",
	hypothesis: "待验证假设",
	metric: "跟踪指标",
	event: "经营事件",
	question: "待答问题",
};
const confidenceNames = { high: "高", medium: "中", low: "低", undetermined: "待判断" };

export function renderInvestmentFrameworkMarkdown(content: StoredFrameworkContent): string {
	if (!isFrameworkDocument(content)) {
		return `${[
			`# 📝 ${prose(content.title)}`,
			"> 旧版条目框架（只读）。此版本未包含完整七节文档；请重新生成七节草稿后确认。",
			`## 📝 研究目标\n\n${prose(content.objective)}`,
			`## 📝 研究期限\n\n${prose(content.horizon)}`,
			...content.items.map(
				(item) =>
					"## 📝 " +
					prose(item.id) +
					" · " +
					prose(item.subject) +
					"\n\n" +
					prose(item.claim) +
					"\n\n" +
					prose(item.rationale) +
					"\n\n" +
					(item.origin === "user" ? "用户假设，待验证。\n\n" : "") +
					"验证：" +
					prose(item.verification) +
					"\n\n失效：" +
					prose(item.invalidation) +
					"\n\n" +
					references(item.evidenceIds),
			),
			`## 📝 资料缺口\n\n${bullets(content.coverageGaps, "旧版本未记录资料缺口。")}`,
		].join("\n\n")}\n`;
	}
	const {
		researchSetup: setup,
		currentAssessment: assessment,
		businessModel: business,
		investmentJudgments: judgments,
		valuation,
		monitoring,
		evidenceAndChanges: evidence,
	} = content.sections;
	const headings = FRAMEWORK_SECTION_TITLES;
	const parts = [
		`# 📝 ${prose(content.title)}`,
		`## 📝 ${headings.researchSetup}`,
		table(
			["字段", "内容"],
			[
				["研究目标", setup.objective],
				["投资期限", setup.horizon],
				["分析师偏好", setup.preferences ?? "未提供"],
				["信息截止日期", setup.informationCutoff ?? "尚未确认"],
			],
			"",
		),
		`## 📝 ${headings.currentAssessment}`,
		`${prose(assessment.summary)}\n\n${references(assessment.evidenceIds)}`,
		table(
			["状态项", "当前判断"],
			[
				["研究状态", assessment.status],
				["主要收益来源", assessment.returnDrivers.join("；") || "还不能判断"],
				["最大不确定性", assessment.keyUncertainties.join("；") || "未记录，仍需核查"],
				["相比上一版", assessment.changesSinceLastVersion],
			],
			"",
		),
		`## 📝 ${headings.businessModel}`,
		`${prose(business.summary)}\n\n${references(business.evidenceIds)}`,
		"### 📝 业务驱动关系",
		driverDiagram(business.drivers),
		table(
			["驱动因素", "影响结果", "传导机制", "证据"],
			business.drivers.map((driver) => [driver.from, driver.to, driver.mechanism, citationCell(driver.evidenceIds)]),
			"尚无可核实的驱动路径。",
		),
		"### 📝 关键经营指标",
		table(
			["KPI", "期间", "数值与口径", "对利润或现金流的影响", "证据"],
			business.kpis.map((kpi) => [kpi.name, kpi.period, kpi.value, kpi.impact, citationCell(kpi.evidenceIds)]),
			"关键经营指标尚待补充，不能据此判定经营兑现。",
		),
		`## 📝 ${headings.investmentJudgments}`,
		...(judgments.items.length ? [] : ["现有证据不足以形成投资判断；待核实问题和资料缺口见第七节。"]),
		...judgments.items.map((item) =>
			[
				`### 📝 ${prose(item.id)} · ${prose(item.subject)}`,
				table(
					["判断项", "内容"],
					[
						["类型", kindNames[item.kind]],
						["当前判断", item.claim],
						["判断依据", item.rationale],
						[
							"支持证据",
							citationCell(item.evidenceIds, item.origin === "user" ? "用户提出的假设，待验证" : "尚待补充"),
						],
						["反面证据", citationCell(item.counterEvidenceIds, "尚未记录反面证据，不表示已排除反证")],
						["置信度", `${confidenceNames[item.confidence.level]}：${item.confidence.reason}`],
						["替代解释", item.alternativeExplanations.join("；") || "尚未充分检验其他解释"],
						["验证条件", item.verification],
						["失效条件", item.invalidation],
					],
					"",
				),
			].join("\n\n"),
		),
		`## 📝 ${headings.valuation}`,
		`${prose(valuation.summary)}\n\n${references(valuation.evidenceIds)}`,
		`市场预期：${prose(valuation.marketExpectations)}`,
		"### 📝 预测对比",
		table(
			["指标", "期间", "市场预期", "我们的预测", "差异", "证据"],
			valuation.forecastComparisons.map((row) => [
				row.metric,
				row.period,
				row.marketExpectation,
				row.ownForecast,
				row.difference,
				citationCell(row.evidenceIds),
			]),
			"缺少可比较的市场预期或独立预测，暂不能判断预期差。",
		),
		"### 📝 情景估值",
		table(
			["情景", "经营假设", "估值", "单位", "估值时点", "预期回报", "计算依据", "关联判断", "证据"],
			valuation.scenarios.map((scenario) => [
				scenario.name,
				scenario.assumptions,
				scenario.value,
				scenario.unit,
				scenario.asOf,
				scenario.expectedReturn,
				scenario.calculation,
				scenario.judgmentIds.join("、"),
				citationCell(scenario.evidenceIds),
			]),
			"情景估值尚未建立，不能据此给出价格区间。",
		),
	];
	const priced = valuation.scenarios.filter((scenario) => scenario.value !== null);
	parts.push("### 📝 估值区间图");
	if (
		priced.length >= 2 &&
		priced[0].asOf !== null &&
		priced.every((scenario) => scenario.unit === priced[0].unit && scenario.asOf === priced[0].asOf)
	) {
		const upper = Math.max(1, Math.ceil(Math.max(...priced.map((scenario) => scenario.value ?? 0)) * 1.1));
		parts.push(
			[
				"~~~mermaid",
				"xychart-beta",
				`  title "情景估值（${diagramLabel(priced[0].unit)}）"`,
				`  x-axis [${priced.map((scenario) => `"${diagramLabel(scenario.name)}"`).join(", ")}]`,
				`  y-axis "${diagramLabel(priced[0].unit)}" 0 --> ${upper}`,
				`  bar [${priced.map((scenario) => scenario.value).join(", ")}]`,
				"~~~",
			].join("\n"),
		);
	} else parts.push("缺少至少两个相同时点、相同单位的可计算情景，暂不绘制估值区间图。");
	parts.push(
		"### 📝 催化剂时间线",
		table(
			["预计时间", "事件", "对回报的影响", "关联判断", "证据"],
			valuation.catalysts.map((catalyst) => [
				catalyst.expectedAt,
				catalyst.event,
				catalyst.impact,
				catalyst.judgmentIds.join("、"),
				citationCell(catalyst.evidenceIds),
			]),
			"尚未确定有证据支持的催化剂时间。",
		),
		`## 📝 ${headings.monitoring}`,
		table(
			["跟踪项", "关联判断", "指标", "来源", "频率", "预警阈值", "失效阈值", "触发后的动作", "阈值依据", "证据"],
			monitoring.rules.map((rule) => [
				rule.id,
				rule.judgmentIds.join("、"),
				rule.metric,
				rule.source,
				rule.frequency,
				rule.warningThreshold,
				rule.invalidationThreshold,
				rule.action,
				rule.thresholdBasis,
				citationCell(rule.evidenceIds),
			]),
			"尚未建立可执行监控规则；各判断的验证及失效条件见第四节。",
		),
		`## 📝 ${headings.evidenceAndChanges}`,
		"### 📝 证据与质量",
		table(
			["原始证据", "支持内容", "证据质量", "限制"],
			evidence.sources.map((source) => [
				citationCell([source.evidenceId]),
				source.description,
				source.quality,
				source.limitations,
			]),
			"尚未整理证据质量；已引用的来源见各节，不能视为已完成证据审核。",
		),
		"### 📝 未解决问题",
		evidence.openQuestions.length
			? evidence.openQuestions
					.map(
						(question) =>
							"- [" +
							(question.status === "resolved" ? "x" : " ") +
							"] " +
							prose(question.id) +
							"：" +
							prose(question.question) +
							"（关联：" +
							prose(question.judgmentIds.join("、") || "全框架") +
							"；所需证据：" +
							prose(question.evidenceNeeded) +
							"）",
					)
					.join("\n")
			: "未登记待答问题，不表示已消除所有不确定性。",
		"### 📝 资料缺口",
		bullets(evidence.coverageGaps, "未登记资料缺口；以各节的证据限制为准。"),
		"### 📝 版本变化",
		table(
			["关联判断", "之前", "现在", "变化原因", "新证据"],
			evidence.changes.map((change) => [
				change.judgmentIds.join("、") || "全框架",
				change.before,
				change.after,
				change.reason,
				citationCell(change.evidenceIds),
			]),
			"本版未记录实质变化；首次生成不虚构历史变化。",
		),
	);
	return `${parts.filter((part) => part.trim()).join("\n\n")}\n`;
}
export const frameworkReportMarkdown = renderInvestmentFrameworkMarkdown;
