import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SqlRow } from "../tools/database.ts";
import { captureResearchInputs, currentResearchVersion, insertResearchDraft } from "./framework.ts";
import { type FrameworkContent, ResearchError, type ResearchInput, type StoredFrameworkContent } from "./model.ts";
import { researchTransaction, withResearchDatabase } from "./storage.ts";

export interface ResearchJobInput {
	objective: string;
	inputs: ResearchInput[];
	asOf: string;
	memos?: Array<{ versionId: string; title: string; content: string }>;
}
export interface ResearchJob {
	id: string;
	kind: "generate" | "review";
	basisVersionId: string | null;
	input: ResearchJobInput;
	status: "queued" | "running" | "retry_wait" | "succeeded" | "failed" | "cancelled";
	attempt: number;
	nextRunAt: number;
	leaseToken: string | null;
	leaseExpiresAt: number | null;
	result: { draftId: string } | null;
	error: string | null;
}
export interface ResearchEngine {
	generate(
		input: ResearchJobInput,
		basis: StoredFrameworkContent | null,
		signal: AbortSignal,
		onProgress?: (detail: string) => void,
	): Promise<FrameworkContent>;
}
function job(row: SqlRow): ResearchJob {
	return {
		id: String(row.job_id),
		kind: row.kind as ResearchJob["kind"],
		basisVersionId: row.basis_version_id as string | null,
		input: JSON.parse(String(row.input_json)),
		status: row.status as ResearchJob["status"],
		attempt: Number(row.attempt),
		nextRunAt: Number(row.next_run_at),
		leaseToken: row.lease_token as string | null,
		leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
		result: row.result_json ? JSON.parse(String(row.result_json)) : null,
		error: row.error as string | null,
	};
}

export function enqueueResearchJob(
	cwd: string,
	datasetId: string,
	objective: string,
	docIds: string[],
	requestId: string,
	expectedVersionId: string | null,
): ResearchJob {
	if (
		typeof objective !== "string" ||
		!objective.trim() ||
		objective.length > 8_000 ||
		typeof requestId !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId)
	)
		throw new ResearchError(400, "A research objective and request ID are required");
	return withResearchDatabase(cwd, datasetId, (database) =>
		researchTransaction(database, () => {
			const existing = database
				.prepare("SELECT * FROM research_jobs WHERE dataset_id=? AND dedupe_key=?")
				.get(datasetId, requestId);
			if (existing) {
				const previous = job(existing);
				if (
					previous.input.objective !== objective ||
					previous.basisVersionId !== expectedVersionId ||
					JSON.stringify(previous.input.inputs.map((entry) => entry.docId)) !==
						JSON.stringify([...new Set(docIds)])
				)
					throw new ResearchError(409, "Request ID already used for different research input");
				return previous;
			}
			if (currentResearchVersion(database, datasetId) !== expectedVersionId)
				throw new ResearchError(409, "Framework version changed");
			const now = Date.now();
			const input: ResearchJobInput = {
				objective,
				inputs: captureResearchInputs(database, datasetId, docIds),
				asOf: new Date(now).toISOString(),
			};
			const id = randomUUID();
			database
				.prepare(`INSERT INTO research_jobs(job_id,dataset_id,kind,dedupe_key,basis_version_id,input_json,status,next_run_at,created_at,updated_at)
		 VALUES(?,?,?,?,?,?,'queued',?,?,?)`)
				.run(
					id,
					datasetId,
					expectedVersionId ? "review" : "generate",
					requestId,
					expectedVersionId,
					JSON.stringify(input),
					now,
					input.asOf,
					input.asOf,
				);
			return job(database.prepare("SELECT * FROM research_jobs WHERE job_id=?").get(id)!);
		}),
	);
}

export function listResearchJobs(cwd: string, datasetId: string): ResearchJob[] {
	return withResearchDatabase(cwd, datasetId, (database) =>
		database
			.prepare("SELECT * FROM research_jobs WHERE dataset_id=? ORDER BY created_at DESC LIMIT 100")
			.all(datasetId)
			.map(job),
	);
}
export function cancelResearchJob(cwd: string, datasetId: string, jobId: string): void {
	withResearchDatabase(cwd, datasetId, (database) =>
		researchTransaction(database, () => {
			const row = database
				.prepare("SELECT * FROM research_jobs WHERE dataset_id=? AND job_id=?")
				.get(datasetId, jobId);
			if (!row) throw new ResearchError(404, "Research job not found");
			if (row.status === "cancelled") return;
			if (row.status === "succeeded" || row.status === "failed")
				throw new ResearchError(409, "Completed jobs cannot be cancelled");
			database
				.prepare(
					"UPDATE research_jobs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=?",
				)
				.run(new Date().toISOString(), jobId);
			database
				.prepare(
					"UPDATE research_job_attempts SET finished_at=?,error='Cancelled' WHERE job_id=? AND finished_at IS NULL",
				)
				.run(new Date().toISOString(), jobId);
		}),
	);
}

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;
export function claimResearchJob(cwd: string, datasetId: string, now = Date.now()): ResearchJob | null {
	return withResearchDatabase(cwd, datasetId, (database) =>
		researchTransaction(database, () => {
			const expired = database
				.prepare(
					"SELECT job_id,attempt FROM research_jobs WHERE dataset_id=? AND status='running' AND lease_expires_at<=?",
				)
				.all(datasetId, now);
			for (const row of expired) {
				database
					.prepare(
						"UPDATE research_job_attempts SET finished_at=?,error='Lease expired' WHERE job_id=? AND attempt=?",
					)
					.run(new Date(now).toISOString(), row.job_id, row.attempt);
				database
					.prepare(
						"UPDATE research_jobs SET status=?,lease_token=NULL,lease_expires_at=NULL,error='Lease expired',updated_at=? WHERE job_id=?",
					)
					.run(
						Number(row.attempt) >= MAX_ATTEMPTS ? "failed" : "retry_wait",
						new Date(now).toISOString(),
						row.job_id,
					);
			}
			const row = database
				.prepare(
					"SELECT * FROM research_jobs WHERE dataset_id=? AND status IN ('queued','retry_wait') AND next_run_at<=? AND attempt<? ORDER BY next_run_at,created_at LIMIT 1",
				)
				.get(datasetId, now, MAX_ATTEMPTS);
			if (!row) return null;
			const token = randomUUID();
			database
				.prepare(
					"UPDATE research_jobs SET status='running',attempt=attempt+1,lease_token=?,lease_expires_at=?,updated_at=? WHERE job_id=?",
				)
				.run(token, now + LEASE_MS, new Date(now).toISOString(), row.job_id);
			database
				.prepare("INSERT INTO research_job_attempts(job_id,attempt,lease_token,started_at) VALUES(?,?,?,?)")
				.run(row.job_id, Number(row.attempt) + 1, token, new Date(now).toISOString());
			return job(database.prepare("SELECT * FROM research_jobs WHERE job_id=?").get(row.job_id)!);
		}),
	);
}

