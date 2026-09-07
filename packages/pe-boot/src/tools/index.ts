import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerValuationReportGuard } from "../valuation-report-guard.ts";
import { peDatasetMemoTool } from "./dataset-memo.ts";
import { peDatasetSearchTool } from "./dataset-search.ts";
import { peDocumentOpenTool } from "./document-open.ts";
import { peEvidenceDetailTool } from "./evidence-detail.ts";
import { PE_EXCEL_RANGE_PROMPT_SNIPPET, peExcelRangeTool } from "./excel-range.ts";
import { PE_FORMULA_TRACE_PROMPT_SNIPPET, peFormulaTraceTool } from "./formula-trace.ts";
import { peHistoryCompareTool } from "./history-compare.ts";
import { PE_MODEL_VALIDATE_PROMPT_SNIPPET, peModelValidateTool } from "./model-validate.ts";
import { PE_PDF_READ_PROMPT_SNIPPET, pePdfReadTool } from "./pdf-read.ts";
import { PE_PDF_SEARCH_PROMPT_SNIPPET, pePdfSearchTool } from "./pdf-search.ts";
import { PE_RENDER_UI_PROMPT_SNIPPET, peRenderUiTool } from "./render-ui.ts";
import { peResearchNoteSaveTool } from "./research-note-save.ts";
import { PE_SOURCE_DETAIL_PROMPT_SNIPPET, peSourceDetailTool } from "./source-detail.ts";
import { PE_VALUATION_DATE_PROMPT_SNIPPET, peValuationDateTool } from "./valuation-date.ts";
import { PE_VALUATION_OUTPUT_PROMPT_SNIPPET, peValuationOutputTool } from "./valuation-output.ts";
import { PE_VALUATION_REPORT_PROMPT_SNIPPET, peValuationReportTool } from "./valuation-report.ts";
import { PE_WORKBOOK_INSPECT_PROMPT_SNIPPET, peWorkbookInspectTool } from "./workbook-inspect.ts";

const toolsDirectory = dirname(fileURLToPath(import.meta.url));
const memoSkillPath = join(toolsDirectory, "../../skills/pe-memo/SKILL.md");
const researchNoteSkillPath = join(toolsDirectory, "../../skills/pe-research-note/SKILL.md");
const generativeUiSkillPath = join(toolsDirectory, "../../skills/pe-generative-ui/SKILL.md");
const valuationSkillPath = join(toolsDirectory, "../../skills/pe-valuation-model-explainer/SKILL.md");

//系统提示词只注入pe核心检索工具相关的提示词，其他的不注入
export const PE_TOOL_PROMPT_SNIPPETS = [
	// 旧版 Chunk 检索保留在源码中便于追溯，但不再写入系统提示词。
	// { name: "pe_dataset_search", description: PE_DATASET_SEARCH_PROMPT_SNIPPET },
	// { name: "pe_source_detail", description: PE_SOURCE_DETAIL_PROMPT_SNIPPET },
	{ name: "pe_pdf_search", description: PE_PDF_SEARCH_PROMPT_SNIPPET },
	{ name: "pe_pdf_read", description: PE_PDF_READ_PROMPT_SNIPPET },
	{ name: "pe_document_open", description: peDocumentOpenTool.promptSnippet },
	{ name: "pe_workbook_inspect", description: PE_WORKBOOK_INSPECT_PROMPT_SNIPPET },
	{ name: "pe_excel_range", description: PE_EXCEL_RANGE_PROMPT_SNIPPET },
	{ name: "pe_formula_trace", description: PE_FORMULA_TRACE_PROMPT_SNIPPET },
	{ name: "pe_source_detail", description: PE_SOURCE_DETAIL_PROMPT_SNIPPET },
	{ name: "pe_valuation_output_locate", description: PE_VALUATION_OUTPUT_PROMPT_SNIPPET },
	{ name: "pe_valuation_date_resolve", description: PE_VALUATION_DATE_PROMPT_SNIPPET },
	{ name: "pe_model_validate", description: PE_MODEL_VALIDATE_PROMPT_SNIPPET },
	{ name: "pe_valuation_report", description: PE_VALUATION_REPORT_PROMPT_SNIPPET },
	{ name: "pe_render_ui", description: PE_RENDER_UI_PROMPT_SNIPPET },
] as const;

//注册所有pe工具
export function registerPeTools(pi: ExtensionAPI): void {
	// 旧版 Chunk 检索保留在源码中便于追溯，但不再注册给模型。
	// pi.registerTool(peDatasetSearchTool);
	// pi.registerTool(peSourceDetailTool);
	pi.registerTool(pePdfSearchTool);
	pi.registerTool(pePdfReadTool);
	pi.registerTool(peDocumentOpenTool);
	pi.registerTool(peWorkbookInspectTool);
	pi.registerTool(peExcelRangeTool);
	pi.registerTool(peFormulaTraceTool);
	pi.registerTool(peSourceDetailTool);
	pi.registerTool(peValuationOutputTool);
	pi.registerTool(peValuationDateTool);
	pi.registerTool(peModelValidateTool);
	pi.registerTool(peValuationReportTool);
	registerValuationReportGuard(pi);
	pi.registerTool(peDatasetMemoTool);
	pi.registerTool(peHistoryCompareTool);
	pi.registerTool(peResearchNoteSaveTool);
	pi.registerTool(peRenderUiTool);
	pi.on("resources_discover", () => ({
		skillPaths: [memoSkillPath, researchNoteSkillPath, generativeUiSkillPath, valuationSkillPath],
	}));
}

export {
	peDatasetMemoTool,
	peDatasetSearchTool,
	peDocumentOpenTool,
	peEvidenceDetailTool,
	peExcelRangeTool,
	peFormulaTraceTool,
	peHistoryCompareTool,
	pePdfReadTool,
	pePdfSearchTool,
	peRenderUiTool,
	peResearchNoteSaveTool,
	peSourceDetailTool,
	peModelValidateTool,
	peValuationDateTool,
	peValuationOutputTool,
	peValuationReportTool,
	peWorkbookInspectTool,
};
