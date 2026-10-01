import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resolvePeEvidenceRecord } from "../evidence.ts";
import { excelParserRevision } from "../excel-processing.ts";
import { parseSourceId } from "../source.ts";
import { openPeDataset, type SqlRow } from "../tools/database.ts";
import { type ResearchEvidenceOptions, validateFrameworkEvidenceAsync } from "./evidence-validation.ts";
import {
	collectFrameworkEvidenceIds,
	type FrameworkContent,
	type FrameworkDraft,
	type FrameworkState,
	type FrameworkVersion,
	getFrameworkItems,
	isFrameworkDocument,
	ResearchError,
	type ResearchInput,
	type StoredFrameworkContent,
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
	for (const evidenceId of collectFrameworkEvidenceIds(content)) {
		// New framework citations use versioned source IDs, so input membership is unambiguous.
		const reference = parseSourceId(evidenceId);
		if (!reference || !allowed.has(reference.docId) || !resolvePeEvidenceRecord(database, datasetId, evidenceId))
			throw new ResearchError(400, `Evidence is outside the selected inputs or cannot be resolved: ${evidenceId}`);
	}
	validateResearchHistory(database, datasetId, content);
}

function validateResearchHistory(database: DatabaseSync, datasetId: string, content: FrameworkContent): void {
	const currentIds = new Set(getFrameworkItems(content).map((item) => item.id));
	const historicalIds = new Set(
		content.sections.evidenceAndChanges.changes
			.flatMap((change) => change.judgmentIds)
			.filter((id) => !currentIds.has(id)),
	);
	if (historicalIds.size > 0) {
		for (const row of database
			.prepare("SELECT content_json FROM research_versions WHERE dataset_id=?")
			.all(datasetId)) {
			const previous = JSON.parse(String(row.content_json)) as StoredFrameworkContent;
			for (const item of getFrameworkItems(previous)) historicalIds.delete(item.id);
			if (historicalIds.size === 0) break;
		}
		if (historicalIds.size > 0)
			throw new ResearchError(
				400,
				"Framework change references an unknown judgment ID in the current document or project history",
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
	return storeResearchDraft(database, datasetId, content, inputs, baseVersionId, now);
}

function storeResearchDraft(
	database: DatabaseSync,
	datasetId: string,
	content: FrameworkContent,
	inputs: ResearchInput[],
	baseVersionId: string | null,
	now: string,
): FrameworkDraft {
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

/** Agent proposals validate expensive source reads asynchronously before acquiring the write lock. */
export async function createResearchDraftAsync(
	cwd: string,
	datasetId: string,
	content: unknown,
	docIds: string[],
	expectedVersionId: string | null,
	options: ResearchEvidenceOptions = {},
): Promise<FrameworkDraft> {
	options.signal?.throwIfAborted();
	// Keep the submitted document stable across awaits and a bounded reader retry.
	const checked = validateFrameworkContent(structuredClone(content));
	const selectedDocIds = [...docIds];
	const inputs = withResearchDatabase(cwd, datasetId, (database) => {
		if (currentResearchVersion(database, datasetId) !== expectedVersionId)
			throw new ResearchError(409, "Framework version changed; reload before creating a draft");
		validateResearchHistory(database, datasetId, checked);
		return captureResearchInputs(database, datasetId, selectedDocIds);
	});
	const connection = openPeDataset(cwd, datasetId);
	let assertEvidenceCurrent: (database: DatabaseSync) => void;
	try {
		assertEvidenceCurrent = await validateFrameworkEvidenceAsync(
			connection.database,
			connection.workspaceRoot,
			datasetId,
			checked,
			inputs,
			options,
		);
	} finally {
		connection.database.close();
	}
	options.signal?.throwIfAborted();
	return withResearchDatabase(cwd, datasetId, (database) =>
		researchTransaction(database, () => {
			options.signal?.throwIfAborted();
			if (currentResearchVersion(database, datasetId) !== expectedVersionId)
				throw new ResearchError(
					409,
					"Framework version changed during evidence validation; reload before creating a draft",
				);
			if (JSON.stringify(captureResearchInputs(database, datasetId, selectedDocIds)) !== JSON.stringify(inputs))
				throw new ResearchError(
					409,
					"Research inputs changed during evidence validation; reload before creating a draft",
				);
			assertEvidenceCurrent(database);
			validateResearchHistory(database, datasetId, checked);
			return storeResearchDraft(database, datasetId, checked, inputs, expectedVersionId, new Date().toISOString());
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
	return withResearchDatabase(cwd, datasetId, (database) =>
		researchTransaction(database, () => {
			const row = database
				.prepare("SELECT * FROM research_drafts WHERE dataset_id=? AND draft_id=?")
				.get(datasetId, draftId);
			if (!row) throw new ResearchError(404, "Draft not found");
			const previous = draft(row);
			if (!isFrameworkDocument(previous.content) && !reject)
				throw new ResearchError(
					409,
					"Legacy framework drafts are read-only; propose a complete seven-section document",
				);
			if (previous.status !== "open" || previous.revision !== revision)
				throw new ResearchError(409, "Draft changed; reload before saving");
			const checked = reject ? previous.content : validateFrameworkContent(content);
			if (!reject && isFrameworkDocument(checked))
				validateResearchEvidence(database, datasetId, checked, previous.inputs);
			if (reject)
				database
					.prepare("UPDATE research_drafts SET revision=revision+1,status='rejected' WHERE draft_id=?")
					.run(draftId);
			else
				database
					.prepare("UPDATE research_drafts SET content_json=?,revision=revision+1 WHERE draft_id=?")
					.run(JSON.stringify(checked), draftId);
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
	iteration?: { runId: string; leaseToken?: string; automatic: boolean };
}
export function publishResearchDraft(cwd: string, datasetId: string, input: PublishResearchDraft): FrameworkVersion {
	return publishResearchDraftWithEvidence(cwd, datasetId, input);
}

function publicationRequestJson(input: PublishResearchDraft): string {
	if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.requestId))
		throw new ResearchError(400, "Invalid publication request ID");
	if (
		input.continuation &&
		[input.continuation.sessionId, input.continuation.toolCallId].some(
			(id) => typeof id !== "string" || !id.trim() || id.length > 256,
		)
	)
		throw new ResearchError(400, "Invalid continuation target");
	return JSON.stringify(input);
}

/** User confirmation shares the proposal's cancellable source validation, without long write transactions. */
export async function publishResearchDraftAsync(
	cwd: string,
	datasetId: string,
	input: PublishResearchDraft,
	options: ResearchEvidenceOptions = {},
): Promise<FrameworkVersion> {
	options.signal?.throwIfAborted();
	const request = structuredClone(input);
	const requestJson = publicationRequestJson(request);
	const pending = withResearchDatabase(cwd, datasetId, (database) => {
		const existing = database
			.prepare("SELECT * FROM research_versions WHERE dataset_id=? AND request_id=?")
			.get(datasetId, request.requestId);
		if (existing) {
			if (existing.request_json !== requestJson)
				throw new ResearchError(409, "Publication request ID already used for different input");
			return { published: version(existing) };
		}
		const row = database
			.prepare("SELECT * FROM research_drafts WHERE dataset_id=? AND draft_id=?")
			.get(datasetId, request.draftId);
		if (!row) throw new ResearchError(404, "Draft not found");
		const candidate = draft(row);
		const current = currentResearchVersion(database, datasetId);
		if (
			candidate.status !== "open" ||
			candidate.revision !== request.revision ||
			candidate.baseVersionId !== current ||
			current !== request.expectedVersionId
		)
			throw new ResearchError(409, "Draft or published version changed; your draft was preserved");
		if (!isFrameworkDocument(candidate.content))
			throw new ResearchError(
				409,
				"Legacy framework drafts are read-only; propose a complete seven-section document",
			);
		if (request.selectedItemIds !== undefined)
			throw new ResearchError(
				400,
				"Confirm the complete seven-section document; partial acceptance would separate linked judgments and sections",
			);
		const content = validateFrameworkContent(candidate.content);
		const freshInputs = captureResearchInputs(
			database,
			datasetId,
			candidate.inputs.map((entry) => entry.docId),
		);
		if (JSON.stringify(candidate.inputs) !== JSON.stringify(freshInputs))
			throw new ResearchError(409, "Input preparation changed; create a new draft from the current evidence");
		validateResearchHistory(database, datasetId, content);
		return { candidate, content };
	});
	if (pending.published) return pending.published;
	const connection = openPeDataset(cwd, datasetId);
	let assertEvidenceCurrent: (database: DatabaseSync) => void;
	try {
		assertEvidenceCurrent = await validateFrameworkEvidenceAsync(
			connection.database,
			connection.workspaceRoot,
			datasetId,
			pending.content,
			pending.candidate.inputs,
			options,
		);
	} finally {
		connection.database.close();
	}
	options.signal?.throwIfAborted();
	return publishResearchDraftWithEvidence(cwd, datasetId, request, (database, candidate) => {
		options.signal?.throwIfAborted();
		if (
			JSON.stringify(candidate.content) !== JSON.stringify(pending.content) ||
			JSON.stringify(candidate.inputs) !== JSON.stringify(pending.candidate.inputs)
		)
			throw new ResearchError(409, "Draft changed during evidence validation; your draft was preserved");
		assertEvidenceCurrent(database);
		validateResearchHistory(database, datasetId, pending.content);
	});
}

function publishResearchDraftWithEvidence(
	cwd: string,
	datasetId: string,
	input: PublishResearchDraft,
	assertEvidenceCurrent?: (database: DatabaseSync, candidate: FrameworkDraft) => void,
): FrameworkVersion {
	const requestJson = publicationRequestJson(input);
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
			if (input.iteration) {
				const guard = input.iteration;
				const run = database
					.prepare("SELECT * FROM framework_iterations WHERE id=? AND dataset_id=?")
					.get(guard.runId, datasetId);
				const record = run
					? (JSON.parse(String(run.record_json)) as {
							draftId: string | null;
							automatic: boolean;
							basisVersionId: string;
						})
					: null;
				const allowed = guard.automatic
					? run?.status === "running" &&
						run.lease_token === guard.leaseToken &&
						Number(run.lease_until) > Date.now() &&
						database
							.prepare("SELECT test_project FROM framework_iteration_settings WHERE dataset_id=?")
							.get(datasetId)?.test_project === 1
					: run?.status === "review_required";
				if (
					!allowed ||
					!record ||
					record.draftId !== input.draftId ||
					record.automatic !== guard.automatic ||
					record.basisVersionId !== input.expectedVersionId
				)
					throw new ResearchError(409, "Iteration cancelled, expired, or changed; draft preserved");
			}
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
			if (!isFrameworkDocument(candidate.content))
				throw new ResearchError(
					409,
					"Legacy framework drafts are read-only; propose a complete seven-section document",
				);
			const content = candidate.content;
			const inputs = candidate.inputs;
			if (input.selectedItemIds !== undefined) {
				throw new ResearchError(
					400,
					"Confirm the complete seven-section document; partial acceptance would separate linked judgments and sections",
				);
			}
			validateFrameworkContent(content);
			const freshInputs = captureResearchInputs(
				database,
				datasetId,
				inputs.map((entry) => entry.docId),
			);
			if (JSON.stringify(inputs) !== JSON.stringify(freshInputs))
				throw new ResearchError(409, "Input preparation changed; create a new draft from the current evidence");
			if (assertEvidenceCurrent) assertEvidenceCurrent(database, candidate);
			else validateResearchEvidence(database, datasetId, content, inputs);
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
			if (input.iteration) {
				database
					.prepare(`UPDATE framework_iterations SET status='published',lease_token=NULL,lease_until=0,
				 record_json=json_set(record_json,'$.status','published','$.versionId',?,'$.error',NULL,'$.updatedAt',?)
				 WHERE id=? AND dataset_id=?`)
					.run(result.id, result.createdAt, input.iteration.runId, datasetId);
				database
					.prepare(
						"UPDATE framework_iteration_attempts SET finished_at=?,status='published' WHERE run_id=? AND finished_at IS NULL",
					)
					.run(result.createdAt, input.iteration.runId);
			}
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
			if (!isFrameworkDocument(previous.content))
				throw new ResearchError(
					409,
					"Legacy framework versions are read-only; propose a complete seven-section document",
				);
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
