import type { DatabaseSync } from "node:sqlite";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { numberValue, openPeDataset, type SqlRow, textValue } from "./database.ts";
import { excelCellDetail } from "./excel-cells.ts";

export const PE_MODEL_VALIDATE_PROMPT_SNIPPET =
	"Run deterministic structural checks for one Excel model, separating formula/cache/reference findings from valuation-output, valuation-date, and recalculation status";

export interface PeModelValidateOptions {
	docId: string;
	datasetId?: string;
}

interface ModelValidationIssue {
	severity: "error" | "warning" | "info";
	code: string;
	message: string;
}

function tableExists(database: DatabaseSync, table: string): boolean {
	return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function groupedCounts(
	database: DatabaseSync,
	query: string,
	datasetId: string,
	docId: string,
	groupColumn: string,
): Record<string, number> {
	const rows = database.prepare(query).all(datasetId, docId) as SqlRow[];
	const counts: Record<string, number> = {};
	for (const row of rows) {
		counts[textValue(row, groupColumn) ?? "unknown"] = numberValue(row, "item_count") ?? 0;
	}
	return counts;
}

export function validatePeModel(
	cwd: string,
	options: PeModelValidateOptions,
	signal?: AbortSignal,
): Record<string, unknown> {
	const docId = options.docId.trim();
	if (!docId) throw new Error("doc_id is required");
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		for (const table of ["excel_cells", "excel_formula_references", "metric_facts"] as const) {
			if (!tableExists(connection.database, table)) {
				throw new Error(`dataset has no ${table} table; open the workbook with pe_document_open before validation`);
			}
		}
		const document = connection.database
			.prepare(
				`SELECT doc_id, original_filename, source_relpath, version_no, document_date
				 FROM documents
				 WHERE dataset_id = ? AND doc_id = ? AND deleted_at IS NULL
				   AND COALESCE(is_current, 1) = 1
				   AND COALESCE(lifecycle_state, 'active') = 'active'`,
			)
			.get(connection.datasetId, docId) as SqlRow | undefined;
		if (!document) throw new Error(`active document not found in the current dataset: ${docId}`);

		const formulaCacheStatusCounts = groupedCounts(
			connection.database,
			`SELECT formula_cache_status, COUNT(*) AS item_count
			 FROM excel_cells
			 WHERE dataset_id = ? AND doc_id = ? AND is_formula = 1
			 GROUP BY formula_cache_status`,
			connection.datasetId,
			docId,
			"formula_cache_status",
		);
		const formulaReferenceStatusCounts = groupedCounts(
			connection.database,
			`SELECT parse_status, COUNT(*) AS item_count
			 FROM excel_formula_references
			 WHERE dataset_id = ? AND doc_id = ?
			 GROUP BY parse_status`,
			connection.datasetId,
			docId,
			"parse_status",
		);
		const metricQualityStatusCounts = groupedCounts(
			connection.database,
			`SELECT quality_status, COUNT(*) AS item_count
			 FROM metric_facts
			 WHERE dataset_id = ? AND doc_id = ?
			 GROUP BY quality_status`,
			connection.datasetId,
			docId,
			"quality_status",
		);
		const referenceKindCounts = groupedCounts(
			connection.database,
			`SELECT reference_kind, COUNT(*) AS item_count
			 FROM excel_formula_references
			 WHERE dataset_id = ? AND doc_id = ?
			 GROUP BY reference_kind`,
			connection.datasetId,
			docId,
			"reference_kind",
		);
		const errorRows = connection.database
			.prepare(
				`SELECT c.*, c.cell_ref AS cell_range,
				        d.original_filename, d.source_relpath, d.file_type, d.doc_type,
				        d.document_date, d.version_no
				 FROM excel_cells c
				 JOIN documents d ON d.doc_id = c.doc_id
				 WHERE c.dataset_id = ? AND c.doc_id = ?
				   AND (
				     c.display_value LIKE '#%' OR c.cached_value LIKE '#%'
				     OR c.formula LIKE '%#REF!%' OR c.formula LIKE '%#NAME?%'
				   )
				 ORDER BY c.sheet_name, c.row_index, c.col_index
				 LIMIT 50`,
			)
			.all(connection.datasetId, docId) as SqlRow[];

		const issues: ModelValidationIssue[] = [];
		for (const status of ["error"] as const) {
			const count = formulaCacheStatusCounts[status] ?? 0;
			if (count > 0)
				issues.push({
					severity: "error",
					code: `formula_cache_${status}`,
					message: `${count} formula cache(s) contain errors`,
				});
		}
		for (const status of ["missing", "unavailable"] as const) {
			const count = formulaCacheStatusCounts[status] ?? 0;
			if (count > 0)
				issues.push({
					severity: "warning",
					code: `formula_cache_${status}`,
					message: `${count} formula cache(s) are ${status}`,
				});
		}
		for (const status of ["error"] as const) {
			const count = formulaReferenceStatusCounts[status] ?? 0;
			if (count > 0)
				issues.push({
					severity: "error",
					code: `formula_reference_${status}`,
					message: `${count} formula reference(s) failed parsing or contain errors`,
				});
		}
		for (const status of ["external", "deferred", "unresolved", "unsupported"] as const) {
			const count = formulaReferenceStatusCounts[status] ?? 0;
			if (count > 0)
				issues.push({
					severity: "warning",
					code: `formula_reference_${status}`,
					message: `${count} formula reference(s) are ${status}`,
				});
		}
		if (errorRows.length > 0) {
			issues.push({
				severity: "error",
				code: "formula_error_cells",
				message: `${errorRows.length} indexed cell(s) contain formula error values or broken references`,
			});
		}
		const reviewRequiredCount = metricQualityStatusCounts.review_required ?? 0;
		if (reviewRequiredCount > 0) {
			issues.push({
				severity: "warning",
				code: "metric_facts_review_required",
				message: `${reviewRequiredCount} heuristic metric fact(s) require source-cell review`,
			});
		}
		const errorCount = issues.filter((issue) => issue.severity === "error").length;
		const warningCount = issues.filter((issue) => issue.severity === "warning").length;
		return {
			dataset_id: connection.datasetId,
			document: {
				doc_id: docId,
				filename: textValue(document, "source_relpath") ?? textValue(document, "original_filename"),
				version_no: numberValue(document, "version_no"),
				document_date: textValue(document, "document_date"),
			},
			structural_status: errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "pass",
			error_count: errorCount,
			warning_count: warningCount,
			issues,
			formula_cache_status_counts: formulaCacheStatusCounts,
			formula_reference_status_counts: formulaReferenceStatusCounts,
			reference_kind_counts: referenceKindCounts,
			metric_quality_status_counts: metricQualityStatusCounts,
			formula_error_cells: errorRows.map(excelCellDetail),
			valuation_output_validation: {
				status: "not_run",
				tool: "pe_valuation_output_locate",
				requires_selected_doc_id: true,
			},
			valuation_date_validation: {
				status: "not_run",
				tool: "pe_valuation_date_resolve",
				requires_selected_output_context: true,
			},
			calculation_validation: {
				status: "not_run",
				engine: null,
				cached_values_recalculated: false,
			},
			answer_contract:
				"Structural pass does not identify the primary valuation output, verify the valuation date, or mean cached values were recalculated. Run pe_valuation_output_locate, then pe_valuation_date_resolve with its selected output context. Do not describe cached formula values as recalculation-verified while calculation_validation.status is not_run.",
		};
	} finally {
		connection.database.close();
	}
}

export const peModelValidateTool = defineTool({
	name: "pe_model_validate",
	label: "PE Model Validate",
	description:
		"Run structural validation for one active Excel model: formula caches, reference parse status, external or deferred links, formula errors, and heuristic metric quality. Recalculation is reported separately and is not performed by this tool.",
	promptSnippet: PE_MODEL_VALIDATE_PROMPT_SNIPPET,
	parameters: Type.Object({
		doc_id: Type.String({ description: "Exact active workbook document ID.", minLength: 1 }),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		await preparePeDocument(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		const result = validatePeModel(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
