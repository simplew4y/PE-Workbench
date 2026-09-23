/**
 * Compact, budgeted text views of workbook reader results for the model.
 *
 * Tool `details` keep the full structured result for the UI and evidence storage.
 * Only the `content` text sent to the model goes through this module, so one cell
 * costs tens of bytes instead of the ~1 KB a serialized record with citations,
 * style objects and duplicated value fields used to cost.
 */

export const DEFAULT_WORKBOOK_TEXT_BYTES = 32 * 1024;
const MAX_TEXT_CELL_CHARS = 200;
const MAX_COMMENT_CHARS = 160;
const MAX_FORMULA_CHARS = 400;

export interface WorkbookTextOptions {
	/** Byte budget for the whole text. Defaults to PE_WORKBOOK_TEXT_BYTES or 32 KB. */
	maxBytes?: number;
	/** Emit a `source:` evidence ID per cell. Defaults to true. */
	includeEvidenceIds?: boolean;
	/** Emit static font/fill colors per cell. Defaults to false. */
	includeStyle?: boolean;
	/** Document label used in the header, such as the original filename. */
	filename?: string;
	docId?: string;
	versionNo?: number | string;
}

export interface WorkbookTextSummary {
	bytes: number;
	truncated: boolean;
	/** Cell (or node) lines that made it into the text. */
	shown_cells: number;
	/** Cell lines omitted by the byte budget; the reader did return them. */
	omitted_cells: number;
	/** Continuation offset when the budget cut a paginated cell list. */
	next_offset?: number;
}

export interface WorkbookTextResult {
	text: string;
	summary: WorkbookTextSummary;
}

type Row = Record<string, unknown>;

export function workbookTextBudget(maxBytes?: number): number {
	if (maxBytes !== undefined && Number.isFinite(maxBytes) && maxBytes > 0) return Math.trunc(maxBytes);
	const configured = Number(process.env.PE_WORKBOOK_TEXT_BYTES);
	return Number.isFinite(configured) && configured >= 4096 ? Math.trunc(configured) : DEFAULT_WORKBOOK_TEXT_BYTES;
}

