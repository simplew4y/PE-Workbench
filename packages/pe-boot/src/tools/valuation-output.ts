import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { normalizeText, numberValue, openPeDataset, type SqlRow, sourceFilename, textValue } from "./database.ts";
import {
	type ExcelCellDetail,
	excelCellDetail,
	parseExcelCellRange,
	readExcelCellsByBounds,
	readExcelCellsInRange,
} from "./excel-cells.ts";
import { formulaTraceIsStructurallyComplete, type PeFormulaTraceResult, tracePeFormula } from "./formula-trace.ts";

const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 25;
const MAX_MATCHING_CELLS = 2_000;
const MAX_RAW_CANDIDATES = 500;
const MAX_TRACED_CANDIDATES = 100;
const MIN_AUTO_SELECTION_SCORE = 0.62;
const AMBIGUITY_SCORE_DELTA = 0.08;

const MATCH_QUERY_TERMS = [
	"target price",
	"price target",
	"target_price",
	"target-price",
	"target px",
	"price objective",
	"implied share",
	"implied price",
	"per share value",
	"value per share",
	"fair value",
	"intrinsic value",
	"equity value",
	"implied equity",
	"market cap",
	"market capitalization",
	"enterprise value",
	"implied ev",
	"dcf",
	"discounted cash flow",
	"sotp",
	"sum of the parts",
	"sum of parts",
	"valuation result",
	"valuation output",
	"current price",
	"share price",
	"stock price",
	"spot price",
	"last price",
	"closing price",
	"last close",
	"upside",
	"downside",
	"return potential",
	"目标价",
	"目标价格",
	"目标股价",
	"每股价值",
	"每股估值",
	"合理股价",
	"隐含股价",
	"隐含每股价值",
	"合理价值",
	"公允价值",
	"股权价值",
	"权益价值",
	"隐含市值",
	"企业价值",
	"折现现金流",
	"分部估值",
	"分部加总价值",
	"估值结果",
	"当前价",
	"当前股价",
	"现价",
	"市价",
	"收盘价",
	"上涨空间",
	"下跌空间",
	"潜在涨幅",
	"收益空间",
] as const;

export const PE_VALUATION_OUTPUT_PROMPT_SNIPPET =
	"Locate and rank valuation-output cells in one selected Excel workbook using deterministic labels, units, periods, formula lineage, cross-checks, sheet context, and date proximity";

export type PeValuationOutputRole =
	| "target_price"
	| "per_share_value"
	| "enterprise_value"
	| "equity_value"
	| "dcf_value"
	| "sotp_value"
	| "relative_valuation_output";

type CrossCheckRole = "current_price" | "upside";
type RecognizedRole = PeValuationOutputRole | CrossCheckRole;

interface LabelRule {
	role: RecognizedRole;
	phrases: readonly string[];
	baseWeight: number;
}

const LABEL_RULES: readonly LabelRule[] = [
	{
		role: "target_price",
		phrases: [
			"target price",
			"price target",
			"target share price",
			"target px",
			"price objective",
			"目标价",
			"目标价格",
			"目标股价",
		],
		baseWeight: 0.48,
	},
	{
		role: "per_share_value",
		phrases: [
			"implied share price",
			"implied stock price",
			"implied price",
			"implied price per share",
			"fair value per share",
			"intrinsic value per share",
			"equity value per share",
			"per share value",
			"value per share",
			"每股价值",
			"每股估值",
			"合理股价",
			"隐含股价",
			"隐含每股价值",
			"每股公允价值",
			"每股合理价值",
		],
		baseWeight: 0.46,
	},
	{
		role: "dcf_value",
		phrases: [
			"dcf value",
			"dcf valuation",
			"discounted cash flow value",
			"discounted cash flow valuation",
			"dcf 估值",
			"现金流折现价值",
			"折现现金流估值",
		],
		baseWeight: 0.39,
	},
	{
		role: "sotp_value",
		phrases: [
			"sotp value",
			"sotp valuation",
			"sum of the parts value",
			"sum of parts value",
			"分部估值",
			"分部价值",
			"分部加总价值",
		],
		baseWeight: 0.39,
	},
	{
		role: "equity_value",
		phrases: [
			"equity value",
			"value of equity",
			"market value of equity",
			"implied equity",
			"implied market cap",
			"market capitalization",
			"股权价值",
			"权益价值",
			"隐含市值",
		],
		baseWeight: 0.36,
	},
	{
		role: "enterprise_value",
		phrases: ["enterprise value", "implied enterprise value", "implied ev", "企业价值"],
		baseWeight: 0.34,
	},
	{
		role: "relative_valuation_output",
		phrases: [
			"valuation result",
			"valuation output",
			"implied value",
			"fair value",
			"intrinsic value",
			"估值结果",
			"合理价值",
			"公允价值",
		],
		baseWeight: 0.3,
	},
	{
		role: "current_price",
		phrases: [
			"current price",
			"current share price",
			"share price",
			"stock price",
			"spot price",
			"last price",
			"closing price",
			"last close",
			"当前价",
			"当前股价",
			"现价",
			"市价",
			"收盘价",
		],
		baseWeight: 0.32,
	},
	{
		role: "upside",
		phrases: [
			"upside potential",
			"downside potential",
			"return potential",
			"upside",
			"downside",
			"上涨空间",
			"下跌空间",
			"潜在涨幅",
			"收益空间",
			"上行空间",
		],
		baseWeight: 0.32,
	},
] as const;

const PRIMARY_OUTPUT_ROLES = new Set<RecognizedRole>([
	"target_price",
	"per_share_value",
	"enterprise_value",
	"equity_value",
	"dcf_value",
	"sotp_value",
	"relative_valuation_output",
]);

interface LabelMatch {
	role: RecognizedRole;
	label: string;
	normalizedLabel: string;
	matchedPhrase: string;
	baseWeight: number;
	exact: boolean;
}

type LabelSource =
	| "row_label"
	| "column_label"
	| "cell_text"
	| "right_of_label"
	| "left_of_label"
	| "below_label"
	| "defined_name"
	| "upside_formula_counterpart";

interface SeedMatch extends LabelMatch {
	labelSource: LabelSource;
	sourceWeight: number;
	labelCellRef?: string;
	labelEvidenceId?: string;
	labelCitation?: string;
	labelMarkdownCitation?: string;
	definedName?: string;
}

interface SheetContext {
	index: number;
	name: string;
	role: string;
	state: string;
}

interface CandidateSeed {
	cell: ExcelCellDetail;
	sheet: SheetContext;
	matches: SeedMatch[];
}

interface DateCandidateLink {
	candidate_id: string;
	role: string;
	normalized_date?: string;
	distance: number;
	confidence: number;
}

interface UpsideLink {
	upside_cell_id: string;
	upside_sheet: string;
	upside_cell_ref: string;
	current_price_cell_ids: string[];
	calculated_upside?: number;
	reported_upside?: number;
	consistent?: boolean;
}

