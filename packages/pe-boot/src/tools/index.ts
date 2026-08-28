import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PE_DATASET_SEARCH_PROMPT_SNIPPET, peDatasetSearchTool } from "./dataset-search.ts";
import { PE_SOURCE_DETAIL_PROMPT_SNIPPET, peSourceDetailTool } from "./source-detail.ts";

export const PE_TOOL_PROMPT_SNIPPETS = [
	{ name: "pe_dataset_search", description: PE_DATASET_SEARCH_PROMPT_SNIPPET },
	{ name: "pe_source_detail", description: PE_SOURCE_DETAIL_PROMPT_SNIPPET },
] as const;

export function registerPeTools(pi: ExtensionAPI): void {
	pi.registerTool(peDatasetSearchTool);
	pi.registerTool(peSourceDetailTool);
}

export { peDatasetSearchTool, peSourceDetailTool };
