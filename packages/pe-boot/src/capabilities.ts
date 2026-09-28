import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPeConsensusEnabled } from "./tools/feature-flags.ts";

export interface PeCapability {
	id: string;
	description: string;
	files: readonly string[];
	tools: readonly string[];
	dependencies?: readonly string[];
}

const retrievalTools = [
	"pe_pdf_list",
	"pe_pdf_search",
	"pe_pdf_read",
	"pe_document_open",
	"pe_workbook_inspect",
	"pe_workbook_search",
	"pe_excel_render",
	"pe_excel_range",
	"pe_source_detail",
];
const modelTools = [
	"pe_formula_trace",
	"pe_valuation_output_locate",
	"pe_valuation_date_resolve",
	"pe_model_validate",
	"pe_driver_discover",
	"pe_driver_sensitivity",
];

// Package-owned paths: models select IDs, never executable paths.
export const PE_CAPABILITIES: readonly PeCapability[] = [
	{
		id: "pe-financial-model-reader",
		description: "定向读取工作簿的原值、公式、批注与格式，不做投资判断",
		files: ["pe-financial-model-reader/SKILL.md"],
		tools: ["pe_workbook_inspect", "pe_workbook_search", "pe_excel_range", "pe_formula_trace", "pe_excel_render"],
	},
	{
		id: "pe-financial-model-understanding",
		description: "从预测结果追到独立假设，解释收入、成本、现金流和估值的实际建模逻辑",
		dependencies: ["pe-financial-model-reader"],
		files: ["pe-financial-model-understanding/SKILL.md"],
		tools: [],
	},
	{
		id: "pe-investment-research",
		description: "把模型假设和其他证据变成待验证的投资判断、反证条件与跟踪问题",
		dependencies: ["pe-financial-model-understanding"],
		files: ["pe-investment-research/SKILL.md"],
		tools: ["pe_investment_framework", "pe_trusted_source"],
	},
	{
		id: "investment-framework-builder",
		description: "完整投资研究总控，共用研究状态，组织模型说明、投资判断、两阶段审核与最终报告",
		dependencies: ["pe-document-retrieval", "pe-financial-model-understanding"],
		files: [
			"investment-framework-builder/SKILL.md",
			"investment-framework-builder/references/state-contract.md",
			"investment-framework-builder/references/report.md",
		],
		tools: ["read", "write", "bash", "pe_trusted_source", "pe_investment_framework"],
	},
	{
		id: "valuation-model-review",
		description: "模型说明与理解验收，按需核验三表、估值复现及敏感性",
		dependencies: ["pe-document-retrieval", "pe-valuation-model-explainer"],
		files: ["valuation-model-review/SKILL.md", "valuation-model-review/references/model-understanding.md"],
		tools: ["read", "write", "bash"],
	},
	{
		id: "business-driver-model",
		description: "还原模型输入与预测依赖，再核验商业模式、经营驱动和假设成立条件",
		dependencies: ["valuation-model-review"],
		files: ["business-driver-model/SKILL.md", "investment-framework-builder/references/state-contract.md"],
		tools: ["pe_trusted_source"],
	},
	{
		id: "independent-investment-case",
		description: "保存候选投资逻辑、正反证据、替代解释与市场共识比较前的经营判断",
		dependencies: ["pe-document-retrieval"],
		files: ["independent-investment-case/SKILL.md", "investment-framework-builder/references/state-contract.md"],
		tools: ["read", "write", "pe_trusted_source"],
	},
	{
		id: "expectations-valuation",
		description: "比较市场预期，核算情景估值、敏感性、下行与回报路径",
		dependencies: ["valuation-model-review"],
		files: ["expectations-valuation/SKILL.md", "investment-framework-builder/references/state-contract.md"],
		tools: ["pe_trusted_source"],
	},
	{
		id: "falsification-monitoring",
		description: "设计改判条件与关键变量追踪，记录证据导致的版本变化，不自动启动调度",
		dependencies: ["pe-document-retrieval"],
		files: ["falsification-monitoring/SKILL.md", "investment-framework-builder/references/state-contract.md"],
		tools: ["read", "write", "bash", "pe_trusted_source"],
	},
	{
		id: "framework-reviewer",
		description: "分别审核模型理解和投资判断，给出责任模块与定向修正意见",
		dependencies: ["valuation-model-review"],
		files: ["framework-reviewer/SKILL.md", "investment-framework-builder/references/state-contract.md"],
		tools: [],
	},
	{
		id: "pe-document-retrieval",
		description: "检索项目 PDF、Excel、Office 和文本",
		files: ["pe-document-retrieval/SKILL.md"],
		tools: retrievalTools,
	},
	{
		id: "pe-valuation-model-explainer",
		description: "解释估值模型、截图或公式；按需读取核验参考",
		dependencies: ["pe-financial-model-understanding"],
		files: ["pe-valuation-model-explainer/SKILL.md", "valuation-model-review/references/model-understanding.md"],
		tools: modelTools,
	},
	{
		id: "pe-valuation-report",
		description: "交付有原始 Excel 的整体估值报告",
		dependencies: ["pe-document-retrieval", "pe-valuation-model-explainer"],
		files: [
			"pe-valuation-report/SKILL.md",
			"pe-valuation-model-explainer/references/workbook-verification.md",
			"pe-valuation-model-explainer/references/answer-structure.md",
		],
		tools: ["pe_valuation_report"],
	},
	{
		id: "valuation-pricing-framework",
		description: "公司估值与定价判断",
		files: ["valuation-pricing-framework/SKILL.md"],
		tools: ["pe_trusted_source"],
	},
	{
		id: "stock-tracking",
		description: "股票追踪配置和基于新行情的预测",
		dependencies: ["pe-document-retrieval", "pe-valuation-model-explainer", "valuation-pricing-framework"],
		files: ["pe-valuation-model-explainer/references/workbook-verification.md"],
		tools: ["pe_stock_tracking", "pe_history_compare"],
	},
	{
		id: "pe-memo",
		description: "仅按要求创建、修改或比较持久化 Memo",
		dependencies: ["pe-document-retrieval"],
		files: ["pe-memo/SKILL.md"],
		tools: ["pe_dataset_memo", "pe_history_compare"],
	},
	{
		id: "pe-research-note",
		description: "仅按要求保存 Research Note",
		dependencies: ["pe-document-retrieval"],
		files: ["pe-research-note/SKILL.md"],
		tools: ["pe_research_note_save"],
	},
	{
		id: "pe-generative-ui",
		description: "证据充分且有助理解时选择原生可视化",
		files: ["pe-generative-ui/SKILL.md", "pe-generative-ui/references/component-selection.md"],
		tools: ["pe_render_ui"],
	},
	{
		id: "pe-consensus-divergence",
		description: "比较研究共识与分歧",
		dependencies: ["pe-document-retrieval"],
		files: ["pe-consensus-divergence/SKILL.md"],
		tools: ["pe_consensus_cards"],
	},
];

