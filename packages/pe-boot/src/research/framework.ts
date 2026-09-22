import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resolvePeEvidenceRecord } from "../evidence.ts";
import { excelParserRevision } from "../excel-processing.ts";
import { parseSourceId } from "../source.ts";
import type { SqlRow } from "../tools/database.ts";
import {
	type FrameworkContent,
	type FrameworkDraft,
	type FrameworkState,
	type FrameworkVersion,
	ResearchError,
	type ResearchInput,
	validateFrameworkContent,
} from "./model.ts";
import { researchTransaction, withResearchDatabase } from "./storage.ts";

function draft(row: SqlRow): FrameworkDraft {
	return {
		id: String(row.draft_id),
		baseVersionId: row.base_version_id as string | null,
		revision: Number(row.revision),
		status: row.status as FrameworkDraft["status"],
		content: JSON.parse(String(row.content_json)),
		inputs: JSON.parse(String(row.inputs_json)),
		createdAt: String(row.created_at),
	};
}
function version(row: SqlRow): FrameworkVersion {
	return {
		id: String(row.version_id),
		version: Number(row.version_no),
		parentVersionId: row.parent_version_id as string | null,
		content: JSON.parse(String(row.content_json)),
		inputs: JSON.parse(String(row.inputs_json)),
		createdAt: String(row.created_at),
	};
}
export function currentResearchVersion(database: DatabaseSync, datasetId: string): string | null {
	return (
		(database.prepare("SELECT current_version_id FROM research_frameworks WHERE dataset_id=?").get(datasetId)
			?.current_version_id as string | null) ?? null
	);
}

export function captureResearchInputs(database: DatabaseSync, datasetId: string, docIds: string[]): ResearchInput[] {
	if (!Array.isArray(docIds) || docIds.length > 100 || docIds.some((id) => typeof id !== "string"))
		throw new ResearchError(400, "Select at most 100 document versions");
	return [...new Set(docIds)].map((docId) => {
		const row = database
			.prepare("SELECT * FROM documents WHERE dataset_id=? AND doc_id=? AND deleted_at IS NULL")
			.get(datasetId, docId);
		const workbook = row?.file_type === "xlsx" || row?.file_type === "xlsm";
		if (
			!row ||
			(!["pdf", "xlsx", "xlsm"].includes(String(row.file_type)) &&
				!(row.file_type === "txt" && row.parser_name === "wind_snapshot")) ||
			(!workbook && !["completed", "completed_with_warnings"].includes(String(row.status)))
		)
			throw new ResearchError(409, `Document version is not ready for research: ${docId}`);
		return {
			docId,
			version: Number(row.version_no),
			parserVersion: workbook ? excelParserRevision() : (row.parser_version as string | null),
			// Source workbooks are versioned at registration; query cache writes do not change the input.
			readyAt: String(workbook ? row.created_at : row.updated_at),
			...(workbook ? { sourceChecksum: String(row.sha256 || row.checksum) } : {}),
		};
	});
}

export function validateResearchEvidence(
	database: DatabaseSync,
	datasetId: string,
	content: FrameworkContent,
	inputs: ResearchInput[],
): void {
	const allowed = new Set(inputs.map((input) => input.docId));
	for (const item of content.items)
		for (const evidenceId of item.evidenceIds) {
			// New framework citations use versioned source IDs, so input membership is unambiguous.
			const reference = parseSourceId(evidenceId);
			if (!reference || !allowed.has(reference.docId) || !resolvePeEvidenceRecord(database, datasetId, evidenceId))
				throw new ResearchError(
					400,
					`Evidence is outside the selected inputs or cannot be resolved: ${evidenceId}`,
				);
		}
}

export function insertResearchDraft(
	database: DatabaseSync,
	datasetId: string,
	content: FrameworkContent,
	inputs: ResearchInput[],
	baseVersionId: string | null,
	now: string,
): FrameworkDraft {
	validateFrameworkContent(content);
	validateResearchEvidence(database, datasetId, content, inputs);
	const value: FrameworkDraft = {
		id: randomUUID(),
		baseVersionId,
		revision: 1,
		status: "open",
		content,
		inputs,
		createdAt: now,
	};
	database
		.prepare("INSERT INTO research_drafts VALUES(?,?,?,1,'open',?,?,?)")
		.run(value.id, datasetId, baseVersionId, JSON.stringify(content), JSON.stringify(inputs), now);
	return value;
}

export function getResearchFramework(cwd: string, datasetId: string): FrameworkState {
	return withResearchDatabase(cwd, datasetId, (database) => ({
		currentVersionId: currentResearchVersion(database, datasetId),
		drafts: database
			.prepare("SELECT * FROM research_drafts WHERE dataset_id=? ORDER BY created_at DESC")
			.all(datasetId)
			.map(draft),
		versions: database
			.prepare("SELECT * FROM research_versions WHERE dataset_id=? ORDER BY version_no DESC")
			.all(datasetId)
			.map(version),
	}));
}

