import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import {
	booleanValue,
	numberValue,
	openPeDataset,
	type SqlRow,
	sourceCitation,
	sourceEvidenceId,
	sourceFilename,
	sourceMarkdownCitation,
	textValue,
} from "./database.ts";
import { parseExcelCellRange } from "./excel-cells.ts";
import { formulaTraceIsStructurallyComplete, type PeFormulaTraceResult, tracePeFormula } from "./formula-trace.ts";
import { confirmPeValuationOutput, type PeValuationOutputConfirmation } from "./valuation-output.ts";

const AMBIGUITY_SCORE_DELTA = 0.08;

const VALUATION_DATE_ROLE_ORDER = [
	"valuation_date",
	"market_price_date",
	"report_publication_date",
	"model_updated_at",
] as const;

const RELATED_DATE_ROLES = [
	"market_price_date",
	"financial_data_as_of",
	"report_publication_date",
	"model_updated_at",
	"target_horizon_end",
] as const;

export const PE_VALUATION_DATE_PROMPT_SNIPPET =
	"Resolve a model valuation date from persisted cell evidence and one optional locator-selected output candidate without using maximum dates or file timestamps as authoritative evidence";

export interface PeValuationDateOptions {
	docId: string;
	datasetId?: string;
	outputSheet?: string;
	outputCellRef?: string;
	outputCandidateId?: string;
	allowMetadataFallback?: boolean;
}

export type PeValuationDateStatus = "verified" | "inferred" | "ambiguous" | "missing";

interface OutputContext {
	sheet_name: string;
	cell_ref: string;
	valuation_output_candidate_id: string;
	valuation_output_status: "confirmed" | "unconfirmed";
	valuation_output_role?: string;
	valuation_output_label?: string;
	formula_trace_complete: boolean;
	formula_trace_status: "complete" | "incomplete" | "unavailable" | "not_run";
	formula_trace_issue_codes: string[];
}

interface DateCandidateDetail {
	candidate_id: string;
	schema_version: string;
	normalized_date?: string;
	raw_text: string;
	role: string;
	source_type: string;
	evidence_id?: string;
	citation: string;
	markdown_citation?: string;
	sheet_name?: string;
	cell_ref?: string;
	row_index?: number;
	col_index?: number;
	nearby_label?: string;
	label_cell_refs?: string[];
	parse_method: string;
	date_precision: string;
	is_forecast: boolean;
	priority_score: number;
	confidence: number;
	rejection_reason?: string;
	role_method?: string;
	matched_text?: string;
	label_context?: string;
	assertion_status?: string;
	date_extraction_rules_version?: string;
	on_output_formula_path: boolean;
	near_output: boolean;
	resolution_score: number;
}

interface CandidateDateGroup {
	normalized_date: string;
	score: number;
	candidates: DateCandidateDetail[];
}

interface RelatedDateResolution {
	status: "identified" | "ambiguous" | "missing";
	date?: string;
	confidence?: number;
	candidate_ids: string[];
	evidence_ids: string[];
	conflicting_dates?: string[];
}

