import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolvePeEvidenceSources } from "../evidence.ts";
import type { PeSourcePayload } from "../source.ts";
import { openWritablePeDataset, type SqlRow, sourceCitation } from "./database.ts";

const MAX_CONTENT_HTML_CHARS = 50_000;
const MAX_EVIDENCE_IDS = 100;

export type ResearchNotePresentationMode = "text" | "metrics" | "table" | "chart";

export interface SavePeResearchNoteOptions {
	title: string;
	summary: string;
	presentationMode: ResearchNotePresentationMode;
	contentHtml: string;
	evidenceIds: string[];
	datasetId?: string;
}

export interface PeResearchNoteResult {
	dataset_id: string;
	research_note_id: string;
	title: string;
	presentation_mode: ResearchNotePresentationMode;
	research_note_html_path: string;
	resolved_evidence_ids: string[];
	unresolved_evidence_ids: string[];
	message: string;
}

interface EvidenceResolution {
	evidenceId: string;
	resolved: boolean;
	citation?: string;
}

function normalizeText(value: unknown): string {
	return String(value ?? "")
		.normalize("NFKC")
		.replace(/\s+/gu, " ")
		.trim();
}

function uniqueEvidenceIds(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function isInside(root: string, target: string): boolean {
	const relativePath = relative(root, target);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function ensureResearchNotesRoot(workspaceRoot: string): string {
	const generatedCandidate = join(workspaceRoot, "generated");
	mkdirSync(generatedCandidate, { recursive: true });
	const generatedRoot = realpathSync(generatedCandidate);
	if (!isInside(workspaceRoot, generatedRoot)) {
		throw new Error("generated resolves outside the current project workspace");
	}

	const researchNotesCandidate = join(generatedRoot, "research-notes");
	mkdirSync(researchNotesCandidate, { recursive: true });
	const researchNotesRoot = realpathSync(researchNotesCandidate);
	if (!isInside(workspaceRoot, researchNotesRoot)) {
		throw new Error("generated/research-notes resolves outside the current project workspace");
	}
	return researchNotesRoot;
}

function tableExists(database: DatabaseSync, table: string): boolean {
	return database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

function ensureResearchNoteSchema(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS research_notes (
			research_note_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			title TEXT NOT NULL,
			summary TEXT NOT NULL,
			presentation_mode TEXT NOT NULL CHECK (presentation_mode IN ('text', 'metrics', 'table', 'chart')),
			html_path TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_research_notes_dataset_created
			ON research_notes(dataset_id, created_at DESC);

		CREATE TABLE IF NOT EXISTS research_note_evidence (
			research_note_id TEXT NOT NULL,
			evidence_id TEXT NOT NULL,
			resolved INTEGER NOT NULL CHECK (resolved IN (0, 1)),
			citation TEXT,
			PRIMARY KEY (research_note_id, evidence_id)
		);
	`);
}

function activeDocumentPredicate(): string {
	return "d.deleted_at IS NULL AND COALESCE(d.is_current, 1) = 1 AND COALESCE(d.lifecycle_state, 'active') = 'active'";
}

function resolveEvidence(
	database: DatabaseSync,
	datasetId: string,
	evidenceId: string,
	sources: ReadonlyMap<string, PeSourcePayload>,
): EvidenceResolution {
	const source = sources.get(evidenceId);
	if (source) return { evidenceId, resolved: true, citation: source.citation };
	if (
		evidenceId.startsWith("source:") ||
		(/^(page|cell|fact):/u.test(evidenceId) &&
			(database.prepare("PRAGMA table_info(documents)").all() as SqlRow[]).some((row) => row.name === "stored_path"))
	)
		return { evidenceId, resolved: false };
	const separator = evidenceId.indexOf(":");
	if (separator <= 0 || separator === evidenceId.length - 1) return { evidenceId, resolved: false };
	const kind = evidenceId.slice(0, separator);
	const rawId = evidenceId.slice(separator + 1);
	let row: SqlRow | undefined;

	if (kind === "page" && tableExists(database, "pdf_pages")) {
		row = database
			.prepare(
				`SELECT d.original_filename, p.page_number AS page_start, p.page_number AS page_end
				 FROM pdf_pages p
				 JOIN documents d ON d.doc_id=p.doc_id
				 WHERE d.dataset_id=? AND p.page_id=?`,
			)
			.get(datasetId, rawId) as SqlRow | undefined;
	} else if (kind === "chunk" && tableExists(database, "chunks")) {
		row = database
			.prepare(
				`SELECT d.original_filename, d.source_relpath,
				        l.page_start, l.page_end, l.sheet_name, l.cell_range, l.heading_path,
				        c.title_path
				 FROM chunks c
				 JOIN documents d ON d.doc_id=c.doc_id
				 LEFT JOIN chunk_locations l ON l.chunk_id=c.chunk_id
				  AND l.location_index=(SELECT MIN(location_index) FROM chunk_locations WHERE chunk_id=c.chunk_id)
				 WHERE c.dataset_id=? AND c.chunk_id=? AND ${activeDocumentPredicate()}`,
			)
			.get(datasetId, rawId) as SqlRow | undefined;
	} else if (kind === "fact" && tableExists(database, "metric_facts")) {
		row = database
			.prepare(
				`SELECT d.original_filename, d.source_relpath,
				        f.sheet_name, f.cell_ref AS cell_range
				 FROM metric_facts f
				 JOIN documents d ON d.doc_id=f.doc_id
				 WHERE f.dataset_id=? AND f.fact_id=? AND ${activeDocumentPredicate()}`,
			)
			.get(datasetId, rawId) as SqlRow | undefined;
	} else if (kind === "cell" && tableExists(database, "excel_cells")) {
		row = database
			.prepare(
				`SELECT d.original_filename, d.source_relpath,
				        c.sheet_name, c.cell_ref AS cell_range
				 FROM excel_cells c
				 JOIN documents d ON d.doc_id=c.doc_id
				 WHERE c.dataset_id=? AND c.cell_id=? AND ${activeDocumentPredicate()}`,
			)
			.get(datasetId, rawId) as SqlRow | undefined;
	}

	return row ? { evidenceId, resolved: true, citation: sourceCitation(row) } : { evidenceId, resolved: false };
}

function validateHtml(contentHtml: string): void {
	if (!contentHtml.trim()) throw new Error("content_html is required");
	if (contentHtml.length > MAX_CONTENT_HTML_CHARS) {
		throw new Error(`content_html must not exceed ${MAX_CONTENT_HTML_CHARS} characters`);
	}
	if (!/<html(?:\s|>)/iu.test(contentHtml) || !/<\/html\s*>\s*$/iu.test(contentHtml)) {
		throw new Error("content_html must be a complete HTML document ending with </html>");
	}
}

function writeAtomicFile(finalPath: string, content: string): void {
	if (existsSync(finalPath)) throw new Error(`Research Note artifact already exists: ${basename(finalPath)}`);
	const temporaryPath = join(dirname(finalPath), `.${basename(finalPath)}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temporaryPath, finalPath);
	} catch (error) {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		throw error;
	}
}

export async function savePeResearchNote(
	cwd: string,
	options: SavePeResearchNoteOptions,
	signal?: AbortSignal,
): Promise<PeResearchNoteResult> {
	const title = normalizeText(options.title);
	const summary = normalizeText(options.summary);
	if (!title) throw new Error("title is required");
	if (!summary) throw new Error("summary is required");
	validateHtml(options.contentHtml);
	const evidenceIds = uniqueEvidenceIds(options.evidenceIds);
	if (evidenceIds.length > MAX_EVIDENCE_IDS) {
		throw new Error(`evidence_ids must not contain more than ${MAX_EVIDENCE_IDS} items`);
	}

	const connection = openWritablePeDataset(cwd, options.datasetId);
	let transactionOpen = false;
	let committed = false;
	let finalPath: string | undefined;
	try {
		const sources = await resolvePeEvidenceSources(cwd, evidenceIds, signal);
		ensureResearchNoteSchema(connection.database);
		const researchNotesRoot = ensureResearchNotesRoot(connection.workspaceRoot);
		const createdAt = new Date().toISOString();
		const researchNoteId = `rn_${createHash("sha256")
			.update(`${connection.datasetId}\0${title}\0${createdAt}\0${randomUUID()}`)
			.digest("hex")
			.slice(0, 24)}`;
		finalPath = join(researchNotesRoot, `${researchNoteId}.html`);
		if (!isInside(researchNotesRoot, finalPath)) throw new Error("Research Note path escapes its managed directory");
		const htmlRelativePath = relative(connection.workspaceRoot, finalPath).split(sep).join("/");
		const evidence = evidenceIds.map((evidenceId) =>
			resolveEvidence(connection.database, connection.datasetId, evidenceId, sources),
		);

		connection.database.exec("BEGIN IMMEDIATE");
		transactionOpen = true;
		signal?.throwIfAborted();
		connection.database
			.prepare(
				`INSERT INTO research_notes
				 (research_note_id, dataset_id, title, summary, presentation_mode, html_path, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				researchNoteId,
				connection.datasetId,
				title,
				summary,
				options.presentationMode,
				htmlRelativePath,
				createdAt,
			);
		writeAtomicFile(finalPath, options.contentHtml);
		for (const item of evidence) {
			connection.database
				.prepare(
					`INSERT INTO research_note_evidence
					 (research_note_id, evidence_id, resolved, citation)
					 VALUES (?, ?, ?, ?)`,
				)
				.run(researchNoteId, item.evidenceId, item.resolved ? 1 : 0, item.citation ?? null);
		}
		signal?.throwIfAborted();
		connection.database.exec("COMMIT");
		transactionOpen = false;
		committed = true;
		return {
			dataset_id: connection.datasetId,
			research_note_id: researchNoteId,
			title,
			presentation_mode: options.presentationMode,
			research_note_html_path: htmlRelativePath,
			resolved_evidence_ids: evidence.filter((item) => item.resolved).map((item) => item.evidenceId),
			unresolved_evidence_ids: evidence.filter((item) => !item.resolved).map((item) => item.evidenceId),
			message: "Research Note created successfully.",
		};
	} catch (error) {
		if (transactionOpen) {
			try {
				connection.database.exec("ROLLBACK");
			} catch {}
		}
		if (!committed && finalPath && existsSync(finalPath)) unlinkSync(finalPath);
		throw error;
	} finally {
		connection.database.close();
	}
}