export function createResearchDraft(
	cwd: string,
	datasetId: string,
	content: unknown,
	docIds: string[],
	expectedVersionId: string | null,
	expectedInputs?: ResearchInput[],
): FrameworkDraft {
	const checked = validateFrameworkContent(content);
	return withResearchDatabase(cwd, datasetId, (database) =>
		researchTransaction(database, () => {
			if (currentResearchVersion(database, datasetId) !== expectedVersionId)
				throw new ResearchError(409, "Framework version changed; reload before creating a draft");
			const inputs = captureResearchInputs(database, datasetId, docIds);
			if (expectedInputs && JSON.stringify(inputs) !== JSON.stringify(expectedInputs))
				throw new ResearchError(409, "Research input preparation changed during analysis");
			return insertResearchDraft(database, datasetId, checked, inputs, expectedVersionId, new Date().toISOString());
		}),
	);
}

export function updateResearchDraft(
	cwd: string,
	datasetId: string,
	draftId: string,
	revision: number,
	content: unknown,
	reject = false,
): FrameworkDraft {
	const checked = validateFrameworkContent(content);
	return withResearchDatabase(cwd, datasetId, (database) =>
		researchTransaction(database, () => {
			const row = database
				.prepare("SELECT * FROM research_drafts WHERE dataset_id=? AND draft_id=?")
				.get(datasetId, draftId);
			if (!row) throw new ResearchError(404, "Draft not found");
			const previous = draft(row);
			if (previous.status !== "open" || previous.revision !== revision)
				throw new ResearchError(409, "Draft changed; reload before saving");
			validateResearchEvidence(database, datasetId, checked, previous.inputs);
			database
				.prepare("UPDATE research_drafts SET content_json=?,revision=revision+1,status=? WHERE draft_id=?")
				.run(JSON.stringify(checked), reject ? "rejected" : "open", draftId);
			return { ...previous, content: checked, revision: revision + 1, status: reject ? "rejected" : "open" };
		}),
	);
}