export interface PeValuationDateResult {
	schema_version: "1.0";
	dataset_id: string;
	resolution_id: string;
	resolution_version: 1;
	supersedes_resolution_id: null;
	document: {
		doc_id: string;
		filename: string;
		document_date?: string;
	};
	status: PeValuationDateStatus;
	valuation_date?: string;
	resolution_method: string;
	confidence: number;
	selected_role?: string;
	selected_candidate_ids: string[];
	conflicting_candidate_ids: string[];
	evidence_ids: string[];
	primary_output_node_id?: string;
	output_context?: OutputContext;
	related_dates: Record<string, RelatedDateResolution>;
	warnings: string[];
	candidate_count: number;
	candidates: DateCandidateDetail[];
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

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function canonicalCellRef(value: string): string | undefined {
	const normalized = value.trim().replaceAll("$", "").toUpperCase();
	const bounds = parseExcelCellRange(normalized);
	if (!bounds || bounds.rowStart !== bounds.rowEnd || bounds.columnStart !== bounds.columnEnd) return undefined;
	return /^[A-Z]{1,3}[1-9]\d*$/u.test(normalized) ? normalized : undefined;
}

function candidateKey(candidate: Pick<DateCandidateDetail, "sheet_name" | "cell_ref">): string | undefined {
	return candidate.sheet_name && candidate.cell_ref
		? `${candidate.sheet_name.toLocaleLowerCase()}\0${candidate.cell_ref.toUpperCase()}`
		: undefined;
}

function outputProximity(
	candidate: Pick<DateCandidateDetail, "sheet_name" | "row_index" | "col_index">,
	outputSheet: string | undefined,
	outputCellRef: string | undefined,
): { near: boolean; bonus: number } {
	if (
		!outputSheet ||
		!outputCellRef ||
		candidate.sheet_name?.toLocaleLowerCase() !== outputSheet.toLocaleLowerCase()
	) {
		return { near: false, bonus: 0 };
	}
	const outputBounds = parseExcelCellRange(outputCellRef);
	if (!outputBounds || candidate.row_index === undefined || candidate.col_index === undefined) {
		return { near: false, bonus: 0 };
	}
	const rowDistance = Math.abs(candidate.row_index - outputBounds.rowStart);
	const columnDistance = Math.abs(candidate.col_index - outputBounds.columnStart);
	const near =
		(rowDistance === 0 && columnDistance <= 8) ||
		(columnDistance === 0 && rowDistance <= 10) ||
		(rowDistance <= 8 && columnDistance <= 4 && rowDistance + columnDistance <= 10);
	if (!near) return { near: false, bonus: 0 };
	const bonus = Math.max(0.04, 0.2 - rowDistance * 0.006 - columnDistance * 0.008);
	return { near: true, bonus };
}

function groupCandidatesByDate(candidates: readonly DateCandidateDetail[]): CandidateDateGroup[] {
	const grouped = new Map<string, DateCandidateDetail[]>();
	for (const candidate of candidates) {
		if (!candidate.normalized_date) continue;
		const existing = grouped.get(candidate.normalized_date);
		if (existing) existing.push(candidate);
		else grouped.set(candidate.normalized_date, [candidate]);
	}
	return [...grouped.entries()]
		.map(([normalizedDate, members]) => ({
			normalized_date: normalizedDate,
			score: Math.max(...members.map((candidate) => candidate.resolution_score)),
			candidates: members.sort((left, right) => left.candidate_id.localeCompare(right.candidate_id)),
		}))
		.sort(
			(left, right) =>
				right.score - left.score || left.candidates[0].candidate_id.localeCompare(right.candidates[0].candidate_id),
		);
}

function uniqueValues(values: readonly (string | undefined)[]): string[] {
	return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function isWorkbookEvidenceSource(sourceType: string): boolean {
	return sourceType === "workbook_cell" || sourceType === "defined_name";
}

function isEligibleDate(
	candidate: Pick<
		DateCandidateDetail,
		| "normalized_date"
		| "date_precision"
		| "is_forecast"
		| "source_type"
		| "role"
		| "rejection_reason"
		| "assertion_status"
	>,
	allowMetadataFallback = false,
): boolean {
	const value = candidate.normalized_date;
	if (candidate.assertion_status && candidate.assertion_status !== "affirmed") return false;
	if (!value || candidate.date_precision !== "day" || candidate.is_forecast || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
		return false;
	}
	const parsed = new Date(`${value}T00:00:00.000Z`);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
	if (isWorkbookEvidenceSource(candidate.source_type)) return !candidate.rejection_reason;
	return (
		allowMetadataFallback &&
		(candidate.source_type === "workbook_property" || candidate.source_type === "file_metadata") &&
		(candidate.role === "file_modified_at" || candidate.role === "file_created_at") &&
		(!candidate.rejection_reason || candidate.rejection_reason === "workbook_property_cannot_verify_valuation_date")
	);
}

function resolveRelatedDate(candidates: readonly DateCandidateDetail[], role: string): RelatedDateResolution {
	const groups = groupCandidatesByDate(
		candidates.filter((candidate) => candidate.role === role && isEligibleDate(candidate)),
	);
	if (groups.length === 0) return { status: "missing", candidate_ids: [], evidence_ids: [] };
	const top = groups[0];
	const conflicts = groups.slice(1).filter((group) => top.score - group.score <= AMBIGUITY_SCORE_DELTA);
	if (conflicts.length > 0) {
		const conflictGroups = [top, ...conflicts];
		return {
			status: "ambiguous",
			candidate_ids: conflictGroups.flatMap((group) => group.candidates.map((candidate) => candidate.candidate_id)),
			evidence_ids: uniqueValues(
				conflictGroups.flatMap((group) => group.candidates.map((candidate) => candidate.evidence_id)),
			),
			conflicting_dates: conflictGroups.map((group) => group.normalized_date),
		};
	}
	return {
		status: "identified",
		date: top.normalized_date,
		confidence: Math.max(...top.candidates.map((candidate) => candidate.confidence)),
		candidate_ids: top.candidates.map((candidate) => candidate.candidate_id),
		evidence_ids: uniqueValues(top.candidates.map((candidate) => candidate.evidence_id)),
	};
}

function stableResolutionId(value: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 40);
}

export function resolvePeValuationDate(
	cwd: string,
	options: PeValuationDateOptions,
	signal?: AbortSignal,
): PeValuationDateResult {
	const docId = options.docId.trim();
	if (!docId) throw new Error("doc_id is required");
	const requestedOutputSheet = options.outputSheet?.trim() || undefined;
	const requestedOutputCellRef = options.outputCellRef?.trim() || undefined;
	const requestedOutputCandidateId = options.outputCandidateId?.trim() || undefined;
	if (Boolean(requestedOutputSheet) !== Boolean(requestedOutputCellRef)) {
		throw new Error("output_sheet and output_cell_ref must be provided together");
	}
	if (requestedOutputCandidateId && (!requestedOutputSheet || !requestedOutputCellRef)) {
		throw new Error("output_candidate_id requires output_sheet and output_cell_ref");
	}
	const canonicalOutputCellRef = requestedOutputCellRef ? canonicalCellRef(requestedOutputCellRef) : undefined;
	if (requestedOutputCellRef && !canonicalOutputCellRef) {
		throw new Error("output_cell_ref must be one valid A1 cell reference");
	}

	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		if (!tableExists(connection.database, "valuation_date_candidates")) {
			throw new Error(
				"dataset has no valuation-date candidate cache; open the workbook with pe_document_open before resolving dates",
			);
		}
		const document = connection.database
			.prepare(
				`SELECT doc_id, original_filename, source_relpath, document_date
				 FROM documents
				 WHERE dataset_id = ? AND doc_id = ? AND file_type IN ('xlsx','xlsm')`,
			)
			.get(connection.datasetId, docId) as SqlRow | undefined;
		if (!document) throw new Error(`Excel document not found in the current dataset: ${docId}`);

		let outputSheet: string | undefined;
		let valuationOutputConfirmation: PeValuationOutputConfirmation | undefined;
		if (requestedOutputSheet && canonicalOutputCellRef) {
			const sheet = connection.database
				.prepare(
					`SELECT sheet_name FROM excel_sheets
					 WHERE dataset_id = ? AND doc_id = ? AND lower(sheet_name) = lower(?)`,
				)
				.get(connection.datasetId, docId, requestedOutputSheet) as SqlRow | undefined;
			outputSheet = sheet ? textValue(sheet, "sheet_name") : undefined;
			if (!outputSheet) throw new Error(`Excel sheet not found in document ${docId}: ${requestedOutputSheet}`);
			const outputCell = connection.database
				.prepare(
					`SELECT * FROM excel_cells
					 WHERE dataset_id = ? AND doc_id = ? AND sheet_name = ? AND cell_ref = ?`,
				)
				.get(connection.datasetId, docId, outputSheet, canonicalOutputCellRef) as SqlRow | undefined;
			if (!outputCell) {
				throw new Error(`indexed valuation output cell not found: ${outputSheet}!${canonicalOutputCellRef}`);
			}
			valuationOutputConfirmation = confirmPeValuationOutput(
				connection.database,
				connection.datasetId,
				docId,
				outputSheet,
				outputCell,
			);
			if (requestedOutputCandidateId && requestedOutputCandidateId !== valuationOutputConfirmation.candidate_id) {
				throw new Error(
					`output_candidate_id does not match ${outputSheet}!${canonicalOutputCellRef}: expected ${valuationOutputConfirmation.candidate_id}`,
				);
			}
		}

		const rows = connection.database
			.prepare(
				`SELECT v.*, v.cell_ref AS cell_range,
				        d.original_filename, d.source_relpath, d.file_type, d.document_date
				 FROM valuation_date_candidates v
				 JOIN documents d ON d.doc_id = v.doc_id AND d.dataset_id = v.dataset_id
				 WHERE v.dataset_id = ? AND v.doc_id = ?
				 ORDER BY v.priority_score DESC, v.candidate_id`,
			)
			.all(connection.datasetId, docId) as SqlRow[];
		const hasEligibleWorkbookDate = rows.some((row) => {
			const role = textValue(row, "role") ?? "unknown";
			const metadata = jsonObjectValue(row, "metadata_json");
			return (
				VALUATION_DATE_ROLE_ORDER.some((allowedRole) => allowedRole === role) &&
				isEligibleDate({
					role,
					normalized_date: textValue(row, "normalized_date"),
					date_precision: textValue(row, "date_precision") ?? "unknown",
					is_forecast: booleanValue(row, "is_forecast"),
					source_type: textValue(row, "source_type") ?? "unknown",
					rejection_reason: textValue(row, "rejection_reason"),
					assertion_status: typeof metadata?.assertion_status === "string" ? metadata.assertion_status : undefined,
				})
			);
		});
		const warnings: string[] = [];
		let formulaTrace: PeFormulaTraceResult | undefined;
		let formulaTraceError: string | undefined;
		if (outputSheet && canonicalOutputCellRef && hasEligibleWorkbookDate) {
			try {
				formulaTrace = tracePeFormula(
					cwd,
					{
						docId,
						sheetName: outputSheet,
						cellRef: canonicalOutputCellRef,
						datasetId: options.datasetId,
						maxDepth: 20,
						maxNodes: 1_000,
						maxRangeCells: 500,
					},
					signal,
				);
			} catch (error: unknown) {
				signal?.throwIfAborted();
				formulaTraceError = error instanceof Error ? error.message : String(error);
				warnings.push(`Valuation-output formula trace was unavailable: ${formulaTraceError}`);
			}
		} else if (!outputSheet) {
			warnings.push(
				"No valuation output cell was supplied; an explicit date can be inferred but not output-context verified",
			);
		} else {
			warnings.push("Formula tracing was not run because no eligible workbook valuation-date candidate exists");
		}
		const traceCellKeys = new Set(
			formulaTrace?.nodes.map((node) => `${node.sheet_name.toLocaleLowerCase()}\0${node.cell_ref.toUpperCase()}`) ??
				[],
		);
		const traceStructurallyComplete = formulaTrace ? formulaTraceIsStructurallyComplete(formulaTrace) : false;
		if (formulaTrace && !traceStructurallyComplete) {
			warnings.push("Valuation-output formula trace contains structural gaps; date status cannot be verified");
		}
		if (valuationOutputConfirmation && !valuationOutputConfirmation.confirmed) {
			warnings.push(
				"The supplied output cell was not confirmed as a valuation output; date status cannot be verified",
			);
			if (valuationOutputConfirmation.rejection_reason) {
				warnings.push(`Valuation-output rejection reason: ${valuationOutputConfirmation.rejection_reason}`);
			}
		}

		const candidates = rows.map((row): DateCandidateDetail => {
			const evidenceId =
				textValue(row, "sheet_name") && textValue(row, "cell_ref") ? sourceEvidenceId(row) : undefined;
			const metadata = jsonObjectValue(row, "metadata_json");
			const labelCellRefs = stringArray(metadata?.label_cell_refs);
			const baseCandidate = {
				sheet_name: textValue(row, "sheet_name"),
				cell_ref: textValue(row, "cell_ref"),
				row_index: numberValue(row, "row_index"),
				col_index: numberValue(row, "col_index"),
			};
			const key = candidateKey(baseCandidate);
			const onOutputFormulaPath = key ? traceCellKeys.has(key) : false;
			const proximity = outputProximity(baseCandidate, outputSheet, canonicalOutputCellRef);
			const priorityScore = numberValue(row, "priority_score") ?? 0;
			const resolutionScore = priorityScore + (onOutputFormulaPath ? 0.35 : 0) + proximity.bonus;
			return {
				candidate_id: textValue(row, "candidate_id") ?? "",
				schema_version: textValue(row, "schema_version") ?? "1.0",
				...(textValue(row, "normalized_date") ? { normalized_date: textValue(row, "normalized_date") } : {}),
				raw_text: textValue(row, "raw_text") ?? "",
				role: textValue(row, "role") ?? "unknown",
				source_type: textValue(row, "source_type") ?? "unknown",
				...(evidenceId ? { evidence_id: evidenceId } : {}),
				citation: sourceCitation(row),
				...(evidenceId ? { markdown_citation: sourceMarkdownCitation(row, evidenceId) } : {}),
				...(baseCandidate.sheet_name ? { sheet_name: baseCandidate.sheet_name } : {}),
				...(baseCandidate.cell_ref ? { cell_ref: baseCandidate.cell_ref } : {}),
				...(baseCandidate.row_index !== undefined ? { row_index: baseCandidate.row_index } : {}),
				...(baseCandidate.col_index !== undefined ? { col_index: baseCandidate.col_index } : {}),
				...(textValue(row, "nearby_label") ? { nearby_label: textValue(row, "nearby_label") } : {}),
				...(labelCellRefs && labelCellRefs.length > 0 ? { label_cell_refs: labelCellRefs } : {}),
				parse_method: textValue(row, "parse_method") ?? "unknown",
				date_precision: textValue(row, "date_precision") ?? "unknown",
				is_forecast: booleanValue(row, "is_forecast"),
				priority_score: priorityScore,
				confidence: numberValue(row, "confidence") ?? 0,
				...(textValue(row, "rejection_reason") ? { rejection_reason: textValue(row, "rejection_reason") } : {}),
				...(typeof metadata?.role_method === "string" ? { role_method: metadata.role_method } : {}),
				...(typeof metadata?.matched_text === "string" ? { matched_text: metadata.matched_text } : {}),
				...(typeof metadata?.label_context === "string" ? { label_context: metadata.label_context } : {}),
				...(typeof metadata?.assertion_status === "string" ? { assertion_status: metadata.assertion_status } : {}),
				...(typeof metadata?.date_extraction_rules_version === "string"
					? { date_extraction_rules_version: metadata.date_extraction_rules_version }
					: {}),
				on_output_formula_path: onOutputFormulaPath,
				near_output: proximity.near,
				resolution_score: Math.round(resolutionScore * 1_000) / 1_000,
			};
		});

		const selectableRoleOrder = [
			...VALUATION_DATE_ROLE_ORDER,
			...(options.allowMetadataFallback ? (["file_modified_at", "file_created_at"] as const) : []),
		];
		let selectedRole: string | undefined;
		let groups: CandidateDateGroup[] = [];
		for (const role of selectableRoleOrder) {
			const roleGroups = groupCandidatesByDate(
				candidates.filter(
					(candidate) => candidate.role === role && isEligibleDate(candidate, options.allowMetadataFallback),
				),
			);
			if (roleGroups.length > 0) {
				selectedRole = role;
				groups = roleGroups;
				break;
			}
		}

		const topGroup = groups[0];
		const conflictingGroups = topGroup
			? groups.slice(1).filter((group) => topGroup.score - group.score <= AMBIGUITY_SCORE_DELTA)
			: [];
		let status: PeValuationDateStatus;
		let valuationDate: string | undefined;
		let resolutionMethod: string;
		let confidence = 0;
		if (!topGroup || !selectedRole) {
			status = "missing";
			resolutionMethod = "no_eligible_valuation_date_evidence";
			warnings.push("No eligible valuation-date evidence was found");
		} else if (conflictingGroups.length > 0) {
			status = "ambiguous";
			resolutionMethod = "conflicting_same-priority_date_evidence";
			confidence = Math.max(...topGroup.candidates.map((candidate) => candidate.confidence));
			warnings.push("Multiple similarly supported valuation dates remain unresolved");
		} else {
			valuationDate = topGroup.normalized_date;
			const hasExplicitOutputDate = topGroup.candidates.some(
				(candidate) =>
					candidate.role_method?.startsWith("explicit_label:") &&
					candidate.confidence >= 0.9 &&
					(candidate.on_output_formula_path || candidate.near_output),
			);
			const canVerify =
				selectedRole === "valuation_date" &&
				hasExplicitOutputDate &&
				outputSheet !== undefined &&
				valuationOutputConfirmation?.confirmed === true &&
				traceStructurallyComplete;
			status = canVerify ? "verified" : "inferred";
			resolutionMethod = canVerify
				? "explicit_label_and_valuation_output_context"
				: selectedRole === "valuation_date"
					? "valuation_date_candidate_without_complete_output_context"
					: `${selectedRole}_fallback`;
			confidence = Math.max(...topGroup.candidates.map((candidate) => candidate.confidence));
			if (!canVerify) confidence = Math.min(confidence, 0.89);
			if (selectedRole !== "valuation_date") {
				warnings.push(
					`Valuation date is inferred from ${selectedRole}; no explicit valuation-date cell was selected`,
				);
			}
			if (selectedRole === "file_modified_at" || selectedRole === "file_created_at") {
				warnings.push(
					"File or workbook timestamps are weak fallback evidence and can never produce verified status",
				);
			}
		}

		const selectedCandidates = status === "ambiguous" ? [] : (topGroup?.candidates ?? []);
		const conflictCandidates =
			status === "ambiguous"
				? [topGroup, ...conflictingGroups].flatMap((group) => group?.candidates ?? [])
				: conflictingGroups.flatMap((group) => group.candidates);
		const selectedCandidateIds = selectedCandidates.map((candidate) => candidate.candidate_id);
		const conflictingCandidateIds = conflictCandidates.map((candidate) => candidate.candidate_id);
		const evidenceIds = uniqueValues(
			(status === "ambiguous" ? conflictCandidates : selectedCandidates).map((candidate) => candidate.evidence_id),
		);
		const relatedDates: Record<string, RelatedDateResolution> = {};
		for (const role of RELATED_DATE_ROLES) relatedDates[role] = resolveRelatedDate(candidates, role);
		const forecastCandidateCount = candidates.filter((candidate) => candidate.is_forecast).length;
		const ambiguousTextCount = candidates.filter(
			(candidate) => candidate.normalized_date === undefined && candidate.parse_method === "ambiguous_numeric_text",
		).length;
		const unparsedDateTextCount = candidates.filter(
			(candidate) => candidate.normalized_date === undefined && candidate.parse_method === "unparsed_text",
		).length;
		if (forecastCandidateCount > 0) {
			warnings.push(
				`${forecastCandidateCount} forecast-period candidate(s) were excluded from valuation-date selection`,
			);
		}
		if (ambiguousTextCount > 0) {
			warnings.push(`${ambiguousTextCount} locale-ambiguous date text candidate(s) require review`);
		}
		if (unparsedDateTextCount > 0) {
			warnings.push(`${unparsedDateTextCount} explicitly labeled date text candidate(s) could not be normalized`);
		}
		const multiDateCount = candidates.filter((candidate) => candidate.parse_method === "multiple_date_text").length;
		if (multiDateCount > 0) {
			warnings.push(`${multiDateCount} cell(s) contain multiple date spans and require review`);
		}
		for (const assertion of ["negated", "unconfirmed"] as const) {
			const count = candidates.filter((candidate) => candidate.assertion_status === assertion).length;
			if (count > 0) {
				warnings.push(
					`${count} ${assertion} date candidate(s) were retained for review but excluded from date selection`,
				);
			}
		}
		if (textValue(document, "document_date")) {
			warnings.push("documents.document_date is filename-derived and was not treated as valuation-date evidence");
		}

		const outputContext: OutputContext | undefined =
			outputSheet && canonicalOutputCellRef
				? {
						sheet_name: outputSheet,
						cell_ref: canonicalOutputCellRef,
						valuation_output_candidate_id:
							valuationOutputConfirmation?.candidate_id ?? requestedOutputCandidateId ?? "",
						valuation_output_status: valuationOutputConfirmation?.confirmed ? "confirmed" : "unconfirmed",
						...(valuationOutputConfirmation?.semantic_role
							? { valuation_output_role: valuationOutputConfirmation.semantic_role }
							: {}),
						...(valuationOutputConfirmation?.label
							? { valuation_output_label: valuationOutputConfirmation.label }
							: {}),
						formula_trace_complete: traceStructurallyComplete,
						formula_trace_status: formulaTrace
							? traceStructurallyComplete
								? "complete"
								: "incomplete"
							: formulaTraceError
								? "unavailable"
								: "not_run",
						formula_trace_issue_codes: formulaTrace
							? uniqueValues(formulaTrace.issues.map((issue) => issue.code))
							: [...(formulaTraceError ? ["formula_trace_unavailable"] : [])],
					}
				: undefined;
		const resolutionId = stableResolutionId({
			dataset_id: connection.datasetId,
			doc_id: docId,
			output_context: outputContext,
			status,
			valuation_date: valuationDate,
			selected_candidate_ids: selectedCandidateIds,
			conflicting_candidate_ids: conflictingCandidateIds,
		});

		return {
			schema_version: "1.0",
			dataset_id: connection.datasetId,
			resolution_id: resolutionId,
			resolution_version: 1,
			supersedes_resolution_id: null,
			document: {
				doc_id: docId,
				filename: sourceFilename(document),
				...(textValue(document, "document_date") ? { document_date: textValue(document, "document_date") } : {}),
			},
			status,
			...(valuationDate ? { valuation_date: valuationDate } : {}),
			resolution_method: resolutionMethod,
			confidence,
			...(selectedRole ? { selected_role: selectedRole } : {}),
			selected_candidate_ids: selectedCandidateIds,
			conflicting_candidate_ids: conflictingCandidateIds,
			evidence_ids: evidenceIds,
			...(outputContext ? { primary_output_node_id: outputContext.valuation_output_candidate_id } : {}),
			...(outputContext ? { output_context: outputContext } : {}),
			related_dates: relatedDates,
			warnings,
			candidate_count: candidates.length,
			candidates: candidates.sort(
				(left, right) =>
					right.resolution_score - left.resolution_score || left.candidate_id.localeCompare(right.candidate_id),
			),
			answer_contract:
				"Only status=verified may be described as a verified valuation date. Negated, unconfirmed, or rejected candidates are review evidence only, never selected dates. Keep market-price date, financial-data cutoff, report date, model-update date, target horizon, forecast periods, and file timestamps separate. If status is ambiguous or missing, disclose candidates and do not choose the latest date.",
		};
	} finally {
		connection.database.close();
	}
}

