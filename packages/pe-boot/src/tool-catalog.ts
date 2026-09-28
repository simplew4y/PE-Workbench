import { PE_CONSENSUS_CARDS_PROMPT_SNIPPET } from "./tools/consensus-cards.ts";
import { isPeConsensusEnabled } from "./tools/feature-flags.ts";

// 常驻能力索引保持简短；参数契约留在工具定义，操作流程留在 Skill。
export const PE_TOOL_PROMPT_SNIPPETS = [
	{ name: "pe_trusted_source", description: "Retrieve trusted external financial and market evidence" },
	{
		name: "pe_stock_tracking",
		description: "Configure stock tracking, refresh market history and record instructed simulated trades",
	},
	{ name: "pe_investment_framework", description: "Read or propose the complete seven-section investment framework" },
	// 旧版 Chunk 检索保留在源码中便于追溯，但不再写入系统提示词。
	// { name: "pe_dataset_search", description: PE_DATASET_SEARCH_PROMPT_SNIPPET },
	// { name: "pe_source_detail", description: PE_SOURCE_DETAIL_PROMPT_SNIPPET },
	{ name: "pe_pdf_search", description: "Search indexed PDF page text" },
	{ name: "pe_pdf_list", description: "List PDF documents and versions" },
	{ name: "pe_pdf_read", description: "Read exact PDF pages and available page images" },
	{ name: "pe_document_open", description: "Open the readable view of a selected original document" },
	{ name: "pe_workbook_inspect", description: "Inspect workbooks and select a document version" },
	{ name: "pe_workbook_search", description: "Find original workbook labels and comments" },
	{ name: "pe_excel_render", description: "Inspect a local workbook range visually" },
	{ name: "pe_excel_range", description: "Read exact Excel cells, formulas, cached values and units" },
	{ name: "pe_formula_trace", description: "Trace upstream Excel formula dependencies" },
	{ name: "pe_source_detail", description: "Resolve version-bound evidence to its original location" },
	{ name: "pe_valuation_output_locate", description: "Search source labels to locate valuation outputs" },
	{
		name: "pe_valuation_date_resolve",
		description: "Check original date/label text; date roles remain analyst interpretation",
	},
	{ name: "pe_model_validate", description: "Check workbook structure and calculation validation status separately" },
	{ name: "pe_valuation_report", description: "Validate source facts and render a checked valuation report" },
	{
		name: "pe_render_ui",
		description: "Render verified evidence when a visual helps; use pe-generative-ui for selection",
	},
] as const;

export function pePromptSnippets(): ReadonlyArray<{ name: string; description: string | undefined }> {
	if (!isPeConsensusEnabled()) return PE_TOOL_PROMPT_SNIPPETS;
	return [...PE_TOOL_PROMPT_SNIPPETS, { name: "pe_consensus_cards", description: PE_CONSENSUS_CARDS_PROMPT_SNIPPET }];
}
