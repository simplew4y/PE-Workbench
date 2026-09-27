import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPeSkillPaths, type PeCapabilityOptions } from "../capabilities.ts";
import { registerPeCapabilities } from "../capability-runtime.ts";
import { registerValuationReportGuard } from "../valuation-report-guard.ts";
import { peConsensusCardsTool } from "./consensus-cards.ts";
import { peDatasetMemoTool } from "./dataset-memo.ts";
import { peDatasetSearchTool } from "./dataset-search.ts";
import { peDocumentOpenTool } from "./document-open.ts";
import { peEvidenceDetailTool } from "./evidence-detail.ts";
import { peExcelRangeTool } from "./excel-range.ts";
import { peExcelRenderTool } from "./excel-render.ts";
import { isPeConsensusEnabled } from "./feature-flags.ts";
import { peFormulaTraceTool } from "./formula-trace.ts";
import { peFrameworkTool } from "./framework.ts";
import { peHistoryCompareTool } from "./history-compare.ts";
import { peModelValidateTool } from "./model-validate.ts";
import { pePdfListTool } from "./pdf-list.ts";
import { pePdfReadTool } from "./pdf-read.ts";
import { pePdfSearchTool } from "./pdf-search.ts";
import { peRenderUiTool } from "./render-ui.ts";
import { peResearchNoteSaveTool } from "./research-note-save.ts";
import { peSourceDetailTool } from "./source-detail.ts";
import { peStockTrackingTool } from "./stock-tracking.ts";
import { peTrustedSourceTool } from "./trusted-source.ts";
import { peValuationDateTool } from "./valuation-date.ts";
import { peValuationOutputTool } from "./valuation-output.ts";
import { peValuationReportTool } from "./valuation-report.ts";
import { peWorkbookInspectTool } from "./workbook-inspect.ts";
import { peWorkbookSearchTool } from "./workbook-search.ts";

//注册所有pe工具
export function registerPeTools(pi: ExtensionAPI, options: PeCapabilityOptions = {}): void {
	pi.registerTool(peTrustedSourceTool);
	pi.registerTool(peStockTrackingTool);
	pi.registerTool(peFrameworkTool);
	// 旧版 Chunk 检索保留在源码中便于追溯，但不再注册给模型。
	// pi.registerTool(peDatasetSearchTool);
	// pi.registerTool(peSourceDetailTool);
	pi.registerTool(pePdfSearchTool);
	if (isPeConsensusEnabled()) pi.registerTool(peConsensusCardsTool);
	pi.registerTool(pePdfListTool);
	pi.registerTool(pePdfReadTool);
	pi.registerTool(peDocumentOpenTool);
	pi.registerTool(peWorkbookInspectTool);
	pi.registerTool(peWorkbookSearchTool);
	pi.registerTool(peExcelRenderTool);
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
	registerPeCapabilities(pi, options);
	pi.on("resources_discover", () => ({ skillPaths: getPeSkillPaths() }));
}

export {
	peDatasetMemoTool,
	peConsensusCardsTool,
	peDatasetSearchTool,
	peDocumentOpenTool,
	peEvidenceDetailTool,
	peExcelRangeTool,
	peFormulaTraceTool,
	peHistoryCompareTool,
	pePdfReadTool,
	pePdfListTool,
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

export { PE_TOOL_PROMPT_SNIPPETS, pePromptSnippets } from "../tool-catalog.ts";