function object(value: unknown): value is Row {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function truthy(value: unknown): boolean {
	return value === true || value === 1 || value === "1";
}

function clip(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…(+${value.length - max})` : value;
}

function quote(value: string, max = MAX_TEXT_CELL_CHARS): string {
	return JSON.stringify(clip(value, max));
}

function colorText(color: unknown): string | undefined {
	if (!object(color)) return undefined;
	const value = color.value;
	if (value === null || value === undefined) return undefined;
	const tint = typeof color.tint === "number" && color.tint !== 0 ? `~${color.tint}` : "";
	return `${color.type === "rgb" ? "" : `${String(color.type)}:`}${String(value)}${tint}`;
}

function styleText(style: unknown): string | undefined {
	if (!object(style)) return undefined;
	const parts: string[] = [];
	const font = colorText(style.font_color);
	if (font) parts.push(`font=${font}`);
	const fill = style.fill_type ? colorText(style.fill_foreground) : undefined;
	if (fill) parts.push(`fill=${fill}`);
	if (style.bold === true) parts.push("bold");
	if (style.italic === true) parts.push("italic");
	return parts.length ? parts.join(" ") : undefined;
}

interface NormalizedCell {
	sheet: string;
	ref: string;
	value: string;
	formula: string;
	notes: string;
	evidenceId: string;
}

/** Accepts raw reader records (metadata_json string, numeric is_formula) and ExcelCellDetail objects. */
function normalizeCell(row: Row, options: WorkbookTextOptions): NormalizedCell {
	const isFormula = truthy(row.is_formula);
	const status = text(row.formula_cache_status);
	const numeric = typeof row.numeric_value === "number" ? row.numeric_value : undefined;
	const valueType = text(row.value_type) ?? "";
	let value: string;
	if (isFormula) {
		if (status === "missing") value = "(no saved value)";
		else if (status === "error") value = `#ERROR ${text(row.cached_value) ?? ""}`.trim();
		else if (numeric !== undefined) value = String(numeric);
		else value = quote(text(row.cached_value) ?? "");
	} else if (numeric !== undefined) value = String(numeric);
	else if (valueType === "bool" || valueType === "datetime" || valueType === "date" || valueType === "time")
		value = text(row.raw_value) ?? text(row.display_value) ?? "";
	else value = quote(text(row.raw_value) ?? text(row.display_value) ?? "");

	const notes: string[] = [];
	const format = text(row.number_format);
	if (format && format !== "General") notes.push(`fmt=${format}`);
	if (isFormula && status && status !== "present") notes.push(`cache=${status}`);
	const formulaType = text(row.formula_type);
	if (isFormula && formulaType && formulaType !== "standard") notes.push(`formula_type=${formulaType}`);

	let metadata: Row | undefined;
	const metadataText = text(row.metadata_json);
	if (metadataText) {
		try {
			const parsed: unknown = JSON.parse(metadataText);
			if (object(parsed)) metadata = parsed;
		} catch {
			metadata = undefined;
		}
	}
	const flag = (key: string) => truthy(row[key]) || truthy(metadata?.[key]);
	if (flag("hidden_row")) notes.push("hidden_row");
	if (flag("hidden_column")) notes.push("hidden_col");
	const merged = text(row.merged_range) ?? text(metadata?.merged_range);
	if (merged) notes.push(`merged=${merged}`);
	if (flag("conditional_formatting")) notes.push("cond_fmt");
	const sheetState = text(row.sheet_state) ?? text(metadata?.sheet_state);
	if (sheetState && sheetState !== "visible") notes.push(`sheet=${sheetState}`);
	if (Array.isArray(row.matched_fields) && row.matched_fields.length)
		notes.push(`match=${row.matched_fields.map(String).join("+")}`);
	if (typeof row.depth === "number") notes.push(`depth=${row.depth}`);
	if (object(row.comment) && typeof row.comment.text === "string") {
		const author = text(row.comment.author);
		notes.push(`comment${author ? `(${clip(author, 40)})` : ""}=${quote(row.comment.text, MAX_COMMENT_CHARS)}`);
	}
	if (options.includeStyle) {
		const style = styleText(row.style);
		if (style) notes.push(style);
	}

	return {
		sheet: text(row.sheet_name) ?? "",
		ref: text(row.cell_ref) ?? "",
		value,
		formula: isFormula ? clip(text(row.formula) ?? "", MAX_FORMULA_CHARS) : "-",
		notes: notes.length ? notes.join(" ") : "-",
		evidenceId: options.includeEvidenceIds === false ? "" : (text(row.evidence_id) ?? ""),
	};
}

function cellLine(cell: NormalizedCell): string {
	const columns = [cell.ref, cell.value, cell.formula, cell.notes];
	if (cell.evidenceId) columns.push(cell.evidenceId);
	return columns.join("\t");
}

function cellLines(rows: Row[], options: WorkbookTextOptions): string[] {
	const lines: string[] = [];
	let currentSheet: string | undefined;
	for (const row of rows) {
		if (!object(row)) continue;
		const cell = normalizeCell(row, options);
		if (cell.sheet !== currentSheet) {
			currentSheet = cell.sheet;
			lines.push(`## ${cell.sheet}`);
		}
		lines.push(cellLine(cell));
	}
	return lines;
}

function columnsLegend(options: WorkbookTextOptions): string {
	const columns = ["cell", "saved value", "formula", "notes"];
	if (options.includeEvidenceIds !== false) columns.push("evidence_id");
	return `columns: ${columns.join(" ⇥ ")}. Text values are quoted; numbers are bare; formulas keep saved (not recalculated) values.`;
}