export const peValuationDateTool = defineTool({
	name: "pe_valuation_date_resolve",
	label: "PE Valuation Date Resolve",
	description:
		"Resolve the valuation date of one active Excel model from persisted date candidates and optional locator-selected output context. Validates the output candidate ID, sheet, and cell when supplied, and separates valuation, market-price, financial-cutoff, report, model-update, horizon, forecast, and file dates.",
	promptSnippet: PE_VALUATION_DATE_PROMPT_SNIPPET,
	parameters: Type.Object({
		doc_id: Type.String({ description: "Exact active workbook document ID.", minLength: 1 }),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		output_sheet: Type.Optional(
			Type.String({
				description: "Worksheet containing the selected valuation output. Provide with output_cell_ref.",
			}),
		),
		output_cell_ref: Type.Optional(
			Type.String({ description: "A1 reference of the selected valuation output. Provide with output_sheet." }),
		),
		output_candidate_id: Type.Optional(
			Type.String({
				description:
					"Stable selected candidate ID returned by pe_valuation_output_locate. Requires output_sheet and output_cell_ref.",
			}),
		),
		allow_metadata_fallback: Type.Optional(
			Type.Boolean({
				description:
					"Allow workbook/file timestamps as a low-confidence inferred fallback. Defaults to false and can never return verified status.",
			}),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		await preparePeDocument(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		const result = resolvePeValuationDate(
			ctx.cwd,
			{
				docId: params.doc_id,
				datasetId: params.dataset_id,
				outputSheet: params.output_sheet,
				outputCellRef: params.output_cell_ref,
				outputCandidateId: params.output_candidate_id,
				allowMetadataFallback: params.allow_metadata_fallback,
			},
			signal,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
