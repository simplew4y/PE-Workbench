import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { resolvePeEvidenceRecord } from "../evidence.ts";
import { excelColumnLabel, parseExcelCellRange, parseSourceId } from "../source.ts";
import { documentFilePath, type SqlRow } from "../tools/database.ts";
import { readWorkbookDocumentAsync } from "../workbook-reader.ts";
import { collectFrameworkEvidenceIds, type FrameworkContent, ResearchError, type ResearchInput } from "./model.ts";

export interface ResearchEvidenceProgress {
	completed: number;
	total: number;
	phase: "validating" | "retry" | "validated";
	docId?: string;
	attempt?: number;
	elapsedMs?: number;
	cacheHit?: boolean;
}

export interface ResearchEvidenceOptions {
	signal?: AbortSignal;
	onProgress?: (progress: ResearchEvidenceProgress) => void;
}

function documentSignature(document: SqlRow): string {
	return JSON.stringify(
		[
			"doc_id",
			"dataset_id",
			"file_type",
			"version_no",
			"sha256",
			"checksum",
			"raw_path",
			"stored_path",
			"deleted_at",
			"parser_name",
		].map((field) => document[field] ?? null),
	);
}

function fileSignature(path: string): string {
	const stat = statSync(path, { bigint: true });
	return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** Validate source reads before opening the write transaction, then retain only cheap commit guards. */
export async function validateFrameworkEvidenceAsync(
	database: DatabaseSync,
	workspaceRoot: string,
	datasetId: string,
	content: FrameworkContent,
	inputs: ResearchInput[],
	options: ResearchEvidenceOptions = {},
): Promise<(database: DatabaseSync) => void> {
	const { signal, onProgress } = options;
	signal?.throwIfAborted();
	const documents = new Map<string, { signature: string; row: SqlRow }>();
	for (const input of inputs) {
		const row = database
			.prepare("SELECT * FROM documents WHERE dataset_id=? AND doc_id=? AND deleted_at IS NULL")
			.get(datasetId, input.docId) as SqlRow | undefined;
		if (!row) throw new ResearchError(409, `Research source changed: ${input.docId}`);
		documents.set(input.docId, { signature: documentSignature(row), row });
	}
	const evidenceIds = collectFrameworkEvidenceIds(content);
	const workbooks = new Map<string, Map<string, { sheet: string; range: string; evidenceIds: string[] }>>();
	const otherEvidence: string[] = [];
	for (const evidenceId of evidenceIds) {
		const reference = parseSourceId(evidenceId);
		if (!reference || !documents.has(reference.docId))
			throw new ResearchError(400, `Evidence is outside the selected inputs or cannot be resolved: ${evidenceId}`);
		if (reference.location.kind !== "excel") {
			otherEvidence.push(evidenceId);
			continue;
		}
		const bounds = parseExcelCellRange(reference.location.range)!;
		const first = `${excelColumnLabel(bounds.columnStart)}${bounds.rowStart}`;
		const last = `${excelColumnLabel(bounds.columnEnd)}${bounds.rowEnd}`;
		const range = first === last ? first : `${first}:${last}`;
		const sheet = reference.location.sheet;
		const key = JSON.stringify([sheet, range]);
		let workbook = workbooks.get(reference.docId);
		if (!workbook) {
			workbook = new Map();
			workbooks.set(reference.docId, workbook);
		}
		const existing = workbook.get(key);
		if (existing) existing.evidenceIds.push(evidenceId);
		else workbook.set(key, { sheet, range, evidenceIds: [evidenceId] });
	}
	const files = new Map<string, { path: string; signature: string }>();
	for (const docId of workbooks.keys()) {
		const path = documentFilePath(workspaceRoot, documents.get(docId)!.row);
		files.set(docId, { path, signature: fileSignature(path) });
	}
	let completed = 0;
	const total = evidenceIds.length;
	onProgress?.({ completed, total, phase: "validating" });
	for (const evidenceId of otherEvidence) {
		signal?.throwIfAborted();
		if (!resolvePeEvidenceRecord(database, datasetId, evidenceId))
			throw new ResearchError(400, `Evidence is outside the selected inputs or cannot be resolved: ${evidenceId}`);
		completed++;
	}
	for (const [docId, locations] of workbooks) {
		const entries = [...locations.values()];
		for (let offset = 0; offset < entries.length; offset += 2000) {
			signal?.throwIfAborted();
			const batch = entries.slice(offset, offset + 2000);
			const result = await readWorkbookDocumentAsync(
				database,
				datasetId,
				docId,
				{ action: "validate", ranges: batch.map(({ sheet, range }) => ({ sheet, range })) },
				{
					signal,
					onProgress: (event) =>
						onProgress?.({
							completed,
							total,
							docId,
							phase: event.phase === "retry" ? "retry" : "validating",
							attempt: event.attempt,
							elapsedMs: event.elapsedMs,
							cacheHit: event.cacheHit,
						}),
				},
			);
			signal?.throwIfAborted();
			const resolved = new Map<string, boolean>();
			if (Array.isArray(result.ranges)) {
				for (const entry of result.ranges) {
					if (!entry || typeof entry !== "object") continue;
					const value = entry as Record<string, unknown>;
					if (typeof value.sheet === "string" && typeof value.range === "string")
						resolved.set(JSON.stringify([value.sheet, value.range]), value.exists === true);
				}
			}
			for (const entry of batch) {
				if (!resolved.get(JSON.stringify([entry.sheet, entry.range])))
					throw new ResearchError(
						400,
						`Evidence cannot be resolved: ${docId} ${entry.sheet}!${entry.range} (${entry.evidenceIds[0]})`,
					);
				completed += entry.evidenceIds.length;
			}
			onProgress?.({ completed, total, docId, phase: "validated" });
		}
	}
	if (workbooks.size === 0) onProgress?.({ completed, total, phase: "validated" });
	signal?.throwIfAborted();
	return (currentDatabase) => {
		signal?.throwIfAborted();
		for (const [docId, expected] of documents) {
			const current = currentDatabase
				.prepare("SELECT * FROM documents WHERE dataset_id=? AND doc_id=? AND deleted_at IS NULL")
				.get(datasetId, docId) as SqlRow | undefined;
			if (!current || documentSignature(current) !== expected.signature)
				throw new ResearchError(409, `Research source changed during evidence validation: ${docId}`);
			const file = files.get(docId);
			if (
				file &&
				(documentFilePath(workspaceRoot, current) !== file.path || fileSignature(file.path) !== file.signature)
			)
				throw new ResearchError(409, `Original workbook changed during evidence validation: ${docId}`);
		}
		// PDF pages and snapshot citations use inexpensive local checks; workbook reads never repeat here.
		for (const evidenceId of otherEvidence) {
			if (!resolvePeEvidenceRecord(currentDatabase, datasetId, evidenceId))
				throw new ResearchError(409, `Evidence changed during validation: ${evidenceId}`);
		}
	};
}
