import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PE_CONSENSUS_CARDS_PROMPT_SNIPPET, peConsensusCardsTool } from "./consensus-cards.ts";
import { peDatasetMemoTool } from "./dataset-memo.ts";
import { peDatasetSearchTool } from "./dataset-search.ts";
import { peDocumentOpenTool } from "./document-open.ts";
import { peExcelRangeTool } from "./excel-range.ts";
import { isPeConsensusEnabled } from "./feature-flags.ts";
import { peFormulaTraceTool } from "./formula-trace.ts";
import { peHistoryCompareTool } from "./history-compare.ts";
import { peModelValidateTool } from "./model-validate.ts";
import { PE_PDF_LIST_PROMPT_SNIPPET, pePdfListTool } from "./pdf-list.ts";
import { PE_PDF_READ_PROMPT_SNIPPET, pePdfReadTool } from "./pdf-read.ts";
import { PE_PDF_SEARCH_PROMPT_SNIPPET, pePdfSearchTool } from "./pdf-search.ts";
import { PE_RENDER_UI_PROMPT_SNIPPET, peRenderUiTool } from "./render-ui.ts";
import { peResearchNoteSaveTool } from "./research-note-save.ts";
import { peSourceDetailTool } from "./source-detail.ts";
import { peValuationDateTool } from "./valuation-date.ts";
import { peValuationOutputTool } from "./valuation-output.ts";
import { peWorkbookInspectTool } from "./workbook-inspect.ts";

const toolsDirectory = dirname(fileURLToPath(import.meta.url));
const memoSkillPath = join(toolsDirectory, "../../skills/pe-memo/SKILL.md");
const researchNoteSkillPath = join(toolsDirectory, "../../skills/pe-research-note/SKILL.md");
const generativeUiSkillPath = join(toolsDirectory, "../../skills/pe-generative-ui/SKILL.md");
const valuationModelExplainerSkillPath = join(toolsDirectory, "../../skills/valuation-model-explainer/SKILL.md");

//系统提示词只注入pe核心检索工具相关的提示词，其他的不注入
export const PE_TOOL_PROMPT_SNIPPETS = [
	// 旧版 Chunk 检索保留在源码中便于追溯，但不再写入系统提示词。
	// { name: "pe_dataset_search", description: PE_DATASET_SEARCH_PROMPT_SNIPPET },
	// { name: "pe_source_detail", description: PE_SOURCE_DETAIL_PROMPT_SNIPPET },
	{ name: "pe_pdf_list", description: PE_PDF_LIST_PROMPT_SNIPPET },
	{ name: "pe_pdf_search", description: PE_PDF_SEARCH_PROMPT_SNIPPET },
	{ name: "pe_pdf_read", description: PE_PDF_READ_PROMPT_SNIPPET },
	{ name: "pe_document_open", description: peDocumentOpenTool.promptSnippet },
	{ name: "pe_source_detail", description: peSourceDetailTool.promptSnippet },
	{ name: "pe_workbook_inspect", description: peWorkbookInspectTool.promptSnippet },
	{ name: "pe_excel_range", description: peExcelRangeTool.promptSnippet },
	{ name: "pe_formula_trace", description: peFormulaTraceTool.promptSnippet },
	{ name: "pe_valuation_output_locate", description: peValuationOutputTool.promptSnippet },
	{ name: "pe_valuation_date_resolve", description: peValuationDateTool.promptSnippet },
	{ name: "pe_model_validate", description: peModelValidateTool.promptSnippet },
	{ name: "pe_render_ui", description: PE_RENDER_UI_PROMPT_SNIPPET },
] as const;

/** Snippets for tools that ship behind a flag, appended only when that flag is on. */
const PE_FLAGGED_TOOL_PROMPT_SNIPPETS = [
	{ name: "pe_consensus_cards", description: PE_CONSENSUS_CARDS_PROMPT_SNIPPET, enabled: isPeConsensusEnabled },
] as const;

export function pePromptSnippets(): Array<{ name: string; description: string | undefined }> {
	return [...PE_TOOL_PROMPT_SNIPPETS, ...PE_FLAGGED_TOOL_PROMPT_SNIPPETS.filter((snippet) => snippet.enabled())].map(
		({ name, description }) => ({ name, description }),
	);
}

//注册所有pe工具
export function registerPeTools(pi: ExtensionAPI): void {
	// 旧版 Chunk 检索保留在源码中便于追溯，但不再注册给模型。
	// pi.registerTool(peDatasetSearchTool);
	// pi.registerTool(peSourceDetailTool);
	pi.registerTool(pePdfListTool);
	pi.registerTool(pePdfSearchTool);
	pi.registerTool(pePdfReadTool);
	pi.registerTool(peDocumentOpenTool);
	pi.registerTool(peSourceDetailTool);
	pi.registerTool(peWorkbookInspectTool);
	pi.registerTool(peExcelRangeTool);
	pi.registerTool(peFormulaTraceTool);
	pi.registerTool(peValuationOutputTool);
	pi.registerTool(peValuationDateTool);
	pi.registerTool(peModelValidateTool);
	pi.registerTool(peDatasetMemoTool);
	pi.registerTool(peHistoryCompareTool);
	pi.registerTool(peResearchNoteSaveTool);
	pi.registerTool(peRenderUiTool);
	if (isPeConsensusEnabled()) pi.registerTool(peConsensusCardsTool);
	pi.on("resources_discover", () => ({
		skillPaths: [memoSkillPath, researchNoteSkillPath, valuationModelExplainerSkillPath, generativeUiSkillPath],
	}));
}

export {
	peConsensusCardsTool,
	peDatasetMemoTool,
	peDatasetSearchTool,
	peDocumentOpenTool,
	peExcelRangeTool,
	peFormulaTraceTool,
	peHistoryCompareTool,
	peModelValidateTool,
	pePdfListTool,
	pePdfReadTool,
	pePdfSearchTool,
	peRenderUiTool,
	peResearchNoteSaveTool,
	peSourceDetailTool,
	peValuationDateTool,
	peValuationOutputTool,
	peWorkbookInspectTool,
};
