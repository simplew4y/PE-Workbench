import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PE_DATASET_MEMO_PROMPT_SNIPPET, peDatasetMemoTool } from "./dataset-memo.ts";
import { PE_DATASET_SEARCH_PROMPT_SNIPPET, peDatasetSearchTool } from "./dataset-search.ts";
import { PE_HISTORY_COMPARE_PROMPT_SNIPPET, peHistoryCompareTool } from "./history-compare.ts";
import { PE_SOURCE_DETAIL_PROMPT_SNIPPET, peSourceDetailTool } from "./source-detail.ts";

const toolsDirectory = dirname(fileURLToPath(import.meta.url));
const memoSkillPath = join(toolsDirectory, "../../skills/pe-memo/SKILL.md");

export const PE_TOOL_PROMPT_SNIPPETS = [
	{ name: "pe_dataset_search", description: PE_DATASET_SEARCH_PROMPT_SNIPPET },
	{ name: "pe_source_detail", description: PE_SOURCE_DETAIL_PROMPT_SNIPPET },
	{ name: "pe_dataset_memo", description: PE_DATASET_MEMO_PROMPT_SNIPPET },
	{ name: "pe_history_compare", description: PE_HISTORY_COMPARE_PROMPT_SNIPPET },
] as const;

export function registerPeTools(pi: ExtensionAPI): void {
	pi.registerTool(peDatasetSearchTool);
	pi.registerTool(peSourceDetailTool);
	pi.registerTool(peDatasetMemoTool);
	pi.registerTool(peHistoryCompareTool);
	pi.on("resources_discover", () => ({ skillPaths: [memoSkillPath] }));
}

export { peDatasetMemoTool, peDatasetSearchTool, peHistoryCompareTool, peSourceDetailTool };
