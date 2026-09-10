import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolvePeEvidenceSources, sourceLocationRow } from "../evidence.ts";
import { type PeSourcePayload, parseSourceId } from "../source.ts";
import {
	evidenceLocator,
	numberValue,
	openPeDataset,
	openWritablePeDataset,
	type SqlRow,
	sourceCitation,
	textValue,
} from "./database.ts";
import { renderMemoPdf } from "./memo-pdf.ts";

const MEMO_SOURCE_TYPE = "pe_agent_generated";
const MAX_HISTORY_LIMIT = 100;

export type MemoOperation = "create" | "revise";
export type MemoClaimStatus = "supported" | "not_covered" | "needs_review";

export interface MemoClaimInput {
	section: string;
	text: string;
	status: MemoClaimStatus;
	evidenceIds: string[];
}

export interface SavePeMemoOptions {
	operation: MemoOperation;
	topic: string;
	title?: string;
	datasetId?: string;
	revisionOf?: string;
	asOfDate?: string;
	instructions?: string;
	conversationContext?: string;
	keyQuestions?: string[];
	claims: MemoClaimInput[];
}

interface EvidenceReference {
	doc_id: string;
	evidence_id: string;
	citation: string;
	filename: string;
	locator: ReturnType<typeof evidenceLocator>;
}

export interface ValidatedMemoClaim {
	claim_id: string;
	section: string;
	text: string;
	requested_status: MemoClaimStatus;
	status: MemoClaimStatus;
	evidence_ids: string[];
	invalid_evidence_ids: string[];
	citations: string[];
}

export interface MemoCitationGate {
	status: "passed" | "needs_review";
	passed: boolean;
	repaired: false;
	needs_review: boolean;
	total_claims: number;
	supported_claims: number;
	not_covered_claims: number;
	needs_review_claims: number;
	valid_evidence_ids: string[];
	invalid_evidence_ids: string[];
	violations: Array<{
		claim_id: string;
		reason: "missing_evidence" | "invalid_evidence";
		evidence_ids: string[];
	}>;
	claims: ValidatedMemoClaim[];
}

interface MemoSectionRecord {
	section_key: string;
	title: string;
	sort_order: number;
	content: string;
	evidence_ids: string[];
	needs_review: boolean;
	claims: ValidatedMemoClaim[];
}

export interface MemoVersionPayload {
	dataset_id: string;
	series_id: string;
	topic: string;
	series_title: string;
	memo_version_id: string;
	version_no: number;
	revision_of_version_id?: string;
	as_of_date: string;
	status: string;
	source_type: string;
	markdown_path?: string;
	html_path?: string;
	pdf_path?: string;
	citation_gate_path?: string;
	artifact_paths_available: boolean;
	content_hash: string;
	created_at: string;
	document_versions: Array<Record<string, unknown>>;
	inputs: Record<string, unknown>;
	sections: Array<{
		section_id: string;
		section_key: string;
		title: string;
		sort_order: number;
		content: string;
		evidence_ids: string[];
		needs_review: boolean;
	}>;
}

export interface PeMemoResult {
	dataset_id: string;
	topic: string;
	title: string;
	memo_series_id: string;
	memo_version_id: string;
	memo_version_no: number;
	revision_of_version_id?: string;
	memo_markdown_path?: string;
	memo_html_path?: string;
	memo_pdf_path?: string;
	citation_gate_audit_path?: string;
	citation_gate: MemoCitationGate | Record<string, unknown>;
	idempotent_replay: boolean;
	message: string;
}

export interface MemoHistoryOptions {
	datasetId?: string;
	seriesId?: string;
	topic?: string;
	limit?: number;
}

function digest(parts: readonly unknown[], length = 24): string {
	return createHash("sha256")
		.update(parts.map((part) => String(part ?? "")).join("\0"))
		.digest("hex")
		.slice(0, length);
}

function normalizeText(value: unknown): string {
	return String(value ?? "")
		.normalize("NFKC")
		.replace(/\s+/gu, " ")
		.trim();
}

function canonicalTopic(value: string): string {
	return normalizeText(value)
		.toLowerCase()
		.replace(/[^a-z0-9_\u3400-\u9fff]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 180);
}

function sectionKey(value: string, fallback: string): string {
	return (
		normalizeText(value)
			.toLowerCase()
			.replace(/[^a-z0-9_\u3400-\u9fff]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 72) || fallback
	);
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function jsonRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "string" || !value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function jsonStringArray(value: unknown): string[] {
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function jsonRecordArray(value: unknown): Array<Record<string, unknown>> {
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
		);
	} catch {
		return [];
	}
}