function headerFilename(result: Row, options: WorkbookTextOptions): string {
	const document = object(result.document) ? result.document : undefined;
	return (
		options.filename ??
		text(document?.filename) ??
		text(result.filename) ??
		text(result.original_filename) ??
		text(result.attachment_id) ??
		"workbook"
	);
}

function documentHeader(result: Row, options: WorkbookTextOptions): string {
	const document = object(result.document) ? result.document : undefined;
	const docId = options.docId ?? text(document?.doc_id) ?? text(result.doc_id) ?? text(result.attachment_id);
	const version = options.versionNo ?? document?.version_no ?? result.version_no;
	const parts = [headerFilename(result, options)];
	if (version !== undefined && version !== null) parts.push(`v${String(version)}`);
	if (docId) parts.push(`doc_id=${docId}`);
	return `# ${parts.join(" | ")}`;
}

function citationRule(options: WorkbookTextOptions, filename: string): string {
	if (options.includeEvidenceIds === false)
		return "evidence ids omitted to save context; before citing, re-read the decisive cells (ranges accepts scattered cells) with include_evidence_ids=true.";
	return `cite a cell as [${filename} <sheet>!<cell>](#pe-source?evidence_id=<evidence_id>); keep evidence_id verbatim.`;
}

interface BudgetedSection {
	/** Lines that are never cut (headers, footers). */
	head: string[];
	/** Paginated lines; the byte budget cuts here first. */
	body: string[];
	/** Count of body lines that represent cells/nodes rather than sheet separators. */
	isCellLine: (line: string) => boolean;
	tail: string[];
	offset?: number;
	/** Extra lines appended after body when the body was cut. */
	onTruncate: (shown: number, omitted: number, nextOffset: number | undefined) => string[];
}

function assemble(section: BudgetedSection, maxBytes: number): WorkbookTextResult {
	const fixed = [...section.head, ...section.tail];
	const fixedBytes = Buffer.byteLength(`${fixed.join("\n")}\n`) + 400; // room for the truncation notice
	let used = 0;
	let shown = 0;
	const body: string[] = [];
	let truncated = false;
	const total = section.body.filter(section.isCellLine).length;
	for (const line of section.body) {
		const bytes = Buffer.byteLength(line) + 1;
		if (fixedBytes + used + bytes > maxBytes) {
			truncated = true;
			break;
		}
		used += bytes;
		body.push(line);
		if (section.isCellLine(line)) shown++;
	}
	const omitted = total - shown;
	const nextOffset = truncated && section.offset !== undefined && omitted > 0 ? section.offset + shown : undefined;
	const lines = [...section.head, ...body];
	if (truncated) lines.push(...section.onTruncate(shown, omitted, nextOffset));
	lines.push(...section.tail);
	const output = lines.join("\n");
	return {
		text: output,
		summary: {
			bytes: Buffer.byteLength(output),
			truncated,
			shown_cells: shown,
			omitted_cells: omitted,
			...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
		},
	};
}

const isCellLine = (line: string) => !line.startsWith("## ");