export const PE_LAZY_TOOL_NAMES: readonly string[] = ["pe_render_ui"];
export const PE_SKILLS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../skills");

export interface PeCapabilityOptions {
	/** Known entrypoints preload workflows before the first model request. */
	initialCapabilities?: readonly string[];
	/** Rollback/comparison switch; only UI schema activation is delayed. */
	lazyUi?: boolean;
	/** Host policy can change when a user changes the session tool selection. */
	canActivateTool?: (name: string) => boolean;
}

export function availablePeCapabilities(): readonly PeCapability[] {
	return PE_CAPABILITIES.filter((capability) => capability.id !== "pe-consensus-divergence" || isPeConsensusEnabled());
}

export function resolvePeCapabilities(ids: readonly string[]): PeCapability[] {
	const available = new Map(availablePeCapabilities().map((capability) => [capability.id, capability]));
	const resolved = new Map<string, PeCapability>();
	const visit = (id: string): void => {
		if (resolved.has(id)) return;
		const capability = available.get(id);
		if (!capability) throw new Error(`Unknown or disabled PE capability: ${id}`);
		for (const dependency of capability.dependencies ?? []) visit(dependency);
		resolved.set(id, capability);
	};
	for (const id of ids) visit(id);
	return [...resolved.values()];
}

export function getPeCapabilityTools(ids: readonly string[]): string[] {
	return [...new Set(resolvePeCapabilities(ids).flatMap((capability) => capability.tools))];
}

export function getPeSkillPaths(): string[] {
	return [
		...new Set(
			availablePeCapabilities()
				.flatMap((capability) => capability.files)
				.map((file) => join(PE_SKILLS_DIRECTORY, file.split("/")[0], "SKILL.md")),
		),
	];
}
