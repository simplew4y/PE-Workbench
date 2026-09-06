import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { peDatasetMemoTool } from "./dataset-memo.ts";
import { peDocumentOpenTool } from "./document-open.ts";
import { peExcelRangeTool } from "./excel-range.ts";
import { peFormulaTraceTool } from "./formula-trace.ts";
import { peHistoryCompareTool } from "./history-compare.ts";
import { peModelValidateTool } from "./model-validate.ts";
import { peResearchNoteSaveTool } from "./research-note-save.ts";
import { peSourceDetailTool } from "./source-detail.ts";
import { peValuationDateTool } from "./valuation-date.ts";
import { peValuationOutputTool } from "./valuation-output.ts";
import { peWorkbookInspectTool } from "./workbook-inspect.ts";

const toolsDirectory = dirname(fileURLToPath(import.meta.url));
const memoSkillPath = join(toolsDirectory, "../../skills/pe-memo/SKILL.md");
const researchNoteSkillPath = join(toolsDirectory, "../../skills/pe-research-note/SKILL.md");
const valuationModelExplainerSkillPath = join(toolsDirectory, "../../skills/valuation-model-explainer/SKILL.md");

//注册所有pe工具
export function registerPeTools(pi: ExtensionAPI): void {
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
	pi.on("resources_discover", () => ({
		skillPaths: [memoSkillPath, researchNoteSkillPath, valuationModelExplainerSkillPath],
	}));
}

export {
	peDatasetMemoTool,
	peDocumentOpenTool,
	peExcelRangeTool,
	peFormulaTraceTool,
	peHistoryCompareTool,
	peModelValidateTool,
	peResearchNoteSaveTool,
	peSourceDetailTool,
	peValuationDateTool,
	peValuationOutputTool,
	peWorkbookInspectTool,
};