/** `read` and `search` results: paginated cell lists. */
export function formatWorkbookCellsText(result: Row, options: WorkbookTextOptions = {}): WorkbookTextResult {
	const rows = Array.isArray(result.cells) ? (result.cells as Row[]) : [];
	const offset = typeof result.offset === "number" ? result.offset : 0;
	const filename = headerFilename(result, options);
	const head = [documentHeader(result, options)];
	const scope: string[] = [];
	const sheet = object(result.sheet) ? text(result.sheet.name) : text(result.sheet);
	const cellRange = text(result.cell_range);
	if (sheet && cellRange) scope.push(`range=${sheet}!${cellRange}`);
	else if (Array.isArray(result.requested_ranges) && result.requested_ranges.length)
		scope.push(
			`ranges=${(result.requested_ranges as Row[])
				.map((area) => `${text(area.sheet) ?? "?"}!${text(area.range) ?? "?"}`)
				.join(",")}`,
		);
	if (typeof result.query === "string") scope.push(`query=${quote(result.query, 100)}`);
	if (result.index_used === true) scope.push("via text index");
	if (scope.length) head.push(scope.join(" | "));
	const counts: string[] = [];
	if (typeof result.matching_cell_count === "number") counts.push(`matching=${result.matching_cell_count}`);
	counts.push(`returned=${rows.length}`, `offset=${offset}`);
	if (typeof result.next_offset === "number") counts.push(`next_offset=${result.next_offset}`);
	counts.push(`complete=${result.complete === true}`);
	if (typeof result.requested_cell_count === "number") counts.push(`requested=${result.requested_cell_count}`);
	if (typeof result.blank_cell_count === "number") counts.push(`blank=${result.blank_cell_count}`);
	head.push(`cells: ${counts.join(" ")}`);
	if (typeof result.next_offset === "number")
		head.push("unread cells are not blank; continue with offset=next_offset until complete.");
	head.push(columnsLegend(options));
	head.push(citationRule(options, filename));
	const tail: string[] = [];
	const contract = text(result.answer_contract) ?? text(result.calculationStatus);
	if (contract) tail.push(`note: ${contract}`);
	return assemble(
		{
			head,
			body: cellLines(rows, options),
			isCellLine,
			tail,
			offset,
			onTruncate: (shown, omitted, nextOffset) => [
				`[text budget] ${omitted} of ${rows.length} returned cells omitted here (showed ${shown}). They exist in the source and are not blank.${
					nextOffset !== undefined ? ` Continue with offset=${nextOffset}, or read a narrower range.` : ""
				}`,
			],
		},
		workbookTextBudget(options.maxBytes),
	);
}

function edgeLine(edge: Row): string {
	const source = `${text(edge.source_sheet) ?? ""}!${text(edge.source_cell_ref) ?? ""}`;
	const status = text(edge.parse_status) ?? "";
	const kind = text(edge.reference_kind) ?? "";
	let target: string;
	if (Array.isArray(edge.destinations) && edge.destinations.length) {
		target = (edge.destinations as unknown[])
			.map((entry) => (Array.isArray(entry) ? `${String(entry[0])}!${String(entry[1])}` : String(entry)))
			.join(",");
	} else if (text(edge.target_sheet) && text(edge.target_range))
		target = `${text(edge.target_sheet)}!${text(edge.target_range)}`;
	else target = text(edge.raw_reference) ?? "?";
	const extra: string[] = [];
	if (kind === "defined_name" && text(edge.defined_name)) extra.push(`name=${text(edge.defined_name)}`);
	if (text(edge.external_workbook)) extra.push(`external=[${text(edge.external_workbook)}]`);
	return `${source} -> ${target} [${kind}${status && status !== "resolved" ? `/${status}` : ""}]${
		extra.length ? ` ${extra.join(" ")}` : ""
	}`;
}

function issueLine(issue: Row): string {
	const reason = text(issue.reason) ?? text(issue.code) ?? "issue";
	if (Array.isArray(issue.cells))
		return `- ${reason}: ${(issue.cells as Row[]).map((cell) => `${text(cell.sheet)}!${text(cell.cell_ref)}`).join(" -> ")}`;
	const where =
		(text(issue.sheet) ?? text(issue.source_sheet))
			? `${text(issue.sheet) ?? text(issue.source_sheet)}!${text(issue.cell_ref) ?? text(issue.source_cell_ref) ?? ""}`
			: "";
	const detail = text(issue.reference) ?? text(issue.raw_reference) ?? text(issue.formula) ?? text(issue.status);
	return `- ${reason}${where ? ` ${where}` : ""}${detail ? `: ${clip(detail, 200)}` : ""}`;
}