function ownsLease(database: DatabaseSync, datasetId: string, claim: ResearchJob, now: number): boolean {
	return !!database
		.prepare(
			"SELECT 1 FROM research_jobs WHERE dataset_id=? AND job_id=? AND status='running' AND lease_token=? AND lease_expires_at>?",
		)
		.get(datasetId, claim.id, claim.leaseToken, now);
}

export function finishResearchJob(
	cwd: string,
	datasetId: string,
	claim: ResearchJob,
	content: FrameworkContent,
	now = Date.now(),
): string {
	return withResearchDatabase(cwd, datasetId, (database) =>
		researchTransaction(database, () => {
			if (!ownsLease(database, datasetId, claim, now))
				throw new ResearchError(409, "Research lease expired or job cancelled");
			const fresh = captureResearchInputs(
				database,
				datasetId,
				claim.input.inputs.map((entry) => entry.docId),
			);
			if (JSON.stringify(fresh) !== JSON.stringify(claim.input.inputs))
				throw new ResearchError(409, "Research input preparation changed");
			const result = insertResearchDraft(
				database,
				datasetId,
				content,
				claim.input.inputs,
				claim.basisVersionId,
				new Date(now).toISOString(),
			);
			database
				.prepare(
					"UPDATE research_jobs SET status='succeeded',result_json=?,error=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=?",
				)
				.run(JSON.stringify({ draftId: result.id }), new Date(now).toISOString(), claim.id);
			database
				.prepare("UPDATE research_job_attempts SET finished_at=? WHERE job_id=? AND attempt=?")
				.run(new Date(now).toISOString(), claim.id, claim.attempt);
			return result.id;
		}),
	);
}

export async function runNextResearchJob(
	cwd: string,
	datasetId: string,
	engine: ResearchEngine,
	signal: AbortSignal,
): Promise<boolean> {
	signal.throwIfAborted();
	const claim = claimResearchJob(cwd, datasetId);
	if (!claim) return false;
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	const timeout = setTimeout(
		() => controller.abort(new Error("Research exceeded the 120 second execution budget")),
		120_000,
	);
	const heartbeat = setInterval(() => {
		try {
			withResearchDatabase(cwd, datasetId, (database) => {
				const now = Date.now();
				if (!ownsLease(database, datasetId, claim, now)) throw new Error("Research lease lost or job cancelled");
				database
					.prepare(
						"UPDATE research_jobs SET lease_expires_at=? WHERE job_id=? AND lease_token=? AND status='running'",
					)
					.run(now + LEASE_MS, claim.id, claim.leaseToken);
			});
		} catch (error) {
			controller.abort(error);
		}
	}, 10_000);
	try {
		const basis = withResearchDatabase(cwd, datasetId, (database) => {
			const row = claim.basisVersionId
				? database
						.prepare("SELECT content_json FROM research_versions WHERE dataset_id=? AND version_id=?")
						.get(datasetId, claim.basisVersionId)
				: undefined;
			return row ? (JSON.parse(String(row.content_json)) as StoredFrameworkContent) : null;
		});
		controller.signal.throwIfAborted();
		const content = await engine.generate(claim.input, basis, controller.signal);
		controller.signal.throwIfAborted();
		finishResearchJob(cwd, datasetId, claim, content);
	} catch (error) {
		withResearchDatabase(cwd, datasetId, (database) =>
			researchTransaction(database, () => {
				const now = Date.now();
				if (!ownsLease(database, datasetId, claim, now)) return;
				const message = error instanceof Error ? error.message : "Research failed";
				database
					.prepare(
						"UPDATE research_jobs SET status=?,error=?,next_run_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=?",
					)
					.run(
						claim.attempt >= MAX_ATTEMPTS ? "failed" : "retry_wait",
						message.slice(0, 2000),
						now + 30_000 * claim.attempt,
						new Date(now).toISOString(),
						claim.id,
					);
				database
					.prepare("UPDATE research_job_attempts SET finished_at=?,error=? WHERE job_id=? AND attempt=?")
					.run(new Date(now).toISOString(), message.slice(0, 2000), claim.id, claim.attempt);
			}),
		);
	} finally {
		clearInterval(heartbeat);
		clearTimeout(timeout);
		signal.removeEventListener("abort", abort);
	}
	return true;
}
