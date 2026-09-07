/** Stable Excel evidence IDs. PDF evidence continues to use page:<page_id>. */
export interface PeSourceReference {
	docId: string;
	sheet: string;
	range: string;
}

export interface ExcelBounds {
	rowStart: number;
	rowEnd: number;
	columnStart: number;
	columnEnd: number;
}

export interface PeSourceCell {
	cell_ref: string;
	row_index: number;
	col_index: number;
	display_value?: string;
	raw_value?: string;
	numeric_value?: number;
	formula?: string;
	cached_value?: string;
	number_format?: string;
	formula_type?: string;
	formula_cache_status?: string;
	is_formula?: boolean;
	row_label?: string;
	col_label?: string;
	period?: string;
	unit?: string;
}

export interface PeExcelGridWindow {
	row_start: number;
	row_end: number;
	col_start: number;
	col_end: number;
}

interface PeSourceBase {
	dataset_id: string;
	doc_id: string;
	evidence_id: string;
	citation: string;
	markdown_citation: string;
	filename: string;
	truncated: boolean;
	warnings: string[];
}

export interface PePdfSource extends PeSourceBase {
	kind: "pdf";
	page_start: number;
	page_end: number;
	content: string;
	pdf_pages: Array<{ page_number: number; text: string }>;
}

export interface PeExcelSource extends PeSourceBase {
	kind: "excel";
	sheet_name: string;
	cell_range: string;
	grid_window: PeExcelGridWindow;
	cells: PeSourceCell[];
}

export type PeSourcePayload = PePdfSource | PeExcelSource;

export function excelColumnLabel(column: number): string {
	if (!Number.isInteger(column) || column < 1 || column > 16_384) return "";
	let label = "";
	while (column > 0) {
		column--;
		label = String.fromCharCode(65 + (column % 26)) + label;
		column = Math.floor(column / 26);
	}
	return label;
}

export function parseExcelCellRange(value: string | undefined): ExcelBounds | undefined {
	if (!value) return undefined;
	const match = /^\$?([A-Z]{1,3})\$?([1-9]\d*)(?::\$?([A-Z]{1,3})\$?([1-9]\d*))?$/iu.exec(value.trim());
	if (!match) return undefined;
	const columns = [match[1], match[3] ?? match[1]].map((label) => {
		let column = 0;
		for (const character of label.toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
		return column;
	});
	const rows = [Number(match[2]), Number(match[4] ?? match[2])];
	if (columns.some((column) => column > 16_384) || rows.some((row) => row > 1_048_576)) return undefined;
	return {
		rowStart: Math.min(...rows),
		rowEnd: Math.max(...rows),
		columnStart: Math.min(...columns),
		columnEnd: Math.max(...columns),
	};
}

export function sourceId(reference: PeSourceReference): string {
	if (
		!/^[A-Za-z0-9_-]{1,128}$/u.test(reference.docId) ||
		!reference.sheet ||
		reference.sheet.length > 255 ||
		!parseExcelCellRange(reference.range)
	) {
		throw new Error("Invalid Excel source location");
	}
	const payload = JSON.stringify({ v: 1, doc_id: reference.docId, sheet: reference.sheet, range: reference.range });
	const bytes = new TextEncoder().encode(payload);
	return `source:${btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "")}`;
}

export function parseSourceId(id: string): PeSourceReference | undefined {
	if (id.length > 2_048 || !/^source:[A-Za-z0-9_-]+$/u.test(id)) return undefined;
	try {
		const encoded = id.slice(7).replaceAll("-", "+").replaceAll("_", "/");
		const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const payload = value as Record<string, unknown>;
		if (
			payload.v !== 1 ||
			typeof payload.doc_id !== "string" ||
			!/^[A-Za-z0-9_-]{1,128}$/u.test(payload.doc_id) ||
			typeof payload.sheet !== "string" ||
			!payload.sheet ||
			payload.sheet.length > 255 ||
			typeof payload.range !== "string" ||
			!parseExcelCellRange(payload.range)
		) {
			return undefined;
		}
		return { docId: payload.doc_id, sheet: payload.sheet, range: payload.range };
	} catch {
		return undefined;
	}
}

export function sourceUrl(id: string): string {
	if (!parseSourceId(id)) throw new Error("Invalid source ID");
	return `#pe-source?${new URLSearchParams({ evidence_id: id })}`;
}

export function sourceLink(label: string, id: string): string {
	const escaped = label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
	return `[${escaped}](${sourceUrl(id)})`;
}