/** `trace` results: nodes grouped by sheet, then edges, issues and pending work. */
export function formatWorkbookTraceText(result: Row, options: WorkbookTextOptions = {}): WorkbookTextResult {
	const nodes = Array.isArray(result.nodes) ? (result.nodes as Row[]) : [];
	const edges = Array.isArray(result.edges) ? (result.edges as Row[]) : [];
	const issues = Array.isArray(result.issues) ? (result.issues as Row[]) : [];
	const pendingRanges = Array.isArray(result.pending_ranges) ? (result.pending_ranges as Row[]) : [];
	const pendingReads = Array.isArray(result.pending_reads) ? (result.pending_reads as Row[]) : [];
	const filename = headerFilename(result, options);
	const head = [documentHeader(result, options)];
	const root = object(result.root) ? result.root : undefined;
	const roots =
		root && text(root.sheet_name)
			? [`${text(root.sheet_name)}!${text(root.cell_ref)}`]
			: Array.isArray(result.requested_ranges)
				? (result.requested_ranges as Row[]).map((area) => `${text(area.sheet)}!${text(area.range)}`)
				: [];
	head.push(
		`trace upstream from ${roots.join(",") || "?"}: nodes=${nodes.length} edges=${edges.length} issues=${issues.length} complete=${result.complete === true} truncated=${result.truncated === true} pending_ranges=${pendingRanges.length} pending_reads=${pendingReads.length}`,
	);
	head.push(columnsLegend(options));
	head.push(citationRule(options, filename));
	const sorted = [...nodes].sort((a, b) => {
		const depth = Number(a.depth ?? 0) - Number(b.depth ?? 0);
		if (depth !== 0) return depth;
		const sheet = String(a.sheet_name ?? "").localeCompare(String(b.sheet_name ?? ""));
		if (sheet !== 0) return sheet;
		return Number(a.row_index ?? 0) - Number(b.row_index ?? 0) || Number(a.col_index ?? 0) - Number(b.col_index ?? 0);
	});
	const body = ["# nodes (depth 0 = root)", ...cellLines(sorted, options)];
	const budget = workbookTextBudget(options.maxBytes);
	// Edges are structural and cheap to re-derive from formulas; when the budget is tight, cut edges before nodes.
	const edgeLines = edges.map(edgeLine);
	const nodeBytes = Buffer.byteLength([...head, ...body].join("\n"));
	const edgeBytes = Buffer.byteLength(edgeLines.join("\n"));
	let keptEdges = edgeLines;
	if (nodeBytes + edgeBytes > budget * 0.9 && edgeLines.length) {
		const allowance = Math.max(0, budget * 0.4);
		let used = 0;
		let keep = 0;
		for (const line of edgeLines) {
			used += Buffer.byteLength(line) + 1;
			if (used > allowance) break;
			keep++;
		}
		keptEdges = edgeLines.slice(0, Math.max(keep, Math.min(20, edgeLines.length)));
	}
	const tail: string[] = [`# edges (${edgeLines.length}) source -> target [kind/status]`, ...keptEdges];
	if (keptEdges.length < edgeLines.length)
		tail.push(
			`[text budget] ${edgeLines.length - keptEdges.length} edges omitted; trace a narrower cell to see them.`,
		);
	if (issues.length) tail.push("# issues", ...issues.map(issueLine));
	if (pendingRanges.length)
		tail.push(
			`# pending_ranges (not visited; raise max_depth/max_nodes or trace them directly): ${pendingRanges
				.slice(0, 40)
				.map((area) => `${text(area.sheet)}!${text(area.range)}@d${String(area.depth ?? "?")}`)
				.join(" ")}${pendingRanges.length > 40 ? ` …+${pendingRanges.length - 40}` : ""}`,
		);
	if (pendingReads.length)
		tail.push(
			`# pending_reads: ${pendingReads.length} range batch(es) exceeded max_nodes; read them with pe_excel_range offset=${pendingReads
				.map((read) => String(read.offset))
				.join(",")}`,
		);
	const contract = text(result.answer_contract);
	if (contract) tail.push(`note: ${contract}`);
	return assemble(
		{
			head,
			body,
			isCellLine: (line) => !line.startsWith("## ") && !line.startsWith("# "),
			tail,
			onTruncate: (shown, omitted) => [
				`[text budget] ${omitted} of ${nodes.length} traced nodes omitted here (showed ${shown}, root first by depth). Lower max_nodes/max_depth or trace an intermediate cell to see them.`,
			],
		},
		budget,
	);
}

