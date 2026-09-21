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
	"pe_excel_range",
	"pe_source_detail",
];
const modelTools = ["pe_formula_trace", "pe_valuation_output_locate", "pe_valuation_date_resolve", "pe_model_validate"];

// Package-owned paths: models select IDs, never executable paths.
export const PE_CAPABILITIES: readonly PeCapability[] = [
	{
		id: "pe-document-retrieval",
		description: "检索项目 PDF、Excel、Office 和文本",
		files: ["pe-document-retrieval/SKILL.md"],
		tools: retrievalTools,
	},
	{
		id: "pe-valuation-model-explainer",
		description: "解释估值模型、截图或公式；按需读取核验参考",
		files: ["pe-valuation-model-explainer/SKILL.md"],
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
