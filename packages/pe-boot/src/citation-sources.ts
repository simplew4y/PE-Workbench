import { preparePeDocument } from "./documents.ts";
import { resolvePeEvidenceReference } from "./evidence.ts";
import { type ExcelCitationSource, type PeSourceReference, parseExcelCellRange } from "./source.ts";
import { openPeDataset, type SqlRow, sourceFilename } from "./tools/database.ts";
import { excelCellDetail } from "./tools/excel-cells.ts";
import { readWorkbookDocumentAsync } from "./workbook-reader.ts";

/** One original-file read per workbook, rather than one preview/Python process per citation. */
export async function readCitationSources(cwd: string, ids: string[], signal?: AbortSignal) {
	const sources = new Map<string, ExcelCitationSource>();
	const failures = new Map<string, string>();
	const groups = new Map<string, Array<{ id: string; reference: PeSourceReference }>>();
	for (const id of new Set(ids)) {
		try {
			const reference = resolvePeEvidenceReference(cwd, id);
			if (reference.location.kind !== "excel") continue;
			const group = groups.get(reference.docId) ?? [];
			group.push({ id, reference });
			groups.set(reference.docId, group);
		} catch (error) {
			failures.set(id, error instanceof Error ? error.message : String(error));
		}
	}
	for (const [docId, group] of groups) {
		signal?.throwIfAborted();
		try {
			const prepared = await preparePeDocument(cwd, { docId }, signal);
			const connection = openPeDataset(cwd, prepared.datasetId);
			try {
				const valid = group.filter(({ id, reference }) => {
					if (reference.location.kind !== "excel") return false;
					const { sheet, range } = reference.location;
					const row = connection.database
						.prepare("SELECT used_range FROM excel_sheets WHERE dataset_id=? AND doc_id=? AND sheet_name=?")
						.get(prepared.datasetId, docId, sheet);
					const used = parseExcelCellRange(String(row?.used_range ?? ""));
					const bounds = parseExcelCellRange(range);
					if (!used || !bounds || bounds.rowEnd > used.rowEnd || bounds.columnEnd > used.columnEnd) {
						failures.set(id, "Worksheet or range does not exist in this document version");
						return false;
					}
					return true;
				});
				if (!valid.length) continue;
				// Literal assertions are single-cell only. Range location validation uses the complete bounds above.
				const ranges = valid.map(({ reference }) => {
					if (reference.location.kind !== "excel") throw new Error("Expected Excel location");
					return { sheet: reference.location.sheet, range: reference.location.range.split(":")[0] };
				});
				const result = await readWorkbookDocumentAsync(
					connection.database,
					prepared.datasetId,
					docId,
					{ action: "read", ranges, limit: 1000 },
					{ signal, timeoutMs: 30_000 },
				);
				const cells = (result.cells as SqlRow[]).map(excelCellDetail);
				for (const { id, reference } of valid) {
					if (reference.location.kind !== "excel") continue;
					const location = reference.location;
					sources.set(id, {
						filename: sourceFilename(prepared.document),
						sheet_name: reference.location.sheet,
						cell_range: reference.location.range,
						cells: cells.filter((cell) => cell.sheet_name === location.sheet),
					});
				}
			} finally {
				connection.database.close();
			}
		} catch (error) {
			signal?.throwIfAborted();
			for (const { id } of group) failures.set(id, error instanceof Error ? error.message : String(error));
		}
	}
	return { sources, failures };
}