export interface PublishResearchDraft {
	draftId: string;
	revision: number;
	expectedVersionId: string | null;
	requestId: string;
	selectedItemIds?: string[];
	continuation?: { sessionId: string; toolCallId: string };
	monitorRunId?: string;
}
export function publishResearchDraft(cwd: string, datasetId: string, input: PublishResearchDraft): FrameworkVersion {
	if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.requestId))
		throw new ResearchError(400, "Invalid publication request ID");
	const requestJson = JSON.stringify(input);
	if (
		input.continuation &&
		[input.continuation.sessionId, input.continuation.toolCallId].some(
			(id) => typeof id !== "string" || !id.trim() || id.length > 256,
		)
	)
		throw new ResearchError(400, "Invalid continuation target");
	return withResearchDatabase(cwd, datasetId, (database) =>
		researchTransaction(database, () => {
			const existing = database
				.prepare("SELECT * FROM research_versions WHERE dataset_id=? AND request_id=?")
				.get(datasetId, input.requestId);
			if (existing) {
				if (existing.request_json !== requestJson)
					throw new ResearchError(409, "Publication request ID already used for different input");
				return version(existing);
			}
			if (
				input.monitorRunId &&
				!database
					.prepare(`SELECT 1 FROM research_monitor_runs r
				JOIN research_monitor_plans p ON p.dataset_id=r.dataset_id
				WHERE r.dataset_id=? AND r.run_id=? AND r.status='running' AND r.lease_until>?
				AND p.enabled=1 AND p.revision=r.plan_revision AND json_extract(p.config_json,'$.mode')='auto'`)
					.get(datasetId, input.monitorRunId, Date.now())
			)
				throw new ResearchError(409, "Monitor paused, changed, or lease expired; draft preserved");
			const row = database
				.prepare("SELECT * FROM research_drafts WHERE dataset_id=? AND draft_id=?")
				.get(datasetId, input.draftId);
			if (!row) throw new ResearchError(404, "Draft not found");
			const candidate = draft(row);
			const current = currentResearchVersion(database, datasetId);
			if (
				candidate.status !== "open" ||
				candidate.revision !== input.revision ||
				candidate.baseVersionId !== current ||
				current !== input.expectedVersionId
			)
				throw new ResearchError(409, "Draft or published version changed; your draft was preserved");
			const previous = current
				? database
						.prepare("SELECT * FROM research_versions WHERE dataset_id=? AND version_id=?")
						.get(datasetId, current)
				: undefined;
			let content = candidate.content;
			let inputs = candidate.inputs;
			if (input.selectedItemIds !== undefined) {
				if (
					!previous ||
					!Array.isArray(input.selectedItemIds) ||
					input.selectedItemIds.length === 0 ||
					input.selectedItemIds.some((id) => typeof id !== "string")
				)
					throw new ResearchError(400, "Partial acceptance requires a published version and selected item IDs");
				const base = version(previous);
				const selected = new Set(input.selectedItemIds);
				const allIds = new Set([...base.content.items, ...candidate.content.items].map((item) => item.id));
				if ([...selected].some((id) => !allIds.has(id)))
					throw new ResearchError(400, "Unknown selected framework item");
				content = {
					...base.content,
					items: [
						...base.content.items.filter((item) => !selected.has(item.id)),
						...candidate.content.items.filter((item) => selected.has(item.id)),
					],
				};
				inputs = [...new Map([...base.inputs, ...inputs].map((entry) => [entry.docId, entry])).values()];
			}
			validateFrameworkContent(content);
			const freshInputs = captureResearchInputs(
				database,
				datasetId,
				inputs.map((entry) => entry.docId),
			);
			if (JSON.stringify(inputs) !== JSON.stringify(freshInputs))
				throw new ResearchError(409, "Input preparation changed; create a new draft from the current evidence");
			validateResearchEvidence(database, datasetId, content, inputs);
			const result: FrameworkVersion = {
				id: randomUUID(),
				version: previous ? Number(previous.version_no) + 1 : 1,
				parentVersionId: current,
				content,
				inputs,
				createdAt: new Date().toISOString(),
			};
			database
				.prepare("INSERT INTO research_versions VALUES(?,?,?,?,?,?,?,?,?)")
				.run(
					result.id,
					datasetId,
					result.version,
					current,
					JSON.stringify(content),
					JSON.stringify(inputs),
					result.createdAt,
					input.requestId,
					requestJson,
				);
			database
				.prepare("UPDATE research_frameworks SET current_version_id=? WHERE dataset_id=?")
				.run(result.id, datasetId);
			database
				.prepare("UPDATE research_drafts SET status='published',revision=revision+1 WHERE draft_id=?")
				.run(candidate.id);
			if (input.continuation)
				database
					.prepare("INSERT INTO research_continuations VALUES(?,?,?,?,?,'pending',NULL,?)")
					.run(
						result.id,
						datasetId,
						candidate.id,
						input.continuation.sessionId,
						input.continuation.toolCallId,
						result.createdAt,
					);
			// Unaccepted edits remain in a new stale draft and require explicit realignment before publishing.
			if (input.selectedItemIds)
				insertResearchDraft(database, datasetId, candidate.content, candidate.inputs, current, result.createdAt);
			return result;
		}),
	);
}

export interface ResearchContinuation {
	versionId: string;
	draftId: string;
	sessionId: string;
	toolCallId: string;
	status: "pending" | "sending" | "delivered" | "failed";
	error: string | null;
}

export function listResearchContinuations(cwd: string, datasetId: string): ResearchContinuation[] {
	return withResearchDatabase(cwd, datasetId, (database) =>
		database
			.prepare("SELECT * FROM research_continuations WHERE dataset_id=?")
			.all(datasetId)
			.map((row) => ({
				versionId: String(row.version_id),
				draftId: String(row.draft_id),
				sessionId: String(row.session_id),
				toolCallId: String(row.tool_call_id),
				status: row.status as ResearchContinuation["status"],
				error: row.error as string | null,
			})),
	);
}

export function transitionResearchContinuation(
	cwd: string,
	datasetId: string,
	versionId: string,
	from: ResearchContinuation["status"],
	to: ResearchContinuation["status"],
	error: string | null = null,
): boolean {
	return withResearchDatabase(
		cwd,
		datasetId,
		(database) =>
			database
				.prepare(
					"UPDATE research_continuations SET status=?,error=?,updated_at=? WHERE dataset_id=? AND version_id=? AND status=?",
				)
				.run(to, error, new Date().toISOString(), datasetId, versionId, from).changes === 1,
	);
}

export function restoreResearchVersion(
	cwd: string,
	datasetId: string,
	versionId: string,
	expectedVersionId: string | null,
): FrameworkDraft {
	return withResearchDatabase(cwd, datasetId, (database) =>
		researchTransaction(database, () => {
			if (currentResearchVersion(database, datasetId) !== expectedVersionId)
				throw new ResearchError(409, "Framework version changed");
			const row = database
				.prepare("SELECT * FROM research_versions WHERE dataset_id=? AND version_id=?")
				.get(datasetId, versionId);
			if (!row) throw new ResearchError(404, "Version not found");
			const previous = version(row);
			return insertResearchDraft(
				database,
				datasetId,
				previous.content,
				previous.inputs,
				expectedVersionId,
				new Date().toISOString(),
			);
		}),
	);
}