function sheetSummaryLine(sheet: Row): string {
	const cache = object(sheet.formula_cache_status_counts)
		? Object.entries(sheet.formula_cache_status_counts)
				.map(([key, value]) => `${key}=${String(value)}`)
				.join(",")
		: "";
	const counts: string[] = [];
	for (const [key, label] of [
		["content_range_count", "ranges"],
		["comment_cells_count", "comments"],
		["hidden_rows_count", "hidden_rows"],
		["hidden_columns_count", "hidden_cols"],
		["merged_ranges_count", "merged"],
		["tables_count", "tables"],
		["drawings_count", "drawings"],
	] as const) {
		const value = sheet[key];
		if (typeof value === "number" && value > 0) counts.push(`${label}=${value}`);
	}
	return [
		String(sheet.sheet_index ?? sheet.index ?? "?"),
		quote(String(sheet.sheet_name ?? sheet.name ?? ""), 80),
		String(sheet.sheet_state ?? sheet.state ?? "visible"),
		String(sheet.used_range || "empty"),
		`cells=${String(sheet.non_empty_cell_count ?? 0)}`,
		`formulas=${String(sheet.formula_count ?? 0)}`,
		...(Number(sheet.error_cell_count ?? 0) > 0 ? [`errors=${String(sheet.error_cell_count)}`] : []),
		...(cache ? [`cache:${cache}`] : []),
		...counts,
	].join(" ");
}

function inspectPageLines(page: Row): string[] {
	const lines: string[] = [];
	const section = text(page.section) ?? "sheets";
	const scope: string[] = [`section=${section}`];
	if (object(page.sheet) && text(page.sheet.sheet_name))
		scope.push(`sheet=${quote(String(page.sheet.sheet_name), 80)}`);
	if (typeof page.matching_item_count === "number") scope.push(`matching=${page.matching_item_count}`);
	if (typeof page.offset === "number") scope.push(`offset=${page.offset}`);
	if (typeof page.next_offset === "number") scope.push(`next_offset=${page.next_offset}`);
	scope.push(`complete=${page.complete !== false}`);
	lines.push(scope.join(" "));
	const stats: string[] = [];
	for (const [key, label] of [
		["sheet_count", "sheets"],
		["non_empty_cell_count", "cells"],
		["formula_count", "formulas"],
		["error_cell_count", "error_cells"],
		["external_link_count", "external_links"],
		["defined_name_count", "defined_names"],
	] as const)
		if (typeof page[key] === "number") stats.push(`${label}=${String(page[key])}`);
	if (object(page.formula_cache_status_counts))
		stats.push(
			`cache:${Object.entries(page.formula_cache_status_counts)
				.map(([key, value]) => `${key}=${String(value)}`)
				.join(",")}`,
		);
	if (object(page.calculation) && Object.keys(page.calculation).length)
		stats.push(`calcPr=${JSON.stringify(page.calculation)}`);
	if (stats.length) lines.push(`workbook: ${stats.join(" ")}`);
	if (object(page.sheet)) {
		const sheet = page.sheet;
		lines.push(`sheet: ${sheetSummaryLine(sheet)}${object(sheet.pane) ? ` pane=${JSON.stringify(sheet.pane)}` : ""}`);
	}
	const items = page[section];
	if (section === "sheets" && Array.isArray(items)) {
		lines.push("sheets: index name state used_range cells formulas [errors] cache counts");
		for (const sheet of items as Row[]) lines.push(sheetSummaryLine(sheet));
	} else if (Array.isArray(items)) {
		lines.push(`${section} (${items.length}):`);
		for (const item of items as unknown[]) {
			if (section === "defined_names" && object(item))
				lines.push(
					`${quote(String(item.name ?? ""), 80)} scope=${String(item.scope_sheet ?? "workbook")}${item.hidden ? " hidden" : ""} = ${clip(String(item.attr_text ?? ""), 200)}`,
				);
			else if (section === "external_links" && object(item)) {
				const sources = Array.isArray(item.sources)
					? (item.sources as Row[]).map((source) => text(source.target) ?? "").join(",")
					: "";
				lines.push(`[${String(item.index)}] ${clip(sources, 300)}`);
			} else if (section === "comment_cells" && object(item)) lines.push(JSON.stringify(item));
			else lines.push(typeof item === "string" ? item : JSON.stringify(item));
		}
	}
	return lines;
}