interface ScoreFeature {
	code: string;
	weight: number;
	detail: string;
}

interface FormulaTraceSummary {
	structurally_complete: boolean;
	node_count: number;
	edge_count: number;
	issue_codes: string[];
}

export interface ValuationOutputCandidate {
	candidate_id: string;
	semantic_role: PeValuationOutputRole;
	rank: number;
	score: number;
	confidence: number;
	sheet_name: string;
	cell_ref: string;
	sheet_role: string;
	sheet_state: string;
	label: string;
	label_source: LabelSource;
	matched_phrase: string;
	label_cell_refs: string[];
	defined_names: string[];
	evidence_ids: string[];
	citations: string[];
	markdown_citations: string[];
	display_value?: string;
	numeric_value?: number;
	formula?: string;
	cached_value?: string;
	formula_cache_status?: string;
	number_format?: string;
	unit?: string;
	period?: string;
	direct_downstream_formula_count: number;
	referenced_by_upside: boolean;
	upside_links: UpsideLink[];
	date_context: DateCandidateLink[];
	formula_trace?: FormulaTraceSummary;
	features: ScoreFeature[];
	warnings: string[];
}

export interface PeValuationOutputOptions {
	docId: string;
	datasetId?: string;
	sheetName?: string;
	topK?: number;
}

export interface PeValuationOutputConfirmation {
	confirmed: boolean;
	candidate_id: string;
	semantic_role?: PeValuationOutputRole;
	label?: string;
	rejection_reason?: string;
}

export interface PeValuationOutputResult {
	schema_version: "1.0";
	dataset_id: string;
	locator_run_id: string;
	document: {
		doc_id: string;
		filename: string;
		version_no?: number;
		document_date?: string;
	};
	status: "selected" | "ambiguous" | "missing";
	selection_method: "explainable_rule_score";
	selected_candidate_id?: string;
	selected_output?: {
		candidate_id: string;
		semantic_role: PeValuationOutputRole;
		sheet_name: string;
		cell_ref: string;
		score: number;
		evidence_id: string;
		markdown_citation: string;
	};
	conflicting_candidate_ids: string[];
	conflicting_outputs: Array<{
		candidate_id: string;
		semantic_role: PeValuationOutputRole;
		sheet_name: string;
		cell_ref: string;
		score: number;
		evidence_id: string;
		markdown_citation: string;
	}>;
	candidate_count: number;
	evaluated_candidate_count: number;
	returned_candidate_count: number;
	cross_check_nodes: Array<{
		role: CrossCheckRole;
		sheet_name: string;
		cell_ref: string;
		label: string;
		display_value?: string;
		numeric_value?: number;
		formula?: string;
		evidence_id: string;
		markdown_citation: string;
	}>;
	warnings: string[];
	candidates: ValuationOutputCandidate[];
	answer_contract: string;
}