function tableExists(database: DatabaseSync, table: string): boolean {
	return database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

function ensureMemoSchema(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS research_memo_series (
			series_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			series_key TEXT NOT NULL,
			topic TEXT NOT NULL,
			title TEXT NOT NULL,
			current_version_no INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(dataset_id, series_key)
		);

		CREATE TABLE IF NOT EXISTS research_memo_versions (
			memo_version_id TEXT PRIMARY KEY,
			series_id TEXT NOT NULL,
			version_no INTEGER NOT NULL,
			revision_of_version_id TEXT,
			as_of_date TEXT NOT NULL,
			source_type TEXT NOT NULL,
			status TEXT NOT NULL,
			markdown_path TEXT,
			html_path TEXT,
			pdf_path TEXT,
			source_response_id TEXT,
			document_versions_json TEXT NOT NULL DEFAULT '[]',
			input_json TEXT NOT NULL DEFAULT '{}',
			content_hash TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE(series_id, version_no),
			UNIQUE(series_id, content_hash, source_type)
		);

		CREATE TABLE IF NOT EXISTS research_memo_sections (
			section_id TEXT PRIMARY KEY,
			memo_version_id TEXT NOT NULL,
			section_key TEXT NOT NULL,
			title TEXT NOT NULL,
			sort_order INTEGER NOT NULL,
			content TEXT NOT NULL,
			evidence_ids_json TEXT NOT NULL DEFAULT '[]',
			needs_review INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			UNIQUE(memo_version_id, section_key)
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
): EvidenceReference | undefined {
	const source = sources.get(evidenceId);
	if (source) {
		const reference = parseSourceId(evidenceId);
		return {
			doc_id: source.doc_id,
			evidence_id: evidenceId,
			citation: source.citation,
			filename: source.filename,
			locator:
				source.kind === "excel"
					? { sheet_name: source.sheet_name, cell_range: source.cell_range }
					: source.kind === "pdf"
						? { page_start: source.page_start, page_end: source.page_end }
						: reference
							? evidenceLocator(sourceLocationRow(reference))
							: {},
		};
	}
	// Managed citations must not fall back to stale cache rows after a hash or recovery failure.
	if (
		evidenceId.startsWith("source:") ||
		(/^(page|cell|fact):/u.test(evidenceId) &&
			(database.prepare("PRAGMA table_info(documents)").all() as SqlRow[]).some((row) => row.name === "stored_path"))
	)
		return undefined;
	const separator = evidenceId.indexOf(":");
	if (separator <= 0 || separator === evidenceId.length - 1) return undefined;
	const kind = evidenceId.slice(0, separator);
	const rawId = evidenceId.slice(separator + 1);
	let row: SqlRow | undefined;
	if (kind === "page" && tableExists(database, "pdf_pages")) {
		row = database
			.prepare(
				`SELECT d.doc_id, d.original_filename, p.page_number AS page_start, p.page_number AS page_end
				 FROM pdf_pages p
				 JOIN documents d ON d.doc_id=p.doc_id
				 WHERE d.dataset_id=? AND p.page_id=?`,
			)
			.get(datasetId, rawId) as SqlRow | undefined;
	} else if (kind === "chunk" && tableExists(database, "chunks")) {
		row = database
			.prepare(
				`SELECT d.doc_id, c.chunk_id, c.title_path, d.original_filename, d.source_relpath,
				        l.page_start, l.page_end, l.sheet_name, l.cell_range, l.heading_path
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
				`SELECT d.doc_id, f.fact_id, f.sheet_name, f.cell_ref AS cell_range,
				        d.original_filename, d.source_relpath
				 FROM metric_facts f JOIN documents d ON d.doc_id=f.doc_id
				 WHERE f.dataset_id=? AND f.fact_id=? AND ${activeDocumentPredicate()}`,
			)
			.get(datasetId, rawId) as SqlRow | undefined;
	} else if (kind === "cell" && tableExists(database, "excel_cells")) {
		row = database
			.prepare(
				`SELECT d.doc_id, c.cell_id, c.sheet_name, c.cell_ref AS cell_range,
				        d.original_filename, d.source_relpath
				 FROM excel_cells c JOIN documents d ON d.doc_id=c.doc_id
				 WHERE c.dataset_id=? AND c.cell_id=? AND ${activeDocumentPredicate()}`,
			)
			.get(datasetId, rawId) as SqlRow | undefined;
	}
	if (!row) return undefined;
	return {
		doc_id: textValue(row, "doc_id") ?? "",
		evidence_id: evidenceId,
		citation: sourceCitation(row),
		filename: textValue(row, "source_relpath") ?? textValue(row, "original_filename") ?? "unknown source",
		locator: evidenceLocator(row),
	};
}

function validateClaims(
	database: DatabaseSync,
	datasetId: string,
	claims: readonly MemoClaimInput[],
	sources: ReadonlyMap<string, PeSourcePayload>,
	signal?: AbortSignal,
): { citationGate: MemoCitationGate; evidence: Map<string, EvidenceReference> } {
	if (claims.length === 0) throw new Error("memo_claims must contain at least one claim");
	const evidence = new Map<string, EvidenceReference>();
	const invalidIds = new Set<string>();
	const violations: MemoCitationGate["violations"] = [];
	const validated: ValidatedMemoClaim[] = [];

	for (const [index, claim] of claims.entries()) {
		signal?.throwIfAborted();
		const claimId = `claim-${index + 1}`;
		const section = normalizeText(claim.section);
		const text = normalizeText(claim.text);
		if (!section) throw new Error(`${claimId} section is required`);
		if (!text) throw new Error(`${claimId} text is required`);
		const requestedIds = uniqueStrings(claim.evidenceIds);
		const validIds: string[] = [];
		const claimInvalidIds: string[] = [];
		if (claim.status !== "not_covered") {
			for (const evidenceId of requestedIds) {
				let reference = evidence.get(evidenceId);
				if (!reference) {
					reference = resolveEvidence(database, datasetId, evidenceId, sources);
					if (reference) evidence.set(evidenceId, reference);
				}
				if (reference) validIds.push(evidenceId);
				else {
					claimInvalidIds.push(evidenceId);
					invalidIds.add(evidenceId);
				}
			}
		}

		let status = claim.status;
		if (claim.status === "supported" && claimInvalidIds.length > 0) {
			status = "needs_review";
			violations.push({ claim_id: claimId, reason: "invalid_evidence", evidence_ids: claimInvalidIds });
		} else if (claim.status === "supported" && validIds.length === 0) {
			status = "needs_review";
			violations.push({ claim_id: claimId, reason: "missing_evidence", evidence_ids: requestedIds });
		}
		validated.push({
			claim_id: claimId,
			section,
			text,
			requested_status: claim.status,
			status,
			evidence_ids: validIds,
			invalid_evidence_ids: claimInvalidIds,
			citations: validIds.map((evidenceId) => evidence.get(evidenceId)?.citation ?? evidenceId),
		});
	}

	const supportedClaims = validated.filter((claim) => claim.status === "supported").length;
	const notCoveredClaims = validated.filter((claim) => claim.status === "not_covered").length;
	const needsReviewClaims = validated.filter((claim) => claim.status === "needs_review").length;
	const needsReview = needsReviewClaims > 0;
	const passed = violations.length === 0 && invalidIds.size === 0;
	return {
		evidence,
		citationGate: {
			status: needsReview ? "needs_review" : "passed",
			passed,
			repaired: false,
			needs_review: needsReview,
			total_claims: validated.length,
			supported_claims: supportedClaims,
			not_covered_claims: notCoveredClaims,
			needs_review_claims: needsReviewClaims,
			valid_evidence_ids: uniqueStrings(validated.flatMap((claim) => claim.evidence_ids)),
			invalid_evidence_ids: [...invalidIds],
			violations,
			claims: validated,
		},
	};
}

function buildSections(claims: readonly ValidatedMemoClaim[], evidence: ReadonlyMap<string, EvidenceReference>) {
	const grouped = new Map<string, ValidatedMemoClaim[]>();
	for (const claim of claims) {
		const existing = grouped.get(claim.section);
		if (existing) existing.push(claim);
		else grouped.set(claim.section, [claim]);
	}

	const keyCounts = new Map<string, number>();
	const sections: MemoSectionRecord[] = [];
	for (const [index, [title, sectionClaims]] of [...grouped.entries()].entries()) {
		const baseKey = sectionKey(title, `section-${index + 1}`);
		const occurrence = (keyCounts.get(baseKey) ?? 0) + 1;
		keyCounts.set(baseKey, occurrence);
		const key = occurrence === 1 ? baseKey : `${baseKey}-${occurrence}`;
		const content = sectionClaims.map((claim) => renderClaimMarkdown(claim, evidence)).join("\n");
		sections.push({
			section_key: key,
			title,
			sort_order: index + 1,
			content,
			evidence_ids: uniqueStrings(sectionClaims.flatMap((claim) => claim.evidence_ids)),
			needs_review: sectionClaims.some((claim) => claim.status !== "supported"),
			claims: sectionClaims,
		});
	}
	return sections;
}

function markdownText(value: string): string {
	return value.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderClaimMarkdown(claim: ValidatedMemoClaim, evidence: ReadonlyMap<string, EvidenceReference>): string {
	if (claim.status === "not_covered") return `- 资料未覆盖：${markdownText(claim.text)}`;
	const sources = claim.evidence_ids
		.map((evidenceId) => evidence.get(evidenceId))
		.filter((reference): reference is EvidenceReference => reference !== undefined)
		.map((reference) => `${reference.citation}；内容：${claim.text}`)
		.join("；");
	const sourceSuffix = sources ? `（来源：${markdownText(sources)}）` : "";
	const reviewSuffix = claim.status === "needs_review" ? " **（待复核）**" : "";
	return `- ${markdownText(claim.text)}${sourceSuffix}${reviewSuffix}`;
}

function renderMemoMarkdown(options: {
	title: string;
	topic: string;
	datasetId: string;
	memoVersionId: string;
	versionNo: number;
	revisionOf?: string;
	asOfDate: string;
	createdAt: string;
	sections: readonly MemoSectionRecord[];
}): string {
	const lines = [
		`# ${markdownText(options.title)}`,
		"",
		`- 主题：${markdownText(options.topic)}`,
		`- 数据集：${markdownText(options.datasetId)}`,
		`- 版本：v${options.versionNo}`,
		`- Memo version ID：${options.memoVersionId}`,
		...(options.revisionOf ? [`- 修订自：${options.revisionOf}`] : []),
		`- 资料基准日：${options.asOfDate}`,
		`- 生成时间：${options.createdAt}`,
		"",
	];
	for (const section of options.sections) lines.push(`## ${markdownText(section.title)}`, "", section.content, "");
	lines.push(
		"## 资料边界",
		"",
		"- 本 Memo 仅使用当前项目工作区的结构化资料。",
		"- “资料未覆盖”表示当前资料没有覆盖该问题；“待复核”表示引用缺失、无效或结论仍需人工判断。",
		"",
	);
	return lines.join("\n");
}

function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderMemoHtml(options: {
	title: string;
	topic: string;
	datasetId: string;
	memoVersionId: string;
	versionNo: number;
	revisionOf?: string;
	asOfDate: string;
	createdAt: string;
	sections: readonly MemoSectionRecord[];
	evidence: ReadonlyMap<string, EvidenceReference>;
}): string {
	const sectionHtml = options.sections
		.map((section) => {
			const claims = section.claims
				.map((claim) => {
					const sources = claim.evidence_ids
						.map((evidenceId) => options.evidence.get(evidenceId))
						.filter((reference): reference is EvidenceReference => reference !== undefined)
						.map(
							(reference) =>
								`<li><strong>${escapeHtml(reference.citation)}</strong>：${escapeHtml(claim.text)}</li>`,
						)
						.join("");
					const label =
						claim.status === "not_covered"
							? '<strong class="not-covered">资料未覆盖：</strong>'
							: claim.status === "needs_review"
								? '<strong class="needs-review">待复核：</strong>'
								: "";
					return `<li class="claim ${claim.status}"><p>${label}${escapeHtml(claim.text)}</p>${sources ? `<ul class="sources">${sources}</ul>` : ""}</li>`;
				})
				.join("");
			return `<section><h2>${escapeHtml(section.title)}</h2><ol>${claims}</ol></section>`;
		})
		.join("\n");
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
body{margin:0;background:#fff;color:#172033;font:14px/1.7 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:820px;margin:0 auto;padding:40px 48px 56px}.cover{border-bottom:2px solid #283750;padding-bottom:20px;margin-bottom:24px}
h1{font-size:28px;line-height:1.3;margin:0 0 16px}h2{font-size:19px;border-bottom:1px solid #d8dee8;padding-bottom:6px;margin-top:28px}
.meta{border-collapse:collapse;width:100%;font-size:12px}.meta th{text-align:left;color:#596579;width:120px}.meta td,.meta th{padding:3px 8px 3px 0;vertical-align:top}
.claim{margin-bottom:14px}.claim p{margin:0}.sources{color:#596579;font-size:12px;margin-top:4px}.sources li{margin:0}.needs-review,.not-covered{color:#8a4b00}
code{background:#f2f4f7;border-radius:3px;padding:1px 4px}.boundary{border-top:1px solid #d8dee8;margin-top:32px;color:#465166}
</style>
</head>
<body>
<main>
<header class="cover"><h1>${escapeHtml(options.title)}</h1><table class="meta">
<tr><th>主题</th><td>${escapeHtml(options.topic)}</td></tr>
<tr><th>数据集</th><td>${escapeHtml(options.datasetId)}</td></tr>
<tr><th>版本</th><td>v${options.versionNo} (${escapeHtml(options.memoVersionId)})</td></tr>
${options.revisionOf ? `<tr><th>修订自</th><td>${escapeHtml(options.revisionOf)}</td></tr>` : ""}
<tr><th>资料基准日</th><td>${escapeHtml(options.asOfDate)}</td></tr>
<tr><th>生成时间</th><td>${escapeHtml(options.createdAt)}</td></tr>
</table></header>
${sectionHtml}
<section class="boundary"><h2>资料边界</h2><ul><li>本 Memo 仅使用当前项目工作区的结构化资料。</li><li>“资料未覆盖”表示当前资料没有覆盖该问题；“待复核”表示引用缺失、无效或结论仍需人工判断。</li></ul></section>
</main>
</body>
</html>
`;
}

function isInside(root: string, target: string): boolean {
	const relativePath = relative(root, target);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function ensureMemoRoot(workspaceRoot: string): string {
	const generatedCandidate = join(workspaceRoot, "generated");
	mkdirSync(generatedCandidate, { recursive: true });
	const generatedRoot = realpathSync(generatedCandidate);
	if (!isInside(workspaceRoot, generatedRoot)) {
		throw new Error("generated resolves outside the current project workspace");
	}
	const memoCandidate = join(generatedRoot, "memo");
	mkdirSync(memoCandidate, { recursive: true });
	const memoRoot = realpathSync(memoCandidate);
	if (!isInside(workspaceRoot, memoRoot))
		throw new Error("generated/memo resolves outside the current project workspace");
	return memoRoot;
}

function projectRelativePath(workspaceRoot: string, storedPath: string | undefined): string | undefined {
	if (!storedPath) return undefined;
	const absolutePath = isAbsolute(storedPath) ? resolve(storedPath) : resolve(workspaceRoot, storedPath);
	if (!isInside(workspaceRoot, absolutePath)) return undefined;
	return relative(workspaceRoot, absolutePath).split(sep).join("/");
}

function writeAtomicFile(finalPath: string, content: string | Uint8Array): string {
	if (existsSync(finalPath)) throw new Error(`Memo artifact already exists: ${basename(finalPath)}`);
	const temporaryPath = join(dirname(finalPath), `.${basename(finalPath)}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporaryPath, content, { flag: "wx", mode: 0o600 });
		renameSync(temporaryPath, finalPath);
		return finalPath;
	} catch (error) {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		throw error;
	}
}

function documentSnapshot(database: DatabaseSync, citedDocIds: readonly string[]): Array<Record<string, unknown>> {
	const ids = [...new Set(citedDocIds)].filter(Boolean);
	if (ids.length === 0) return [];
	const columns = new Set((database.prepare("PRAGMA table_info(documents)").all() as SqlRow[]).map((row) => row.name));
	const projection = [
		"doc_id",
		"logical_doc_id",
		"version_no",
		"original_filename",
		"document_date",
		"checksum",
		"doc_type",
	].filter((column) => columns.has(column));
	return database
		.prepare(
			`SELECT ${projection.join(", ")} FROM documents WHERE doc_id IN (${ids.map(() => "?").join(",")}) ORDER BY doc_id`,
		)
		.all(...ids);
}

function selectMemoVersion(database: DatabaseSync, datasetId: string, memoVersionId: string): SqlRow | undefined {
	return database
		.prepare(
			`SELECT v.*, s.dataset_id, s.topic, s.title AS series_title
			 FROM research_memo_versions v
			 JOIN research_memo_series s ON s.series_id=v.series_id
			 WHERE s.dataset_id=? AND v.memo_version_id=?`,
		)
		.get(datasetId, memoVersionId) as SqlRow | undefined;
}

function memoVersionPayload(database: DatabaseSync, workspaceRoot: string, row: SqlRow): MemoVersionPayload {
	const memoVersionId = textValue(row, "memo_version_id") ?? "";
	const sectionRows = database
		.prepare("SELECT * FROM research_memo_sections WHERE memo_version_id=? ORDER BY sort_order")
		.all(memoVersionId) as SqlRow[];
	const markdownPath = projectRelativePath(workspaceRoot, textValue(row, "markdown_path"));
	const htmlPath = projectRelativePath(workspaceRoot, textValue(row, "html_path"));
	const pdfPath = projectRelativePath(workspaceRoot, textValue(row, "pdf_path"));
	const inputs = jsonRecord(row.input_json);
	const citationGatePath = projectRelativePath(
		workspaceRoot,
		typeof inputs.citation_gate_path === "string" ? inputs.citation_gate_path : undefined,
	);
	return {
		dataset_id: textValue(row, "dataset_id") ?? "",
		series_id: textValue(row, "series_id") ?? "",
		topic: textValue(row, "topic") ?? "",
		series_title: textValue(row, "series_title") ?? textValue(row, "topic") ?? "",
		memo_version_id: memoVersionId,
		version_no: numberValue(row, "version_no") ?? 0,
		...(textValue(row, "revision_of_version_id")
			? { revision_of_version_id: textValue(row, "revision_of_version_id") }
			: {}),
		as_of_date: textValue(row, "as_of_date") ?? "",
		status: textValue(row, "status") ?? "",
		source_type: textValue(row, "source_type") ?? "",
		...(markdownPath ? { markdown_path: markdownPath } : {}),
		...(htmlPath ? { html_path: htmlPath } : {}),
		...(pdfPath ? { pdf_path: pdfPath } : {}),
		...(citationGatePath ? { citation_gate_path: citationGatePath } : {}),
		artifact_paths_available: markdownPath !== undefined || htmlPath !== undefined || pdfPath !== undefined,
		content_hash: textValue(row, "content_hash") ?? "",
		created_at: textValue(row, "created_at") ?? "",
		document_versions: jsonRecordArray(row.document_versions_json),
		inputs,
		sections: sectionRows.map((section) => ({
			section_id: textValue(section, "section_id") ?? "",
			section_key: textValue(section, "section_key") ?? "",
			title: textValue(section, "title") ?? "",
			sort_order: numberValue(section, "sort_order") ?? 0,
			content: textValue(section, "content") ?? "",
			evidence_ids: jsonStringArray(section.evidence_ids_json),
			needs_review: numberValue(section, "needs_review") === 1,
		})),
	};
}

function memoResult(payload: MemoVersionPayload, idempotentReplay: boolean): PeMemoResult {
	const citationGate =
		payload.inputs.citation_gate !== null && typeof payload.inputs.citation_gate === "object"
			? (payload.inputs.citation_gate as Record<string, unknown>)
			: {};
	return {
		dataset_id: payload.dataset_id,
		topic: payload.topic,
		title: payload.series_title,
		memo_series_id: payload.series_id,
		memo_version_id: payload.memo_version_id,
		memo_version_no: payload.version_no,
		...(payload.revision_of_version_id ? { revision_of_version_id: payload.revision_of_version_id } : {}),
		...(payload.markdown_path ? { memo_markdown_path: payload.markdown_path } : {}),
		...(payload.html_path ? { memo_html_path: payload.html_path } : {}),
		...(payload.pdf_path ? { memo_pdf_path: payload.pdf_path } : {}),
		...(payload.citation_gate_path ? { citation_gate_audit_path: payload.citation_gate_path } : {}),
		citation_gate: citationGate,
		idempotent_replay: idempotentReplay,
		message: idempotentReplay
			? "A Memo with this canonical topic already exists. Returned its current version; use operation='revise' with the exact memo_version_id to create a new version."
			: "Memo version created and registered successfully.",
	};
}

export async function savePeMemo(cwd: string, options: SavePeMemoOptions, signal?: AbortSignal): Promise<PeMemoResult> {
	const topicInput = normalizeText(options.topic);
	if (!topicInput) throw new Error("topic is required");
	if (options.operation === "revise" && !normalizeText(options.revisionOf)) {
		throw new Error("revision_of is required when operation='revise'");
	}
	if (options.operation === "create" && normalizeText(options.revisionOf)) {
		throw new Error("revision_of must be omitted when operation='create'");
	}
	const connection = openWritablePeDataset(cwd, options.datasetId);
	let transactionOpen = false;
	let committed = false;
	let createdVersionDirectory: string | undefined;
	try {
		const sources = await resolvePeEvidenceSources(
			cwd,
			options.claims.flatMap((claim) => claim.evidenceIds),
			signal,
		);
		ensureMemoSchema(connection.database);
		connection.database.exec("BEGIN IMMEDIATE");
		transactionOpen = true;
		signal?.throwIfAborted();

		let seriesId: string;
		let topic = topicInput;
		let title = normalizeText(options.title) || topic;
		let revisionOf: string | undefined;
		let seriesExists = false;
		const topicKey = canonicalTopic(topic);
		if (options.operation === "revise") {
			const target = selectMemoVersion(connection.database, connection.datasetId, normalizeText(options.revisionOf));
			if (!target) throw new Error(`Unknown memo revision target: ${normalizeText(options.revisionOf)}`);
			seriesId = textValue(target, "series_id") ?? "";
			topic = textValue(target, "topic") ?? topic;
			title = normalizeText(options.title) || textValue(target, "series_title") || topic;
			revisionOf = textValue(target, "memo_version_id");
			seriesExists = true;
		} else {
			const existingSeries = (
				connection.database
					.prepare("SELECT * FROM research_memo_series WHERE dataset_id=? ORDER BY updated_at DESC")
					.all(connection.datasetId) as SqlRow[]
			).find(
				(row) =>
					textValue(row, "series_key") === topicKey || canonicalTopic(textValue(row, "topic") ?? "") === topicKey,
			);
			const existing = existingSeries
				? (connection.database
						.prepare(
							"SELECT memo_version_id FROM research_memo_versions WHERE series_id=? ORDER BY version_no DESC LIMIT 1",
						)
						.get(textValue(existingSeries, "series_id") ?? "") as SqlRow | undefined)
				: undefined;
			if (existing) {
				const payload = memoVersionPayload(
					connection.database,
					connection.workspaceRoot,
					selectMemoVersion(
						connection.database,
						connection.datasetId,
						textValue(existing, "memo_version_id") ?? "",
					)!,
				);
				connection.database.exec("COMMIT");
				transactionOpen = false;
				committed = true;
				return memoResult(payload, true);
			}
			seriesId = textValue(existingSeries ?? {}, "series_id") ?? `ms_${digest([connection.datasetId, topicKey])}`;
			seriesExists = existingSeries !== undefined;
		}

		const { citationGate, evidence } = validateClaims(
			connection.database,
			connection.datasetId,
			options.claims,
			sources,
			signal,
		);
		const sections = buildSections(citationGate.claims, evidence);
		const versionRow = connection.database
			.prepare(
				"SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version FROM research_memo_versions WHERE series_id=?",
			)
			.get(seriesId) as SqlRow;
		const versionNo = numberValue(versionRow, "next_version") ?? 1;
		const createdAt = new Date().toISOString();
		const asOfDate = normalizeText(options.asOfDate) || createdAt.slice(0, 10);
		if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOfDate)) throw new Error("as_of_date must use YYYY-MM-DD");
		const claimHash = digest([JSON.stringify(citationGate.claims)], 64);
		const memoVersionId = `mv_${digest([seriesId, versionNo, claimHash])}`;
		const memoRoot = ensureMemoRoot(connection.workspaceRoot);
		const seriesDirectoryCandidate = join(memoRoot, seriesId);
		mkdirSync(seriesDirectoryCandidate, { recursive: true });
		const seriesDirectory = realpathSync(seriesDirectoryCandidate);
		if (!isInside(memoRoot, seriesDirectory)) {
			throw new Error(`Memo series directory resolves outside generated/memo: ${seriesId}`);
		}
		const versionDirectory = join(seriesDirectory, `v${versionNo}`);
		if (existsSync(versionDirectory))
			throw new Error(`Memo version directory already exists: ${seriesId}/v${versionNo}`);
		mkdirSync(versionDirectory, { recursive: true });
		createdVersionDirectory = versionDirectory;
		const relativeVersionDirectory = relative(connection.workspaceRoot, versionDirectory).split(sep).join("/");
		const markdownRelativePath = `${relativeVersionDirectory}/memo.md`;
		const htmlRelativePath = `${relativeVersionDirectory}/memo.html`;
		const pdfRelativePath = `${relativeVersionDirectory}/memo.pdf`;
		const citationGateRelativePath = `${relativeVersionDirectory}/citation-gate.json`;
		const markdown = renderMemoMarkdown({
			title,
			topic,
			datasetId: connection.datasetId,
			memoVersionId,
			versionNo,
			revisionOf,
			asOfDate,
			createdAt,
			sections,
		});
		const html = renderMemoHtml({
			title,
			topic,
			datasetId: connection.datasetId,
			memoVersionId,
			versionNo,
			revisionOf,
			asOfDate,
			createdAt,
			sections,
			evidence,
		});
		const pdf = await renderMemoPdf({
			title,
			topic,
			datasetId: connection.datasetId,
			memoVersionId,
			versionNo,
			revisionOf,
			asOfDate,
			createdAt,
			sections: sections.map((section) => ({
				title: section.title,
				claims: section.claims.map((claim) => ({
					text: claim.text,
					status: claim.status,
					sources: claim.evidence_ids
						.map((evidenceId) => evidence.get(evidenceId))
						.filter((reference): reference is EvidenceReference => reference !== undefined)
						.map((reference) => ({ citation: reference.citation, text: claim.text })),
				})),
			})),
		});
		signal?.throwIfAborted();
		const contentHash = digest([markdown], 64);
		const inputPayload = {
			operation: options.operation,
			instructions: normalizeText(options.instructions),
			conversation_context: normalizeText(options.conversationContext),
			key_questions: uniqueStrings(options.keyQuestions ?? []),
			revision_of: revisionOf ?? "",
			memo_claims: citationGate.claims,
			citation_gate: citationGate,
			citation_gate_path: citationGateRelativePath,
			render_mode: "structured_claims",
		};

		if (!seriesExists) {
			connection.database
				.prepare(
					`INSERT INTO research_memo_series
					 (series_id, dataset_id, series_key, topic, title, current_version_no, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
				)
				.run(seriesId, connection.datasetId, canonicalTopic(topic), topic, title, createdAt, createdAt);
		}
		connection.database
			.prepare(
				`INSERT INTO research_memo_versions
				 (memo_version_id, series_id, version_no, revision_of_version_id, as_of_date,
				  source_type, status, markdown_path, html_path, pdf_path, source_response_id,
				  document_versions_json, input_json, content_hash, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, NULL, ?, ?, ?, ?)`,
			)
			.run(
				memoVersionId,
				seriesId,
				versionNo,
				revisionOf ?? null,
				asOfDate,
				MEMO_SOURCE_TYPE,
				markdownRelativePath,
				htmlRelativePath,
				pdfRelativePath,
				JSON.stringify(
					documentSnapshot(
						connection.database,
						[...evidence.values()].map((source) => source.doc_id),
					),
				),
				JSON.stringify(inputPayload),
				contentHash,
				createdAt,
			);
		for (const section of sections) {
			connection.database
				.prepare(
					`INSERT INTO research_memo_sections
					 (section_id, memo_version_id, section_key, title, sort_order, content,
					  evidence_ids_json, needs_review, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					`msec_${digest([memoVersionId, section.section_key])}`,
					memoVersionId,
					section.section_key,
					section.title,
					section.sort_order,
					section.content,
					JSON.stringify(section.evidence_ids),
					section.needs_review ? 1 : 0,
					createdAt,
				);
		}
		connection.database
			.prepare("UPDATE research_memo_series SET title=?, current_version_no=?, updated_at=? WHERE series_id=?")
			.run(title, versionNo, createdAt, seriesId);

		writeAtomicFile(join(versionDirectory, "memo.md"), markdown);
		writeAtomicFile(join(versionDirectory, "memo.html"), html);
		writeAtomicFile(join(versionDirectory, "memo.pdf"), pdf);
		writeAtomicFile(join(versionDirectory, "citation-gate.json"), `${JSON.stringify(citationGate, null, 2)}\n`);
		signal?.throwIfAborted();
		const row = selectMemoVersion(connection.database, connection.datasetId, memoVersionId);
		if (!row) throw new Error("Memo version could not be reloaded before commit");
		const result = memoResult(memoVersionPayload(connection.database, connection.workspaceRoot, row), false);
		connection.database.exec("COMMIT");
		transactionOpen = false;
		committed = true;
		return result;
	} catch (error) {
		if (transactionOpen) {
			try {
				connection.database.exec("ROLLBACK");
			} catch {}
		}
		if (!committed && createdVersionDirectory && existsSync(createdVersionDirectory)) {
			rmSync(createdVersionDirectory, { recursive: true, force: true });
		}
		throw error;
	} finally {
		connection.database.close();
	}
}

export function listPeMemoHistory(cwd: string, options: MemoHistoryOptions = {}) {
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		if (!tableExists(connection.database, "research_memo_series")) {
			return { dataset_id: connection.datasetId, series: [], versions: [] };
		}
		const topicFilter = canonicalTopic(options.topic ?? "");
		const allSeries = connection.database
			.prepare(
				`SELECT s.*,
				 (SELECT COUNT(*) FROM research_memo_versions v WHERE v.series_id=s.series_id) AS version_count,
				 (SELECT memo_version_id FROM research_memo_versions v WHERE v.series_id=s.series_id ORDER BY version_no DESC LIMIT 1) AS current_memo_version_id
				 FROM research_memo_series s WHERE s.dataset_id=? ORDER BY s.updated_at DESC`,
			)
			.all(connection.datasetId) as SqlRow[];
		const filteredSeries = allSeries.filter((row) => {
			if (options.seriesId && textValue(row, "series_id") !== options.seriesId) return false;
			if (!topicFilter) return true;
			return canonicalTopic(textValue(row, "topic") ?? "").includes(topicFilter);
		});
		const allowedSeries = new Set(filteredSeries.map((row) => textValue(row, "series_id") ?? ""));
		const limit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.trunc(options.limit ?? 20)));
		const versionRows = connection.database
			.prepare(
				`SELECT v.*, s.dataset_id, s.topic, s.title AS series_title
				 FROM research_memo_versions v JOIN research_memo_series s ON s.series_id=v.series_id
				 WHERE s.dataset_id=? ORDER BY v.created_at DESC, v.version_no DESC`,
			)
			.all(connection.datasetId) as SqlRow[];
		const versions = versionRows
			.filter((row) => allowedSeries.has(textValue(row, "series_id") ?? ""))
			.slice(0, limit)
			.map((row) => {
				const payload = memoVersionPayload(connection.database, connection.workspaceRoot, row);
				return {
					memo_version_id: payload.memo_version_id,
					series_id: payload.series_id,
					topic: payload.topic,
					title: payload.series_title,
					version_no: payload.version_no,
					revision_of_version_id: payload.revision_of_version_id,
					as_of_date: payload.as_of_date,
					status: payload.status,
					markdown_path: payload.markdown_path,
					html_path: payload.html_path,
					pdf_path: payload.pdf_path,
					artifact_paths_available: payload.artifact_paths_available,
					created_at: payload.created_at,
					citation_gate: payload.inputs.citation_gate ?? {},
				};
			});
		return {
			dataset_id: connection.datasetId,
			series: filteredSeries.map((row) => ({
				series_id: textValue(row, "series_id") ?? "",
				topic: textValue(row, "topic") ?? "",
				title: textValue(row, "title") ?? "",
				current_version_no: numberValue(row, "current_version_no") ?? 0,
				current_memo_version_id: textValue(row, "current_memo_version_id"),
				version_count: numberValue(row, "version_count") ?? 0,
				updated_at: textValue(row, "updated_at") ?? "",
			})),
			versions,
		};
	} finally {
		connection.database.close();
	}
}

export function getPeMemoVersion(cwd: string, memoVersionId: string, datasetId?: string): MemoVersionPayload {
	const connection = openPeDataset(cwd, datasetId);
	try {
		if (!tableExists(connection.database, "research_memo_versions")) throw new Error("No Memo versions exist");
		const row = selectMemoVersion(connection.database, connection.datasetId, normalizeText(memoVersionId));
		if (!row) throw new Error(`Memo version not found in the current dataset: ${memoVersionId}`);
		return memoVersionPayload(connection.database, connection.workspaceRoot, row);
	} finally {
		connection.database.close();
	}
}

function normalizedContent(value: string): string {
	return value.replace(/\r\n?/gu, "\n").trim();
}

function contentSimilarity(left: string, right: string): number {
	const leftNormalized = normalizeText(left);
	const rightNormalized = normalizeText(right);
	if (leftNormalized === rightNormalized) return 1;
	if (!leftNormalized || !rightNormalized) return 0;
	const shingles = (value: string): Set<string> => {
		const compact = value.replace(/\s+/gu, "");
		const output = new Set<string>();
		for (let index = 0; index < compact.length - 1; index += 1) output.add(compact.slice(index, index + 2));
		return output;
	};
	const leftShingles = shingles(leftNormalized);
	const rightShingles = shingles(rightNormalized);
	const intersection = [...leftShingles].filter((value) => rightShingles.has(value)).length;
	const union = new Set([...leftShingles, ...rightShingles]).size;
	return union === 0 ? 0 : Math.round((intersection / union) * 10_000) / 10_000;
}

export function comparePeMemoVersions(cwd: string, fromVersionId: string, toVersionId: string, datasetId?: string) {
	const connection = openPeDataset(cwd, datasetId);
	try {
		if (!tableExists(connection.database, "research_memo_versions")) throw new Error("No Memo versions exist");
		const fromRow = selectMemoVersion(connection.database, connection.datasetId, normalizeText(fromVersionId));
		const toRow = selectMemoVersion(connection.database, connection.datasetId, normalizeText(toVersionId));
		if (!fromRow || !toRow) throw new Error("Memo version not found in the current dataset");
		if (textValue(fromRow, "series_id") !== textValue(toRow, "series_id")) {
			throw new Error("Memo history comparison requires two versions from the same series");
		}
		const from = memoVersionPayload(connection.database, connection.workspaceRoot, fromRow);
		const to = memoVersionPayload(connection.database, connection.workspaceRoot, toRow);
		const oldSections = new Map(from.sections.map((section) => [section.section_key, section]));
		const newSections = new Map(to.sections.map((section) => [section.section_key, section]));
		const keys = [...newSections.keys(), ...[...oldSections.keys()].filter((key) => !newSections.has(key))];
		const sectionChanges = keys.map((key) => {
			const oldSection = oldSections.get(key);
			const newSection = newSections.get(key);
			let changeType: "added" | "changed" | "unchanged" | "not_mentioned";
			if (!oldSection) changeType = "added";
			else if (!newSection) changeType = "not_mentioned";
			else {
				const sameContent = normalizedContent(oldSection.content) === normalizedContent(newSection.content);
				const sameEvidence =
					JSON.stringify([...oldSection.evidence_ids].sort()) ===
					JSON.stringify([...newSection.evidence_ids].sort());
				changeType = sameContent && sameEvidence ? "unchanged" : "changed";
			}
			return {
				section_key: key,
				title: newSection?.title ?? oldSection?.title ?? key,
				change_type: changeType,
				similarity: oldSection && newSection ? contentSimilarity(oldSection.content, newSection.content) : 0,
				old_content: oldSection?.content ?? "",
				new_content: newSection?.content ?? "",
				old_evidence_ids: oldSection?.evidence_ids ?? [],
				new_evidence_ids: newSection?.evidence_ids ?? [],
			};
		});
		const counts = { added: 0, changed: 0, unchanged: 0, not_mentioned: 0 };
		for (const change of sectionChanges) counts[change.change_type] += 1;
		return {
			dataset_id: connection.datasetId,
			from_version: from,
			to_version: to,
			section_changes: sectionChanges,
			counts,
			not_mentioned_contract:
				"not_mentioned means the section is absent from the newer Memo. It does not mean removed, invalidated, or withdrawn.",
		};
	} finally {
		connection.database.close();
	}
}