/** `inspect` results, either one reader page or the project-level pe_workbook_inspect envelope. */
export function formatWorkbookInspectText(result: Row, options: WorkbookTextOptions = {}): WorkbookTextResult {
	const head: string[] = [];
	const body: string[] = [];
	if (Array.isArray(result.workbooks)) {
		head.push(
			`# workbooks: active=${String(result.active_workbook_count ?? result.workbooks.length)} selection_required=${result.selection_required === true}${
				text(result.selected_doc_id) ? ` selected_doc_id=${text(result.selected_doc_id)}` : ""
			}`,
		);
		if (Array.isArray(result.warnings) && result.warnings.length)
			head.push(`warnings: ${(result.warnings as unknown[]).map(String).join(" | ")}`);
		for (const workbook of result.workbooks as Row[]) {
			body.push(
				`# ${text(workbook.filename) ?? "workbook"} | v${String(workbook.version_no ?? "?")} | doc_id=${text(workbook.doc_id) ?? "?"}${
					text(workbook.status) ? ` | status=${text(workbook.status)}` : ""
				}`,
			);
			if (workbook.section !== undefined || workbook.sheets !== undefined) body.push(...inspectPageLines(workbook));
			else if (typeof workbook.sheet_count === "number")
				body.push(`sheets=${workbook.sheet_count} (inspect with doc_id for detail)`);
		}
	} else {
		head.push(documentHeader(result, options));
		body.push(...inspectPageLines(result));
	}
	const tail: string[] = [];
	const contract = text(result.answer_contract) ?? text(result.calculationStatus);
	if (contract) tail.push(`note: ${contract}`);
	return assemble(
		{
			head,
			body,
			isCellLine: (line) => !line.startsWith("# "),
			tail,
			onTruncate: (_shown, omitted) => [
				`[text budget] ${omitted} navigation lines omitted; request a smaller limit or one section/sheet at a time.`,
			],
		},
		workbookTextBudget(options.maxBytes),
	);
}

/** Dispatch on the reader result shape; unknown shapes fall back to budgeted JSON lines. */
export function formatWorkbookResultText(result: Row, options: WorkbookTextOptions = {}): WorkbookTextResult {
	if (Array.isArray(result.nodes) && Array.isArray(result.edges)) return formatWorkbookTraceText(result, options);
	if (Array.isArray(result.cells)) return formatWorkbookCellsText(result, options);
	if (Array.isArray(result.workbooks) || typeof result.section === "string" || Array.isArray(result.sheets))
		return formatWorkbookInspectText(result, options);
	const { image: _image, ...rest } = result;
	const budget = workbookTextBudget(options.maxBytes);
	const serialized = JSON.stringify(rest);
	const truncated = Buffer.byteLength(serialized) > budget;
	const output = truncated ? `${clip(serialized, budget - 64)}\n[text budget] JSON truncated` : serialized;
	return {
		text: output,
		summary: { bytes: Buffer.byteLength(output), truncated, shown_cells: 0, omitted_cells: 0 },
	};
}
