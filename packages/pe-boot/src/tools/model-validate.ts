import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { inspectWorkbookDocument } from "../workbook-reader.ts";
import { openPeDataset } from "./database.ts";

export const PE_MODEL_VALIDATE_PROMPT_SNIPPET =
	"Check full-workbook navigation statistics for formula-cache errors and external links; formula lineage is checked separately for selected cells";

export interface PeModelValidateOptions {
	docId: string;
	datasetId?: string;
}

export function validatePeModel(
	cwd: string,
	options: PeModelValidateOptions,
	signal?: AbortSignal,
): Record<string, unknown> {
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		const navigation = inspectWorkbookDocument(connection.database, connection.datasetId, options.docId);
		const cacheCounts = navigation.formula_cache_status_counts as Record<string, number> | undefined;
		const errorCells = Number(navigation.error_cell_count ?? 0);
		const externalLinks = Number(navigation.external_link_count ?? 0);
		const scanComplete = navigation.scan_complete === true;
		const issues: Array<{ severity: string; code: string; message: string }> = [];
		if (!scanComplete)
			issues.push({
				severity: "warning",
				code: "navigation_incomplete",
				message: "Workbook statistics do not cover a complete scan",
			});
		if (errorCells > 0 || (cacheCounts?.error ?? 0) > 0)
			issues.push({
				severity: "error",
				code: "formula_error_cells",
				message: `${errorCells} source error cell(s); ${cacheCounts?.error ?? 0} formula error cache(s)`,
			});
		if ((cacheCounts?.missing ?? 0) > 0)
			issues.push({
				severity: "warning",
				code: "formula_cache_missing",
				message: `${cacheCounts?.missing} formula cache(s) are missing`,
			});
		if (externalLinks > 0)
			issues.push({
				severity: "warning",
				code: "external_links",
				message: `${externalLinks} external workbook link(s) require source review`,
			});
		const errorCount = issues.filter((issue) => issue.severity === "error").length;
		const warningCount = issues.filter((issue) => issue.severity === "warning").length;
		return {
			dataset_id: connection.datasetId,
			document: { doc_id: options.docId },
			structural_status: errorCount ? "error" : warningCount ? "warning" : "pass",
			validation_scope: "Navigation statistics only",
			scan_complete: scanComplete,
			issues,
			error_count: errorCount,
			warning_count: warningCount,
			formula_cache_status_counts: cacheCounts ?? {},
			error_cell_count: errorCells,
			external_link_count: externalLinks,
			formula_reference_validation: { status: "not_run", tool: "pe_formula_trace", scope: "selected_cells" },
			valuation_output_validation: { status: "not_run", tool: "pe_valuation_output_locate" },
			valuation_date_validation: { status: "not_run", tool: "pe_valuation_date_resolve" },
			calculation_validation: { status: "not_run", cached_values_recalculated: false },
			answer_contract:
				"A statistics pass does not validate formulas, valuation meaning, units, dates, or calculation freshness. Trace selected formulas on demand; report the trace coverage and unresolved dependencies.",
		};
	} finally {
		connection.database.close();
	}
}

export const peModelValidateTool = defineTool({
	name: "pe_model_validate",
	label: "PE Model Validate",
	promptSnippet: PE_MODEL_VALIDATE_PROMPT_SNIPPET,
	description:
		"Check source navigation statistics for cache errors, missing caches and external links. No full formula graph, semantic inference or recalculation.",
	parameters: Type.Object({
		doc_id: Type.String({ minLength: 1 }),
		dataset_id: Type.Optional(Type.String()),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		await preparePeDocument(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		const result = validatePeModel(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
	},
});
