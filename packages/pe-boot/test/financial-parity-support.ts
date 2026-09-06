import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { getPeExcelRange } from "../src/tools/excel-range.ts";
import type { tracePeFormula } from "../src/tools/formula-trace.ts";
import type { validatePeModel } from "../src/tools/model-validate.ts";
import type { resolvePeValuationDate } from "../src/tools/valuation-date.ts";
import type { locatePeValuationOutputs } from "../src/tools/valuation-output.ts";
import type { inspectPeWorkbooks } from "../src/tools/workbook-inspect.ts";

export interface FinancialTools {
	getPeExcelRange: typeof getPeExcelRange;
	tracePeFormula: typeof tracePeFormula;
	validatePeModel: typeof validatePeModel;
	resolvePeValuationDate: typeof resolvePeValuationDate;
	locatePeValuationOutputs: typeof locatePeValuationOutputs;
	inspectPeWorkbooks: typeof inspectPeWorkbooks;
}

/** Compare observable tool contracts and every persisted parser field, not only counts. */
export function financialParitySnapshot(
	cwd: string,
	docId: string,
	tools: FinancialTools,
	readablePath?: string,
): Record<string, unknown> {
	const database = new DatabaseSync(join(cwd, "meta", "collection.sqlite3"), { readOnly: true });
	try {
		const tables: Record<string, { count: number; sha256: string }> = {};
		for (const table of [
			"excel_workbooks",
			"excel_sheets",
			"excel_regions",
			"excel_cells",
			"excel_defined_names",
			"excel_formula_references",
			"valuation_date_candidates",
			"metric_facts",
		]) {
			const rows = database
				.prepare(`SELECT * FROM ${table} WHERE doc_id=?`)
				.all(docId)
				.map((row) => Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))))
				.map((row) => JSON.stringify(row))
				.sort();
			tables[table] = { count: rows.length, sha256: createHash("sha256").update(rows.join("\n")).digest("hex") };
		}
		const sheets = database
			.prepare("SELECT sheet_name, used_range FROM excel_sheets WHERE doc_id=? ORDER BY sheet_index")
			.all(docId);
		const outputs = tools.locatePeValuationOutputs(cwd, { docId });
		const contexts = outputs.selected_output ? [outputs.selected_output] : outputs.conflicting_outputs.slice(0, 3);
		const formula = database
			.prepare(
				"SELECT sheet_name, cell_ref FROM excel_cells WHERE doc_id=? AND is_formula=1 ORDER BY sheet_name,row_index,col_index LIMIT 1",
			)
			.get(docId);
		const roots = contexts.length
			? contexts
			: formula
				? [{ sheet_name: String(formula.sheet_name), cell_ref: String(formula.cell_ref) }]
				: [];
		return {
			...(readablePath
				? { readable_sha256: createHash("sha256").update(readFileSync(readablePath)).digest("hex") }
				: {}),
			tables,
			inspect: tools.inspectPeWorkbooks(cwd, { docId }),
			ranges: sheets
				.filter((sheet) => sheet.used_range)
				.map((sheet) => {
					try {
						return tools.getPeExcelRange(cwd, {
							docId,
							sheetName: String(sheet.sheet_name),
							cellRange: String(sheet.used_range),
							maxCells: 1000,
						});
					} catch (error) {
						return { error: error instanceof Error ? error.message : String(error) };
					}
				}),
			outputs,
			traces: roots.map((root) =>
				tools.tracePeFormula(cwd, { docId, sheetName: root.sheet_name, cellRef: root.cell_ref }),
			),
			dates: contexts.length
				? contexts.map((context) =>
						tools.resolvePeValuationDate(cwd, {
							docId,
							outputSheet: context.sheet_name,
							outputCellRef: context.cell_ref,
							outputCandidateId: context.candidate_id,
						}),
					)
				: [tools.resolvePeValuationDate(cwd, { docId })],
			validation: tools.validatePeModel(cwd, { docId }),
		};
	} finally {
		database.close();
	}
}
