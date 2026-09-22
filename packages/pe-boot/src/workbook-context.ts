import type { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { normalizeText } from "./tools/database.ts";
import { type ExcelCellDetail, readExcelCellsInRange } from "./tools/excel-cells.ts";

export interface WorkbookContextSource {
	sheet: string;
	cell: string;
	text: string;
	field?: "value" | "number_format";
}

export interface WorkbookFactContext {
	label: WorkbookContextSource;
	period?: WorkbookContextSource;
	unit: WorkbookContextSource;
}

export const workbookContextSourceSchema = Type.Object({
	sheet: Type.String({ minLength: 1 }),
	cell: Type.String({ pattern: "^[A-Z]{1,3}[1-9][0-9]*$" }),
	text: Type.String({ minLength: 1, maxLength: 4000 }),
	field: Type.Optional(Type.Union([Type.Literal("value"), Type.Literal("number_format")])),
});

export const workbookFactContextSchema = Type.Object({
	label: workbookContextSourceSchema,
	period: Type.Optional(workbookContextSourceSchema),
	unit: workbookContextSourceSchema,
});

/** Check cited source text; interpreting that text as a period or unit belongs to the caller. */
export function readWorkbookContextSource(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	source: WorkbookContextSource,
): ExcelCellDetail {
	if (
		!source ||
		typeof source.sheet !== "string" ||
		!source.sheet.trim() ||
		typeof source.cell !== "string" ||
		!/^[A-Z]{1,3}[1-9][0-9]*$/u.test(source.cell) ||
		typeof source.text !== "string" ||
		!source.text.trim() ||
		source.text.length > 4000 ||
		(source.field !== undefined && source.field !== "value" && source.field !== "number_format")
	)
		throw new Error("Context requires an exact source cell and its original text or number format");
	const cell = readExcelCellsInRange(database, datasetId, docId, source.sheet, source.cell, 1)[0];
	const actual = source.field === "number_format" ? cell?.number_format : cell?.display_value;
	if (
		!cell ||
		(source.field !== "number_format" && cell.is_formula && cell.formula_cache_status !== "present") ||
		normalizeText(actual) !== normalizeText(source.text)
	)
		throw new Error(`Source context changed or does not match: ${source.sheet}!${source.cell}`);
	return cell;
}
