import type { DatabaseSync } from "node:sqlite";
import {
	initializePeCollectionDatabase,
	PE_PIPELINE_SCHEMA_VERSION,
	rollbackPeTransaction,
} from "../collection-schema.ts";
import { openWritablePeDataset, resolvePeDatasetLocation } from "../tools/database.ts";

// Research has its own additive schema version; the document parser schema stays unchanged.
export const RESEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS research_frameworks (
 dataset_id TEXT PRIMARY KEY, current_version_id TEXT
);
CREATE TABLE IF NOT EXISTS research_versions (
 version_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES research_frameworks(dataset_id),
 version_no INTEGER NOT NULL CHECK(version_no > 0), parent_version_id TEXT REFERENCES research_versions(version_id),
 content_json TEXT NOT NULL, inputs_json TEXT NOT NULL, created_at TEXT NOT NULL,
 request_id TEXT NOT NULL, request_json TEXT NOT NULL,
 UNIQUE(dataset_id,version_no), UNIQUE(dataset_id,request_id)
);
CREATE TRIGGER IF NOT EXISTS research_versions_immutable_update BEFORE UPDATE ON research_versions
 BEGIN SELECT RAISE(ABORT, 'Research versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS research_versions_immutable_delete BEFORE DELETE ON research_versions
 BEGIN SELECT RAISE(ABORT, 'Research versions are immutable'); END;
CREATE TABLE IF NOT EXISTS research_drafts (
 draft_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES research_frameworks(dataset_id),
 base_version_id TEXT REFERENCES research_versions(version_id), revision INTEGER NOT NULL CHECK(revision > 0),
 status TEXT NOT NULL CHECK(status IN ('open','published','rejected')),
 content_json TEXT NOT NULL, inputs_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_jobs (
 job_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES research_frameworks(dataset_id),
 kind TEXT NOT NULL CHECK(kind IN ('generate','review')),
 dedupe_key TEXT NOT NULL, basis_version_id TEXT REFERENCES research_versions(version_id),
 input_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','retry_wait','succeeded','failed','cancelled')),
 attempt INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL,
 lease_token TEXT, lease_expires_at INTEGER, result_json TEXT, error TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(dataset_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS research_jobs_due ON research_jobs(dataset_id,status,next_run_at);
CREATE TABLE IF NOT EXISTS research_job_attempts (
 job_id TEXT NOT NULL REFERENCES research_jobs(job_id), attempt INTEGER NOT NULL,
 lease_token TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT,
 PRIMARY KEY(job_id,attempt)
);
`;

const CONTINUATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS research_continuations (
 version_id TEXT PRIMARY KEY REFERENCES research_versions(version_id),
 dataset_id TEXT NOT NULL, draft_id TEXT NOT NULL, session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','delivered','failed')),
 error TEXT, updated_at TEXT NOT NULL
);
`;

export function researchTransaction<T>(database: DatabaseSync, operation: () => T): T {
	database.exec("BEGIN IMMEDIATE");
	try {
		const value = operation();
		database.exec("COMMIT");
		return value;
	} catch (error) {
		rollbackPeTransaction(database);
		throw error;
	}
}

export function withResearchDatabase<T>(cwd: string, datasetId: string, operation: (database: DatabaseSync) => T): T {
	// Verify identity before any migration, including an empty project.
	const connection = openWritablePeDataset(cwd, datasetId);
	let needsMigration = true;
	try {
		if (
			connection.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_metadata'").get()
		)
			needsMigration =
				Number(
					connection.database
						.prepare("SELECT value FROM schema_metadata WHERE key='pipeline_schema_version'")
						.get()?.value,
				) !== PE_PIPELINE_SCHEMA_VERSION;
	} finally {
		connection.database.close();
	}
	if (needsMigration) initializePeCollectionDatabase(resolvePeDatasetLocation(cwd).databasePath);
	const { database } = openWritablePeDataset(cwd, datasetId);
	try {
		database.exec("PRAGMA foreign_keys=ON");
		const version = database.prepare("SELECT value FROM schema_metadata WHERE key='research_schema_version'").get();
		if (version && !["1", "2"].includes(String(version.value)))
			throw new Error("Unsupported research schema version");
		if (!version)
			researchTransaction(database, () => {
				database.exec(RESEARCH_SCHEMA);
				database
					.prepare("INSERT OR IGNORE INTO schema_metadata VALUES('research_schema_version','1',?)")
					.run(new Date().toISOString());
			});
		if (version?.value !== "2")
			researchTransaction(database, () => {
				database.exec(CONTINUATION_SCHEMA);
				database
					.prepare("UPDATE schema_metadata SET value='2',updated_at=? WHERE key='research_schema_version'")
					.run(new Date().toISOString());
			});
		database.prepare("INSERT OR IGNORE INTO research_frameworks(dataset_id) VALUES(?)").run(datasetId);
		return operation(database);
	} finally {
		database.close();
	}
}
