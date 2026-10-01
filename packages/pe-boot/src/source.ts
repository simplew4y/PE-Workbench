/** File locations are independent of parser caches and search results. */
export const DOCUMENT_EXTENSIONS = new Set([
	".pdf",
	".xlsx",
	".xlsm",
	".docx",
	".pptx",
	".csv",
	".md",
	".markdown",
	".txt",
]);

export type PeSourceLocation =
	| { kind: "pdf"; pageStart: number; pageEnd: number }
	| { kind: "excel"; sheet: string; range: string }
	| { kind: "text"; lineStart: number; lineEnd: number }
	| { kind: "block"; blockIndex: number };

export interface PeSourceReference {
	docId: string;
	location: PeSourceLocation;
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
	version_no: number;
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

export interface PeTextSource extends PeSourceBase {
	kind: "text";
	content: string;
}

export type PeSourcePayload = PePdfSource | PeExcelSource | PeTextSource;

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

export function sourceId(reference: PeSourceReference | { docId: string; sheet: string; range: string }): string {
	const { docId } = reference;
	const location =
		"location" in reference
			? reference.location
			: { kind: "excel" as const, sheet: reference.sheet, range: reference.range };
	const fields: (string | number)[] = [docId, location.kind];
	switch (location.kind) {
		case "pdf":
			fields.push(location.pageStart, location.pageEnd);
			break;
		case "excel":
			fields.push(location.sheet, location.range);
			break;
		case "text":
			fields.push(location.lineStart, location.lineEnd);
			break;
		case "block":
			fields.push(location.blockIndex);
	}
	const bytes = new TextEncoder().encode(JSON.stringify(fields));
	const id = `source:${btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "")}`;
	if (!parseSourceId(id)) throw new Error("Invalid source location");
	return id;
}

export function parseSourceId(id: string): PeSourceReference | undefined {
	if (id.length > 2_048 || !/^source:[A-Za-z0-9_-]+$/u.test(id)) return undefined;
	try {
		const encoded = id.slice(7).replaceAll("-", "+").replaceAll("_", "/");
		const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
		let fields: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		// Existing research conversations encode the same immutable Excel location
		// as an object. New links use the shared array format for every file type.
		if (fields && typeof fields === "object" && !Array.isArray(fields)) {
			const legacy = fields as Record<string, unknown>;
			if (legacy.v !== 1) return undefined;
			fields = [legacy.doc_id, "excel", legacy.sheet, legacy.range];
		}
		if (!Array.isArray(fields)) return undefined;
		const [docId, kind, start, end] = fields as unknown[];
		if (typeof docId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(docId)) return undefined;
		if (kind === "excel" && fields.length === 4) {
			if (typeof start !== "string" || !start || start.length > 255 || typeof end !== "string") return undefined;
			if (!parseExcelCellRange(end)) return undefined;
			return { docId, location: { kind, sheet: start, range: end } };
		}
		if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1) return undefined;
		if (kind === "block" && fields.length === 3) return { docId, location: { kind, blockIndex: start } };
		if (fields.length !== 4 || typeof end !== "number" || !Number.isSafeInteger(end) || end < start) return undefined;
		if (kind === "pdf") return { docId, location: { kind, pageStart: start, pageEnd: end } };
		if (kind === "text") return { docId, location: { kind, lineStart: start, lineEnd: end } };
		return undefined;
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

export interface ExcelCitationSource {
	filename: string;
	sheet_name?: string;
	cell_range?: string;
	cells: PeSourceCell[];
}

export interface ExcelCitationCheck {
	status: "consistent" | "mismatch" | "unverified";
	declared?: string;
	actual?: string;
	reason?: string;
}

/**
 * Check an explicit locator and optional literal assertion: Sheet!B12 = 75 or
 * Sheet!B12 = =B10*B11. Consistency never certifies surrounding prose.
 */
export function checkExcelCitation(
	label: string,
	evidenceId: string,
	source?: ExcelCitationSource,
): ExcelCitationCheck {
	const reference = parseSourceId(evidenceId);
	const location = reference?.location.kind === "excel" ? reference.location : undefined;
	const sheet = source?.sheet_name ?? location?.sheet;
	const range = source?.cell_range ?? location?.range;
	if (!sheet || !range) return { status: "unverified" };
	const actual = `${sheet}!${range}`;
	const match = /^(.+)!\s*(\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?)(?:\s*=\s*(.+))?$/iu.exec(
		label.trim(),
	);
	if (!match) return { status: "unverified", actual };
	let declaredSheet = match[1].trim();
	let filename: string | undefined;
	const file = /^(.*\.(?:xlsx|xlsm))\s+(.+)$/iu.exec(declaredSheet);
	if (file) {
		filename = file[1];
		declaredSheet = file[2];
	}
	if (declaredSheet.startsWith("'") && declaredSheet.endsWith("'"))
		declaredSheet = declaredSheet.slice(1, -1).replaceAll("''", "'");
	const expected = parseExcelCellRange(match[2]);
	const observed = parseExcelCellRange(range);
	const declared = `${declaredSheet}!${match[2]}`;
	const mismatch = (reason: string): ExcelCitationCheck => ({ status: "mismatch", declared, actual, reason });
	if (!expected || !observed) return { status: "unverified", declared, actual };
	if (declaredSheet.toLowerCase() !== sheet.toLowerCase()) return mismatch("工作表不一致");
	if (Object.keys(expected).some((key) => expected[key as keyof ExcelBounds] !== observed[key as keyof ExcelBounds]))
		return mismatch("单元格或范围不一致");
	if (filename && source && filename !== source.filename) return mismatch("文件名称不一致");
	if (match[3] !== undefined) {
		if (!source || expected.rowStart !== expected.rowEnd || expected.columnStart !== expected.columnEnd)
			return { status: "unverified", declared, actual };
		const cell = source.cells.find(
			(cell) => cell.row_index === expected.rowStart && cell.col_index === expected.columnStart,
		);
		if (!cell) return { status: "unverified", declared, actual, reason: "未读取声明的单元格" };
		const assertion = match[3].trim();
		if (assertion.startsWith("=")) {
			if (cell.formula !== assertion) return mismatch("声明公式与来源公式不一致");
		} else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/iu.test(assertion)) {
			const number = Number(assertion.replace(/%$/u, "")) / (assertion.endsWith("%") ? 100 : 1);
			if (
				cell.numeric_value === undefined ||
				!Number.isFinite(number) ||
				Math.abs(cell.numeric_value - number) > Math.max(1, Math.abs(number)) * 1e-10
			)
				return mismatch("声明数值与来源数值不一致（行名不能作为数值证据）");
		} else return { status: "unverified", declared, actual, reason: "声明内容不是可核验的数值或公式" };
	}
	return { status: filename && !source ? "unverified" : "consistent", declared, actual };
}

/** Shared by runtime checks and browser links; never trusts a supplied cwd. */
export function citationEvidenceId(href: string): string | undefined {
	let suffix: string;
	const hash = href.indexOf("#pe-source");
	if (hash >= 0) suffix = href.slice(hash + "#pe-source".length);
	else {
		try {
			const url = new URL(href, "https://pe-workbench.local");
			if (
				!/^https?:$/u.test(url.protocol) ||
				url.hostname !== "pe-workbench.local" ||
				url.port ||
				url.username ||
				url.password ||
				url.pathname !== "/pe-source"
			)
				return undefined;
			suffix = url.search;
		} catch {
			return undefined;
		}
	}
	if (!suffix.startsWith("?")) return undefined;
	const id = new URLSearchParams(suffix.slice(1)).get("evidence_id")?.trim();
	return id && (/^(?:page|chunk|fact|cell):[^\s:]+$/u.test(id) || parseSourceId(id)) ? id : undefined;
}

export function excelCitationWarning(check: ExcelCitationCheck): string | undefined {
	return check.status === "mismatch"
		? "引用不一致：声明 " +
				check.declared +
				"，实际来源 " +
				check.actual +
				"。" +
				check.reason +
				"；相关论述尚未核验。"
		: undefined;
}