function tableExists(database: DatabaseSync, table: string): boolean {
	return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function jsonObjectValue(row: SqlRow, key: string): Record<string, unknown> | undefined {
	const value = textValue(row, key);
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function normalizedLabel(value: unknown): string {
	return normalizeText(value)
		.toLocaleLowerCase()
		.replace(/[_.\-/:：()（）[\]]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function classifyLabel(value: unknown): LabelMatch | undefined {
	const label = normalizeText(value);
	const normalized = normalizedLabel(label);
	if (!normalized) return undefined;
	let best: LabelMatch | undefined;
	for (const rule of LABEL_RULES) {
		for (const phrase of rule.phrases) {
			const normalizedPhrase = normalizedLabel(phrase);
			if (!normalized.includes(normalizedPhrase)) continue;
			const exact = normalized === normalizedPhrase;
			const candidate: LabelMatch = {
				role: rule.role,
				label,
				normalizedLabel: normalized,
				matchedPhrase: phrase,
				baseWeight: rule.baseWeight + (exact ? 0.03 : 0),
				exact,
			};
			if (!best || candidate.baseWeight > best.baseWeight) best = candidate;
		}
	}
	return best;
}

function isPrimaryRole(role: RecognizedRole): role is PeValuationOutputRole {
	return PRIMARY_OUTPUT_ROLES.has(role);
}

function hasOutputValue(cell: Pick<ExcelCellDetail, "display_value" | "formula" | "numeric_value">): boolean {
	if (cell.numeric_value !== undefined || cell.formula !== undefined) return true;
	return /^\(?[-+]?[$¥€£]?\s*\d[\d,.]*(?:\.\d+)?\s*%?\)?$/u.test(normalizeText(cell.display_value));
}

function canonicalSingleCellRef(value: string): string | undefined {
	const normalized = value.trim().replaceAll("$", "").toUpperCase();
	const bounds = parseExcelCellRange(normalized);
	if (!bounds || bounds.rowStart !== bounds.rowEnd || bounds.columnStart !== bounds.columnEnd) return undefined;
	return /^[A-Z]{1,3}[1-9]\d*$/u.test(normalized) ? normalized : undefined;
}

export function valuationOutputCandidateId(docId: string, sheetName: string, cellRef: string): string {
	return createHash("sha256")
		.update(`${docId}\0valuation_output\0${sheetName.toLocaleLowerCase()}\0${cellRef.toUpperCase()}`)
		.digest("hex")
		.slice(0, 40);
}

function uniqueValues(values: readonly (string | undefined)[]): string[] {
	return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function directCellMatches(cell: ExcelCellDetail): SeedMatch[] {
	const values: Array<{ value: string | undefined; labelSource: LabelSource; sourceWeight: number }> = [
		{ value: cell.row_label, labelSource: "row_label", sourceWeight: 0.1 },
		{ value: cell.col_label, labelSource: "column_label", sourceWeight: 0.07 },
		{ value: cell.display_value, labelSource: "cell_text", sourceWeight: 0.04 },
	];
	const matches: SeedMatch[] = [];
	for (const value of values) {
		const match = classifyLabel(value.value);
		if (match) matches.push({ ...match, labelSource: value.labelSource, sourceWeight: value.sourceWeight });
	}
	return matches;
}

function addSeed(map: Map<string, CandidateSeed>, cell: ExcelCellDetail, sheet: SheetContext, match: SeedMatch): void {
	if (!hasOutputValue(cell)) return;
	const existing = map.get(cell.cell_id);
	if (existing) {
		const key = [match.role, match.labelSource, match.labelCellRef, match.definedName].join("\0");
		if (
			!existing.matches.some(
				(item) => [item.role, item.labelSource, item.labelCellRef, item.definedName].join("\0") === key,
			)
		) {
			existing.matches.push(match);
		}
		return;
	}
	map.set(cell.cell_id, { cell, sheet, matches: [match] });
}

function bestMatch(seed: CandidateSeed): SeedMatch {
	return [...seed.matches].sort(
		(left, right) =>
			right.baseWeight + right.sourceWeight - (left.baseWeight + left.sourceWeight) ||
			left.role.localeCompare(right.role) ||
			left.labelSource.localeCompare(right.labelSource),
	)[0];
}

function readMatchingCells(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	sheetName: string | undefined,
): { cells: ExcelCellDetail[]; truncated: boolean } {
	const searchText = `lower(
		COALESCE(c.display_value, '') || ' ' ||
		CASE WHEN c.is_formula = 0 THEN COALESCE(c.raw_value, '') ELSE '' END || ' ' ||
		COALESCE(c.row_label, '') || ' ' || COALESCE(c.col_label, '')
	)`;
	const sheetFilter = sheetName ? "AND lower(c.sheet_name) = lower(?)" : "";
	const markerFilter = MATCH_QUERY_TERMS.map(() => "instr(search_text, ?) > 0").join(" OR ");
	const rows = database
		.prepare(
			`SELECT * FROM (
				SELECT c.*, c.cell_ref AS cell_range,
				       d.original_filename, d.source_relpath, d.file_type, d.doc_type,
				       d.document_date, d.version_no,
				       ${searchText} AS search_text
				FROM excel_cells c
				JOIN documents d ON d.doc_id = c.doc_id AND d.dataset_id = c.dataset_id
				WHERE c.dataset_id = ? AND c.doc_id = ? ${sheetFilter}
			) matched
			WHERE ${markerFilter}
			ORDER BY sheet_name, row_index, col_index
			LIMIT ?`,
		)
		.all(
			datasetId,
			docId,
			...(sheetName ? [sheetName] : []),
			...MATCH_QUERY_TERMS,
			MAX_MATCHING_CELLS + 1,
		) as SqlRow[];
	return {
		cells: rows.slice(0, MAX_MATCHING_CELLS).map(excelCellDetail),
		truncated: rows.length > MAX_MATCHING_CELLS,
	};
}

function adjacentLabelMatch(match: LabelMatch, anchor: ExcelCellDetail, cell: ExcelCellDetail): SeedMatch | undefined {
	const rowDistance = cell.row_index - anchor.row_index;
	const columnDistance = cell.col_index - anchor.col_index;
	let labelSource: LabelSource | undefined;
	let sourceWeight = 0;
	if (rowDistance === 0 && columnDistance >= 1 && columnDistance <= 8) {
		labelSource = "right_of_label";
		sourceWeight = Math.max(0.03, 0.11 - (columnDistance - 1) * 0.012);
	} else if (rowDistance === 0 && columnDistance >= -2 && columnDistance <= -1) {
		labelSource = "left_of_label";
		sourceWeight = 0.04;
	} else if (columnDistance === 0 && rowDistance >= 1 && rowDistance <= 5) {
		labelSource = "below_label";
		sourceWeight = Math.max(0.03, 0.08 - (rowDistance - 1) * 0.01);
	}
	if (!labelSource) return undefined;
	return {
		...match,
		labelSource,
		sourceWeight,
		labelCellRef: anchor.cell_ref,
		labelEvidenceId: anchor.evidence_id,
		labelCitation: anchor.citation,
		labelMarkdownCitation: anchor.markdown_citation,
	};
}

function collectSeeds(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	matchingCells: readonly ExcelCellDetail[],
	sheets: ReadonlyMap<string, SheetContext>,
): { primary: Map<string, CandidateSeed>; crossChecks: Map<string, CandidateSeed> } {
	const primary = new Map<string, CandidateSeed>();
	const crossChecks = new Map<string, CandidateSeed>();
	for (const cell of matchingCells) {
		const sheet = sheets.get(cell.sheet_name.toLocaleLowerCase());
		if (!sheet) continue;
		for (const match of directCellMatches(cell)) {
			addSeed(isPrimaryRole(match.role) ? primary : crossChecks, cell, sheet, match);
		}
		const anchorValues = uniqueValues(cell.is_formula ? [cell.display_value] : [cell.display_value, cell.raw_value]);
		for (const anchorValue of anchorValues) {
			const anchorMatch = classifyLabel(anchorValue);
			if (!anchorMatch) continue;
			const nearbyCells = readExcelCellsByBounds(
				database,
				datasetId,
				docId,
				cell.sheet_name,
				{
					rowStart: cell.row_index,
					columnStart: Math.max(1, cell.col_index - 2),
					rowEnd: cell.row_index + 5,
					columnEnd: Math.min(16_384, cell.col_index + 8),
				},
				100,
			);
			for (const nearbyCell of nearbyCells) {
				if (nearbyCell.cell_id === cell.cell_id) continue;
				const adjacentMatch = adjacentLabelMatch(anchorMatch, cell, nearbyCell);
				if (!adjacentMatch) continue;
				addSeed(isPrimaryRole(adjacentMatch.role) ? primary : crossChecks, nearbyCell, sheet, adjacentMatch);
			}
		}
	}
	return { primary, crossChecks };
}

function definedNameDestinations(row: SqlRow): Array<{ sheetName: string; cellRef: string }> {
	const metadata = jsonObjectValue(row, "metadata_json");
	const destinations = metadata?.destinations;
	if (!Array.isArray(destinations)) return [];
	const result: Array<{ sheetName: string; cellRef: string }> = [];
	for (const destination of destinations) {
		if (!Array.isArray(destination) || destination.length < 2) continue;
		const [sheetName, targetRange] = destination;
		if (typeof sheetName !== "string" || typeof targetRange !== "string") continue;
		const cellRef = canonicalSingleCellRef(targetRange);
		if (cellRef) result.push({ sheetName, cellRef });
	}
	return result;
}

function addDefinedNameSeeds(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	sheets: ReadonlyMap<string, SheetContext>,
	requestedSheetName: string | undefined,
	primary: Map<string, CandidateSeed>,
	crossChecks: Map<string, CandidateSeed>,
): void {
	if (!tableExists(database, "excel_defined_names")) return;
	const rows = database
		.prepare(
			`SELECT name, scope_sheet, metadata_json
			 FROM excel_defined_names
			 WHERE dataset_id = ? AND doc_id = ?
			 ORDER BY name, scope_sheet`,
		)
		.all(datasetId, docId) as SqlRow[];
	for (const row of rows) {
		const name = textValue(row, "name");
		const match = classifyLabel(name);
		if (!name || !match) continue;
		for (const destination of definedNameDestinations(row)) {
			const sheet = sheets.get(destination.sheetName.toLocaleLowerCase());
			if (!sheet) continue;
			if (requestedSheetName && sheet.name.toLocaleLowerCase() !== requestedSheetName.toLocaleLowerCase()) continue;
			const [cell] = readExcelCellsInRange(database, datasetId, docId, sheet.name, destination.cellRef, 1);
			if (!cell) continue;
			addSeed(isPrimaryRole(match.role) ? primary : crossChecks, cell, sheet, {
				...match,
				labelSource: "defined_name",
				sourceWeight: 0.12,
				definedName: name,
			});
		}
	}
}

function formulaTargetCells(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	source: ExcelCellDetail,
	sheets: ReadonlyMap<string, SheetContext>,
): ExcelCellDetail[] {
	const rows = database
		.prepare(
			`SELECT target_sheet, target_range
			 FROM excel_formula_references
			 WHERE dataset_id = ? AND doc_id = ? AND source_sheet = ? AND source_cell_ref = ?
			   AND parse_status = 'resolved'
			 ORDER BY reference_index`,
		)
		.all(datasetId, docId, source.sheet_name, source.cell_ref) as SqlRow[];
	const targets = new Map<string, ExcelCellDetail>();
	for (const row of rows) {
		const requestedSheet = textValue(row, "target_sheet");
		const targetRange = textValue(row, "target_range");
		const sheet = requestedSheet ? sheets.get(requestedSheet.toLocaleLowerCase()) : undefined;
		if (!sheet || !targetRange || !parseExcelCellRange(targetRange)) continue;
		for (const cell of readExcelCellsInRange(database, datasetId, docId, sheet.name, targetRange, 50)) {
			targets.set(cell.cell_id, cell);
		}
	}
	return [...targets.values()];
}

function primaryDirectMatch(cell: ExcelCellDetail): SeedMatch | undefined {
	return directCellMatches(cell)
		.filter((match) => isPrimaryRole(match.role))
		.sort(
			(left, right) =>
				right.baseWeight + right.sourceWeight - (left.baseWeight + left.sourceWeight) ||
				left.role.localeCompare(right.role),
		)[0];
}

function currentPriceDirectMatch(cell: ExcelCellDetail): SeedMatch | undefined {
	return directCellMatches(cell)
		.filter((match) => match.role === "current_price")
		.sort((left, right) => right.baseWeight + right.sourceWeight - (left.baseWeight + left.sourceWeight))[0];
}

function addUpsideFormulaRelationships(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	sheets: ReadonlyMap<string, SheetContext>,
	requestedSheetName: string | undefined,
	primary: Map<string, CandidateSeed>,
	crossChecks: Map<string, CandidateSeed>,
): Map<string, UpsideLink[]> {
	const linksByTargetCellId = new Map<string, UpsideLink[]>();
	for (const upsideSeed of crossChecks.values()) {
		if (bestMatch(upsideSeed).role !== "upside" || !upsideSeed.cell.formula) continue;
		const targets = formulaTargetCells(database, datasetId, docId, upsideSeed.cell, sheets).filter(
			(cell) =>
				!requestedSheetName || cell.sheet_name.toLocaleLowerCase() === requestedSheetName.toLocaleLowerCase(),
		);
		const currentPriceTargets = targets.filter((cell) => {
			const existing = crossChecks.get(cell.cell_id);
			return (
				currentPriceDirectMatch(cell) !== undefined || (existing && bestMatch(existing).role === "current_price")
			);
		});
		const explicitOutputTargets = targets.filter(
			(cell) => primaryDirectMatch(cell) !== undefined || primary.has(cell.cell_id),
		);
		for (const cell of currentPriceTargets) {
			const match = currentPriceDirectMatch(cell);
			const sheet = sheets.get(cell.sheet_name.toLocaleLowerCase());
			if (match && sheet) addSeed(crossChecks, cell, sheet, match);
		}
		const derivedOutputTargets =
			explicitOutputTargets.length === 0 && currentPriceTargets.length === 1
				? targets.filter(
						(cell) =>
							cell.cell_id !== currentPriceTargets[0].cell_id &&
							hasOutputValue(cell) &&
							!normalizeText(cell.number_format).includes("%"),
					)
				: [];
		const outputTargets = explicitOutputTargets.length > 0 ? explicitOutputTargets : derivedOutputTargets;
		if (derivedOutputTargets.length !== 1 && explicitOutputTargets.length === 0) continue;
		for (const target of outputTargets) {
			const sheet = sheets.get(target.sheet_name.toLocaleLowerCase());
			if (!sheet) continue;
			const existingPrimary = primary.get(target.cell_id);
			const match = primaryDirectMatch(target) ??
				(existingPrimary ? bestMatch(existingPrimary) : undefined) ?? {
					role: "target_price" as const,
					label: "Derived target-price counterpart in upside formula",
					normalizedLabel: "derived target price counterpart in upside formula",
					matchedPhrase: "upside formula counterpart",
					baseWeight: 0.2,
					exact: false,
					labelSource: "upside_formula_counterpart" as const,
					sourceWeight: 0,
				};
			addSeed(primary, target, sheet, match);
			const currentPrice = currentPriceTargets.length === 1 ? currentPriceTargets[0] : undefined;
			const targetValue = target.numeric_value;
			const currentPriceValue = currentPrice?.numeric_value;
			const reportedUpside = upsideSeed.cell.numeric_value;
			const calculatedUpside =
				targetValue !== undefined && currentPriceValue !== undefined && currentPriceValue !== 0
					? targetValue / currentPriceValue - 1
					: undefined;
			const consistent =
				calculatedUpside !== undefined && reportedUpside !== undefined
					? Math.abs(calculatedUpside - reportedUpside) <= 0.02
					: undefined;
			const link: UpsideLink = {
				upside_cell_id: upsideSeed.cell.cell_id,
				upside_sheet: upsideSeed.cell.sheet_name,
				upside_cell_ref: upsideSeed.cell.cell_ref,
				current_price_cell_ids: currentPriceTargets.map((cell) => cell.cell_id),
				...(calculatedUpside !== undefined ? { calculated_upside: calculatedUpside } : {}),
				...(reportedUpside !== undefined ? { reported_upside: reportedUpside } : {}),
				...(consistent !== undefined ? { consistent } : {}),
			};
			const existing = linksByTargetCellId.get(target.cell_id);
			if (existing) existing.push(link);
			else linksByTargetCellId.set(target.cell_id, [link]);
		}
	}
	return linksByTargetCellId;
}

function directDownstreamFormulaCount(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	cell: ExcelCellDetail,
): number {
	const row = database
		.prepare(
			`SELECT COUNT(DISTINCT source_cell_id) AS formula_count
			 FROM excel_formula_references
			 WHERE dataset_id = ? AND doc_id = ? AND lower(target_sheet) = lower(?)
			   AND replace(target_range, '$', '') = ? AND parse_status = 'resolved'`,
		)
		.get(datasetId, docId, cell.sheet_name, cell.cell_ref) as SqlRow;
	return numberValue(row, "formula_count") ?? 0;
}

function readDateLinks(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	cell: ExcelCellDetail,
): DateCandidateLink[] {
	if (!tableExists(database, "valuation_date_candidates")) return [];
	const rows = database
		.prepare(
			`SELECT candidate_id, role, normalized_date, row_index, col_index, confidence
			 FROM valuation_date_candidates
			 WHERE dataset_id = ? AND doc_id = ? AND lower(sheet_name) = lower(?)
			   AND normalized_date IS NOT NULL AND is_forecast = 0
			   AND role IN ('valuation_date', 'market_price_date')`,
		)
		.all(datasetId, docId, cell.sheet_name) as SqlRow[];
	const links: DateCandidateLink[] = [];
	for (const row of rows) {
		const rowIndex = numberValue(row, "row_index");
		const columnIndex = numberValue(row, "col_index");
		if (rowIndex === undefined || columnIndex === undefined) continue;
		const rowDistance = Math.abs(cell.row_index - rowIndex);
		const columnDistance = Math.abs(cell.col_index - columnIndex);
		const near =
			(rowDistance === 0 && columnDistance <= 8) ||
			(columnDistance === 0 && rowDistance <= 10) ||
			(rowDistance <= 8 && columnDistance <= 4 && rowDistance + columnDistance <= 10);
		if (!near) continue;
		links.push({
			candidate_id: textValue(row, "candidate_id") ?? "",
			role: textValue(row, "role") ?? "unknown",
			...(textValue(row, "normalized_date") ? { normalized_date: textValue(row, "normalized_date") } : {}),
			distance: rowDistance + columnDistance,
			confidence: numberValue(row, "confidence") ?? 0,
		});
	}
	return links.sort(
		(left, right) =>
			left.distance - right.distance ||
			right.confidence - left.confidence ||
			left.candidate_id.localeCompare(right.candidate_id),
	);
}

function includesAny(text: string, markers: readonly string[]): boolean {
	return markers.some((marker) => text.includes(marker));
}

function formulaTraceSummary(trace: PeFormulaTraceResult): FormulaTraceSummary {
	return {
		structurally_complete: formulaTraceIsStructurallyComplete(trace),
		node_count: trace.node_count,
		edge_count: trace.edge_count,
		issue_codes: uniqueValues(trace.issues.map((issue) => issue.code)),
	};
}

function addFeature(features: ScoreFeature[], code: string, weight: number, detail: string): void {
	features.push({ code, weight, detail });
}

function scoreSeed(
	docId: string,
	seed: CandidateSeed,
	formulaGraphAvailable: boolean,
	directDownstreamCount: number,
	upsideLinks: readonly UpsideLink[],
	dateLinks: readonly DateCandidateLink[],
	trace: PeFormulaTraceResult | undefined,
): Omit<ValuationOutputCandidate, "rank"> {
	const match = bestMatch(seed);
	if (!isPrimaryRole(match.role)) throw new Error(`non-output role reached candidate scoring: ${match.role}`);
	const features: ScoreFeature[] = [];
	const warnings: string[] = [];
	addFeature(
		features,
		`semantic_label_${match.role}`,
		match.baseWeight,
		`Label '${match.label}' matched '${match.matchedPhrase}'`,
	);
	if (match.sourceWeight !== 0) {
		addFeature(
			features,
			`label_source_${match.labelSource}`,
			match.sourceWeight,
			`Label source is ${match.labelSource}`,
		);
	}
	if (seed.cell.numeric_value !== undefined) {
		addFeature(features, "numeric_output", 0.05, "Cell has an indexed numeric value");
	}
	if (seed.cell.formula) {
		addFeature(features, "formula_output", 0.08, "Cell contains a formula");
		if (seed.cell.formula_cache_status === "present") {
			addFeature(features, "formula_cache_present", 0.02, "Formula has a stored cache value");
		}
	}
	const unitAndFormat = normalizedLabel(`${seed.cell.unit ?? ""} ${seed.cell.number_format ?? ""}`);
	const perShare = includesAny(unitAndFormat, ["/share", "per share", "share", "每股", "股"]);
	const percentage = (seed.cell.unit ?? "") === "%" || normalizeText(seed.cell.number_format).includes("%");
	if (perShare) addFeature(features, "per_share_unit_or_format", 0.08, "Unit or format indicates a per-share value");
	if (percentage)
		addFeature(features, "percentage_output_penalty", -0.35, "Percentage cells are cross-checks, not primary values");
	const sheetText = normalizedLabel(`${seed.sheet.name} ${seed.sheet.role}`);
	if (seed.sheet.role === "valuation_dcf") {
		addFeature(features, "valuation_sheet", 0.06, "Worksheet is classified as valuation/DCF");
	} else if (seed.sheet.role === "output_table") {
		addFeature(features, "output_sheet", 0.04, "Worksheet is classified as an output table");
	}
	if (includesAny(sheetText, ["valuation", "dcf", "sotp", "summary", "估值", "摘要"])) {
		addFeature(features, "sheet_name_context", 0.04, "Worksheet name or role indicates valuation output context");
	}
	const sensitivityContext = includesAny(sheetText, ["sensitivity", "敏感"]);
	if (sensitivityContext) {
		addFeature(
			features,
			"sensitivity_context_penalty",
			-0.25,
			"Sensitivity-grid values cannot be selected as the primary output without separate base-case evidence",
		);
		warnings.push("Candidate is inside a sensitivity worksheet and was down-ranked");
	}
	const period = normalizedLabel(seed.cell.period);
	if (/^(?:fy\s*)?\d{2,4}\s*a$/u.test(period) || includesAny(period, ["actual", "historical", "历史", "实际"])) {
		addFeature(features, "historical_period_penalty", -0.12, `Period '${seed.cell.period}' appears historical`);
	} else if (/^(?:fy\s*)?\d{2,4}\s*[ef]$/u.test(period)) {
		addFeature(
			features,
			"forecast_or_target_period",
			0.02,
			`Period '${seed.cell.period}' appears forecast or target`,
		);
	}
	if (formulaGraphAvailable && directDownstreamCount === 0) {
		addFeature(features, "formula_graph_endpoint", 0.03, "No exact downstream formula reference was indexed");
	}
	if (upsideLinks.length > 0) {
		addFeature(features, "referenced_by_upside", 0.1, "An upside/downside formula references this cell");
		if (upsideLinks.some((link) => link.consistent === true)) {
			addFeature(
				features,
				"upside_arithmetic_consistent",
				0.08,
				"Target/current-price ratio matches reported upside",
			);
		}
		if (upsideLinks.some((link) => link.consistent === false)) {
			addFeature(
				features,
				"upside_arithmetic_conflict",
				-0.1,
				"Target/current-price ratio conflicts with reported upside",
			);
			warnings.push("Reported upside does not reconcile to the candidate and identified current price");
		}
	}
	if (dateLinks.some((link) => link.role === "valuation_date" && link.confidence >= 0.85)) {
		addFeature(
			features,
			"near_explicit_valuation_date",
			0.04,
			"A high-confidence valuation-date candidate is nearby",
		);
	}
	if (trace) {
		const structuralComplete = formulaTraceIsStructurallyComplete(trace);
		const traceText = normalizedLabel(
			trace.nodes
				.flatMap((node) => [node.row_label, node.col_label, node.display_value, node.unit])
				.filter((value) => value !== undefined)
				.join(" "),
		);
		const hasShares = includesAny(traceText, [
			"diluted shares",
			"shares outstanding",
			"share count",
			"total shares",
			"稀释后股本",
			"总股本",
			"股本",
		]);
		const hasEquity = includesAny(traceText, ["equity value", "value of equity", "股权价值", "权益价值"]);
		const hasEps = includesAny(traceText, ["eps", "earnings per share", "每股收益"]);
		const hasPe = includesAny(traceText, ["p e", "pe multiple", "target pe", "目标 pe", "市盈率"]);
		const hasDcf = includesAny(traceText, [
			"free cash flow",
			"fcf",
			"wacc",
			"terminal value",
			"perpetual growth",
			"自由现金流",
			"终值",
			"永续增长",
		]);
		const hasEnterprise = includesAny(traceText, ["enterprise value", "ebitda", "企业价值"]);
		if ((match.role === "target_price" || match.role === "per_share_value") && hasEquity && hasShares) {
			addFeature(
				features,
				"equity_value_divided_by_shares_signature",
				0.16,
				"Upstream labels contain equity value and shares",
			);
		}
		if ((match.role === "target_price" || match.role === "per_share_value") && hasEps && hasPe) {
			addFeature(features, "eps_times_pe_signature", 0.14, "Upstream labels contain EPS and target P/E");
		}
		if (match.role === "dcf_value" && hasDcf) {
			addFeature(features, "dcf_lineage_signature", 0.12, "Upstream labels contain DCF inputs");
		}
		if (match.role === "enterprise_value" && hasEnterprise) {
			addFeature(
				features,
				"enterprise_value_lineage_signature",
				0.1,
				"Upstream labels contain enterprise-value inputs",
			);
		}
		if (seed.cell.formula && trace.node_count > 1 && structuralComplete) {
			addFeature(
				features,
				"complete_formula_lineage",
				0.04,
				"Formula lineage is structurally complete within tool limits",
			);
		}
		if (!structuralComplete) {
			addFeature(features, "formula_lineage_gap_penalty", -0.07, "Formula lineage has structural gaps");
			warnings.push("Candidate formula lineage has unresolved or truncated references");
		}
	}
	if (!seed.cell.formula) {
		addFeature(features, "hardcoded_output_penalty", -0.04, "Hardcoded output has no upstream formula lineage");
		warnings.push("Candidate is hardcoded; upstream valuation lineage is unavailable");
	}
	const score =
		Math.round(
			Math.max(
				0,
				features.reduce((sum, feature) => sum + feature.weight, 0),
			) * 1_000,
		) / 1_000;
	let confidence = Math.min(score, 1);
	if (match.labelSource === "upside_formula_counterpart") confidence = Math.min(confidence, 0.79);
	if (trace && !formulaTraceIsStructurallyComplete(trace)) confidence = Math.min(confidence, 0.84);
	if (!seed.cell.formula) confidence = Math.min(confidence, 0.86);
	const labelCellRefs = uniqueValues(seed.matches.map((item) => item.labelCellRef));
	const definedNames = uniqueValues(seed.matches.map((item) => item.definedName));
	const labelEvidenceIds = uniqueValues(seed.matches.map((item) => item.labelEvidenceId));
	const labelCitations = uniqueValues(seed.matches.map((item) => item.labelCitation));
	const labelMarkdownCitations = uniqueValues(seed.matches.map((item) => item.labelMarkdownCitation));
	return {
		candidate_id: valuationOutputCandidateId(docId, seed.cell.sheet_name, seed.cell.cell_ref),
		semantic_role: match.role,
		score,
		confidence,
		sheet_name: seed.cell.sheet_name,
		cell_ref: seed.cell.cell_ref,
		sheet_role: seed.sheet.role,
		sheet_state: seed.sheet.state,
		label: match.label,
		label_source: match.labelSource,
		matched_phrase: match.matchedPhrase,
		label_cell_refs: labelCellRefs,
		defined_names: definedNames,
		evidence_ids: uniqueValues([seed.cell.evidence_id, ...labelEvidenceIds]),
		citations: uniqueValues([seed.cell.citation, ...labelCitations]),
		markdown_citations: uniqueValues([seed.cell.markdown_citation, ...labelMarkdownCitations]),
		...(seed.cell.display_value ? { display_value: seed.cell.display_value } : {}),
		...(seed.cell.numeric_value !== undefined ? { numeric_value: seed.cell.numeric_value } : {}),
		...(seed.cell.formula ? { formula: seed.cell.formula } : {}),
		...(seed.cell.cached_value ? { cached_value: seed.cell.cached_value } : {}),
		...(seed.cell.formula_cache_status ? { formula_cache_status: seed.cell.formula_cache_status } : {}),
		...(seed.cell.number_format ? { number_format: seed.cell.number_format } : {}),
		...(seed.cell.unit ? { unit: seed.cell.unit } : {}),
		...(seed.cell.period ? { period: seed.cell.period } : {}),
		direct_downstream_formula_count: directDownstreamCount,
		referenced_by_upside: upsideLinks.length > 0,
		upside_links: [...upsideLinks],
		date_context: [...dateLinks],
		...(trace ? { formula_trace: formulaTraceSummary(trace) } : {}),
		features,
		warnings,
	};
}

function preliminaryScore(seed: CandidateSeed): number {
	const match = bestMatch(seed);
	let score = match.baseWeight + match.sourceWeight;
	if (seed.cell.numeric_value !== undefined) score += 0.05;
	if (seed.cell.formula) score += 0.08;
	if (normalizedLabel(`${seed.cell.unit ?? ""} ${seed.cell.number_format ?? ""}`).includes("share")) score += 0.08;
	if (seed.sheet.role === "valuation_dcf") score += 0.06;
	if (includesAny(normalizedLabel(`${seed.sheet.name} ${seed.sheet.role}`), ["sensitivity", "敏感"])) score -= 0.25;
	return score;
}

function createCrossCheckNodes(
	crossChecks: ReadonlyMap<string, CandidateSeed>,
): PeValuationOutputResult["cross_check_nodes"] {
	return [...crossChecks.values()]
		.map((seed) => ({ seed, match: bestMatch(seed) }))
		.filter(
			(item): item is { seed: CandidateSeed; match: SeedMatch & { role: CrossCheckRole } } =>
				item.match.role === "current_price" || item.match.role === "upside",
		)
		.sort(
			(left, right) =>
				left.seed.sheet.index - right.seed.sheet.index ||
				left.seed.cell.row_index - right.seed.cell.row_index ||
				left.seed.cell.col_index - right.seed.cell.col_index,
		)
		.slice(0, 50)
		.map(({ seed, match }) => ({
			role: match.role,
			sheet_name: seed.cell.sheet_name,
			cell_ref: seed.cell.cell_ref,
			label: match.label,
			...(seed.cell.display_value ? { display_value: seed.cell.display_value } : {}),
			...(seed.cell.numeric_value !== undefined ? { numeric_value: seed.cell.numeric_value } : {}),
			...(seed.cell.formula ? { formula: seed.cell.formula } : {}),
			evidence_id: seed.cell.evidence_id,
			markdown_citation: seed.cell.markdown_citation,
		}));
}

function stableLocatorRunId(value: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 40);
}

function outputReference(candidate: ValuationOutputCandidate): PeValuationOutputResult["conflicting_outputs"][number] {
	return {
		candidate_id: candidate.candidate_id,
		semantic_role: candidate.semantic_role,
		sheet_name: candidate.sheet_name,
		cell_ref: candidate.cell_ref,
		score: candidate.score,
		evidence_id: candidate.evidence_ids[0],
		markdown_citation: candidate.markdown_citations[0],
	};
}

export function confirmPeValuationOutput(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	sheetName: string,
	outputCell: SqlRow,
): PeValuationOutputConfirmation {
	const cellRef = textValue(outputCell, "cell_ref") ?? "";
	const candidateId = valuationOutputCandidateId(docId, sheetName, cellRef);
	const cell = excelCellDetail({
		...outputCell,
		cell_id: textValue(outputCell, "cell_id") ?? "",
		cell_range: cellRef,
		original_filename: "workbook",
	});
	if (!hasOutputValue(cell)) {
		return { confirmed: false, candidate_id: candidateId, rejection_reason: "cell_has_no_numeric_or_formula_output" };
	}
	const directMatch = primaryDirectMatch(cell);
	let selectedMatch = directMatch;
	if (!selectedMatch) {
		const rowIndex = numberValue(outputCell, "row_index");
		const columnIndex = numberValue(outputCell, "col_index");
		if (rowIndex !== undefined && columnIndex !== undefined) {
			const nearbyRows = database
				.prepare(
					`SELECT display_value, raw_value
					 FROM excel_cells
					 WHERE dataset_id = ? AND doc_id = ? AND sheet_name = ?
					   AND (
					     (row_index = ? AND col_index BETWEEN ? AND ?)
					     OR (col_index = ? AND row_index BETWEEN ? AND ?)
					   )
					 ORDER BY ABS(row_index - ?) + ABS(col_index - ?)`,
				)
				.all(
					datasetId,
					docId,
					sheetName,
					rowIndex,
					Math.max(1, columnIndex - 8),
					columnIndex - 1,
					columnIndex,
					Math.max(1, rowIndex - 5),
					rowIndex - 1,
					rowIndex,
					columnIndex,
				) as SqlRow[];
			for (const nearbyRow of nearbyRows) {
				const match = classifyLabel(textValue(nearbyRow, "display_value") ?? textValue(nearbyRow, "raw_value"));
				if (match && isPrimaryRole(match.role)) {
					selectedMatch = {
						...match,
						labelSource: "right_of_label",
						sourceWeight: 0.1,
					};
					break;
				}
			}
		}
	}
	if (!selectedMatch || !isPrimaryRole(selectedMatch.role)) {
		return { confirmed: false, candidate_id: candidateId, rejection_reason: "no_explicit_valuation_output_label" };
	}
	const sheet = database
		.prepare("SELECT sheet_role FROM excel_sheets WHERE dataset_id = ? AND doc_id = ? AND sheet_name = ?")
		.get(datasetId, docId, sheetName) as SqlRow | undefined;
	const sheetRole = normalizedLabel(textValue(sheet ?? {}, "sheet_role"));
	if (includesAny(sheetRole, ["sensitivity", "敏感"])) {
		return {
			confirmed: false,
			candidate_id: candidateId,
			semantic_role: selectedMatch.role,
			label: selectedMatch.label,
			rejection_reason: "sensitivity_output_is_not_primary_valuation_output",
		};
	}
	return {
		confirmed: true,
		candidate_id: candidateId,
		semantic_role: selectedMatch.role,
		label: selectedMatch.label,
	};
}

export function locatePeValuationOutputs(
	cwd: string,
	options: PeValuationOutputOptions,
	signal?: AbortSignal,
): PeValuationOutputResult {
	const docId = options.docId.trim();
	const requestedSheetName = options.sheetName?.trim() || undefined;
	if (!docId) throw new Error("doc_id is required");
	const topK = Math.max(1, Math.min(MAX_TOP_K, Math.trunc(options.topK ?? DEFAULT_TOP_K)));
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		for (const table of ["excel_cells", "excel_sheets"] as const) {
			if (!tableExists(connection.database, table)) {
				throw new Error(
					`dataset has no ${table} table; open the workbook with pe_document_open before locating valuation outputs`,
				);
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

		const sheetRows = connection.database
			.prepare(
				`SELECT sheet_index, sheet_name, sheet_role, sheet_state
				 FROM excel_sheets
				 WHERE dataset_id = ? AND doc_id = ?
				 ORDER BY sheet_index`,
			)
			.all(connection.datasetId, docId) as SqlRow[];
		const sheets = new Map<string, SheetContext>();
		for (const row of sheetRows) {
			const name = textValue(row, "sheet_name");
			if (!name) continue;
			sheets.set(name.toLocaleLowerCase(), {
				index: numberValue(row, "sheet_index") ?? 0,
				name,
				role: textValue(row, "sheet_role") ?? "worksheet",
				state: textValue(row, "sheet_state") ?? "visible",
			});
		}
		let sheetName: string | undefined;
		if (requestedSheetName) {
			sheetName = sheets.get(requestedSheetName.toLocaleLowerCase())?.name;
			if (!sheetName) throw new Error(`Excel sheet not found in active document ${docId}: ${requestedSheetName}`);
		}

		const warnings: string[] = [];
		const formulaGraphAvailable = tableExists(connection.database, "excel_formula_references");
		if (!formulaGraphAvailable) {
			warnings.push("Formula-reference index is unavailable; candidates cannot receive lineage or upside checks");
		}
		const matching = readMatchingCells(connection.database, connection.datasetId, docId, sheetName);
		if (matching.truncated) {
			warnings.push(`Valuation-label scan reached the ${MAX_MATCHING_CELLS}-cell safety limit`);
		}
		const seeds = collectSeeds(connection.database, connection.datasetId, docId, matching.cells, sheets);
		addDefinedNameSeeds(
			connection.database,
			connection.datasetId,
			docId,
			sheets,
			sheetName,
			seeds.primary,
			seeds.crossChecks,
		);
		const upsideLinks = formulaGraphAvailable
			? addUpsideFormulaRelationships(
					connection.database,
					connection.datasetId,
					docId,
					sheets,
					sheetName,
					seeds.primary,
					seeds.crossChecks,
				)
			: new Map<string, UpsideLink[]>();

		const allSeeds = [...seeds.primary.values()].sort(
			(left, right) =>
				preliminaryScore(right) - preliminaryScore(left) ||
				left.sheet.index - right.sheet.index ||
				left.cell.row_index - right.cell.row_index ||
				left.cell.col_index - right.cell.col_index,
		);
		if (allSeeds.length > MAX_RAW_CANDIDATES) {
			warnings.push(
				`Candidate generation produced ${allSeeds.length} cells; only the strongest ${MAX_RAW_CANDIDATES} were retained`,
			);
		}
		const retainedSeeds = allSeeds.slice(0, MAX_RAW_CANDIDATES);
		const traceLimit = Math.min(MAX_TRACED_CANDIDATES, Math.max(topK * 4, 40));
		if (retainedSeeds.length > traceLimit) {
			warnings.push(`Formula scoring was limited to the strongest ${traceLimit} candidates`);
		}
		const evaluations: Array<Omit<ValuationOutputCandidate, "rank">> = [];
		for (const seed of retainedSeeds.slice(0, traceLimit)) {
			signal?.throwIfAborted();
			const downstreamCount = formulaGraphAvailable
				? directDownstreamFormulaCount(connection.database, connection.datasetId, docId, seed.cell)
				: 0;
			const dateLinks = readDateLinks(connection.database, connection.datasetId, docId, seed.cell);
			let trace: PeFormulaTraceResult | undefined;
			if (formulaGraphAvailable) {
				try {
					trace = tracePeFormula(
						cwd,
						{
							docId,
							sheetName: seed.cell.sheet_name,
							cellRef: seed.cell.cell_ref,
							datasetId: options.datasetId,
							maxDepth: 20,
							maxNodes: 1_000,
							maxRangeCells: 500,
						},
						signal,
					);
				} catch (error: unknown) {
					warnings.push(
						`Formula trace failed for ${seed.cell.sheet_name}!${seed.cell.cell_ref}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			evaluations.push(
				scoreSeed(
					docId,
					seed,
					formulaGraphAvailable,
					downstreamCount,
					upsideLinks.get(seed.cell.cell_id) ?? [],
					dateLinks,
					trace,
				),
			);
		}
		const sortedCandidates: ValuationOutputCandidate[] = evaluations
			.sort(
				(left, right) =>
					right.score - left.score ||
					left.semantic_role.localeCompare(right.semantic_role) ||
					left.sheet_name.localeCompare(right.sheet_name) ||
					left.cell_ref.localeCompare(right.cell_ref),
			)
			.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
		const topCandidate = sortedCandidates[0];
		const closeCandidates = topCandidate
			? sortedCandidates.filter((candidate) => topCandidate.score - candidate.score <= AMBIGUITY_SCORE_DELTA)
			: [];
		let status: PeValuationOutputResult["status"];
		let selectedCandidateId: string | undefined;
		let conflictingCandidateIds: string[] = [];
		const topCandidateIsSensitivity = topCandidate?.features.some(
			(feature) => feature.code === "sensitivity_context_penalty",
		);
		if (!topCandidate) {
			status = "missing";
			warnings.push("No labeled valuation-output candidate was found");
		} else if (topCandidateIsSensitivity) {
			status = "ambiguous";
			conflictingCandidateIds = closeCandidates.map((candidate) => candidate.candidate_id);
			warnings.push("A sensitivity-grid cell cannot be auto-selected as the primary valuation output");
		} else if (topCandidate.score < MIN_AUTO_SELECTION_SCORE) {
			status = "ambiguous";
			conflictingCandidateIds = closeCandidates.map((candidate) => candidate.candidate_id);
			warnings.push(
				`Top candidate score ${topCandidate.score.toFixed(3)} is below the ${MIN_AUTO_SELECTION_SCORE.toFixed(2)} auto-selection threshold`,
			);
		} else if (closeCandidates.length > 1) {
			status = "ambiguous";
			conflictingCandidateIds = closeCandidates.map((candidate) => candidate.candidate_id);
			warnings.push("Multiple similarly supported valuation-output candidates remain unresolved");
		} else {
			status = "selected";
			selectedCandidateId = topCandidate.candidate_id;
		}
		const returnedCandidates = sortedCandidates.slice(0, topK);
		const selectedOutput = status === "selected" && topCandidate ? outputReference(topCandidate) : undefined;
		const conflictingOutputs = status === "ambiguous" ? closeCandidates.map(outputReference) : [];
		const locatorRunId = stableLocatorRunId({
			dataset_id: connection.datasetId,
			doc_id: docId,
			sheet_name: sheetName,
			status,
			selected_candidate_id: selectedCandidateId,
			conflicting_candidate_ids: conflictingCandidateIds,
			candidates: sortedCandidates.map((candidate) => ({
				candidate_id: candidate.candidate_id,
				score: candidate.score,
				features: candidate.features,
			})),
		});
		return {
			schema_version: "1.0",
			dataset_id: connection.datasetId,
			locator_run_id: locatorRunId,
			document: {
				doc_id: docId,
				filename: sourceFilename(document),
				...(numberValue(document, "version_no") !== undefined
					? { version_no: numberValue(document, "version_no") }
					: {}),
				...(textValue(document, "document_date") ? { document_date: textValue(document, "document_date") } : {}),
			},
			status,
			selection_method: "explainable_rule_score",
			...(selectedCandidateId ? { selected_candidate_id: selectedCandidateId } : {}),
			...(selectedOutput ? { selected_output: selectedOutput } : {}),
			conflicting_candidate_ids: conflictingCandidateIds,
			conflicting_outputs: conflictingOutputs,
			candidate_count: allSeeds.length,
			evaluated_candidate_count: sortedCandidates.length,
			returned_candidate_count: returnedCandidates.length,
			cross_check_nodes: createCrossCheckNodes(seeds.crossChecks),
			warnings: uniqueValues(warnings),
			candidates: returnedCandidates,
			answer_contract:
				"status=selected means one deterministic top-ranked output candidate, not that its cached value or valuation logic was recalculated or verified. For ambiguous, preserve every conflicting candidate and trace them separately. Pass the selected candidate ID, sheet, and cell to pe_valuation_date_resolve; never promote current price, upside, or a sensitivity-grid cell to the primary output.",
		};
	} finally {
		connection.database.close();
	}
}

export const peValuationOutputTool = defineTool({
	name: "pe_valuation_output_locate",
	label: "PE Valuation Output Locate",
	description:
		"Generate, rank, and explain valuation-output cell candidates for one active Excel model. Separates target price, per-share value, enterprise value, equity value, DCF/SOTP outputs, current price, upside, and sensitivity context.",
	promptSnippet: PE_VALUATION_OUTPUT_PROMPT_SNIPPET,
	parameters: Type.Object({
		doc_id: Type.String({ description: "Exact active workbook document ID.", minLength: 1 }),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		sheet_name: Type.Optional(
			Type.String({
				description: "Optional exact worksheet scope. Omit to scan every visible and hidden worksheet.",
			}),
		),
		top_k: Type.Optional(
			Type.Integer({
				description: "Maximum ranked candidates returned. Defaults to 10; maximum 25.",
				minimum: 1,
				maximum: MAX_TOP_K,
			}),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		await preparePeDocument(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		const result = locatePeValuationOutputs(
			ctx.cwd,
			{
				docId: params.doc_id,
				datasetId: params.dataset_id,
				sheetName: params.sheet_name,
				topK: params.top_k,
			},
			signal,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
