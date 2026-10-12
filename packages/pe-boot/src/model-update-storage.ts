import type { DatabaseSync } from "node:sqlite";
import { rollbackPeTransaction } from "./collection-schema.ts";
import { openWritablePeDataset } from "./tools/database.ts";

const MODEL_UPDATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_update_series (
 dataset_id TEXT NOT NULL, doc_id TEXT NOT NULL,
 current_version_id TEXT,
 PRIMARY KEY(dataset_id,doc_id)
);
CREATE TABLE IF NOT EXISTS model_update_versions (
 version_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, doc_id TEXT NOT NULL,
 parent_version_id TEXT, state TEXT NOT NULL CHECK(state IN ('current_research','candidate','reviewed','unavailable')),
 file_relpath TEXT NOT NULL, file_sha256 TEXT NOT NULL, manifest_json TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(dataset_id,doc_id,file_relpath)
);
CREATE INDEX IF NOT EXISTS model_update_versions_history
 ON model_update_versions(dataset_id,doc_id,created_at DESC);
CREATE TRIGGER IF NOT EXISTS model_update_versions_immutable_update BEFORE UPDATE ON model_update_versions
 BEGIN SELECT RAISE(ABORT, 'Model update versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS model_update_versions_immutable_delete BEFORE DELETE ON model_update_versions
 BEGIN SELECT RAISE(ABORT, 'Model update versions are immutable'); END;
CREATE TABLE IF NOT EXISTS model_update_reviews (
 version_id TEXT PRIMARY KEY REFERENCES model_update_versions(version_id),
 decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
 note TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS model_update_reviews_immutable_update BEFORE UPDATE ON model_update_reviews
 BEGIN SELECT RAISE(ABORT, 'Model update reviews are immutable'); END;
CREATE TRIGGER IF NOT EXISTS model_update_reviews_immutable_delete BEFORE DELETE ON model_update_reviews
 BEGIN SELECT RAISE(ABORT, 'Model update reviews are immutable'); END;
`;

export interface StoredModelVersionRow {
	version_id: string;
	dataset_id: string;
	doc_id: string;
	parent_version_id: string | null;
	state: "current_research" | "candidate" | "reviewed" | "unavailable";
	file_relpath: string;
	file_sha256: string;
	manifest_json: string;
	created_at: string;
	review_decision: "approved" | "rejected" | null;
	review_note: string | null;
	reviewed_at: string | null;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
	database.exec("BEGIN IMMEDIATE");
	try {
		const result = operation();
		database.exec("COMMIT");
		return result;
	} catch (error) {
		rollbackPeTransaction(database);
		throw error;
	}
}

export function withModelUpdateDatabase<T>(
	cwd: string,
	datasetId: string | undefined,
	operation: (database: DatabaseSync, resolvedDatasetId: string) => T,
): T {
	const connection = openWritablePeDataset(cwd, datasetId);
	try {
		connection.database.exec("PRAGMA foreign_keys=ON");
		transaction(connection.database, () => {
			connection.database.exec(MODEL_UPDATE_SCHEMA);
		});
		return operation(connection.database, connection.datasetId);
	} finally {
		connection.database.close();
	}
}

export function currentModelVersionId(database: DatabaseSync, datasetId: string, docId: string): string | undefined {
	const row = database
		.prepare("SELECT current_version_id FROM model_update_series WHERE dataset_id=? AND doc_id=?")
		.get(datasetId, docId) as { current_version_id?: string | null } | undefined;
	return typeof row?.current_version_id === "string" ? row.current_version_id : undefined;
}

export function modelVersionRow(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	versionId: string,
): StoredModelVersionRow | undefined {
	return database
		.prepare(`SELECT v.*, r.decision AS review_decision, r.note AS review_note, r.created_at AS reviewed_at
		 FROM model_update_versions v LEFT JOIN model_update_reviews r ON r.version_id=v.version_id
		 WHERE v.dataset_id=? AND v.doc_id=? AND v.version_id=?`)
		.get(datasetId, docId, versionId) as StoredModelVersionRow | undefined;
}

export function listModelVersionRows(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
): StoredModelVersionRow[] {
	return database
		.prepare(`SELECT v.*, r.decision AS review_decision, r.note AS review_note, r.created_at AS reviewed_at
		 FROM model_update_versions v LEFT JOIN model_update_reviews r ON r.version_id=v.version_id
		 WHERE v.dataset_id=? AND v.doc_id=? ORDER BY v.created_at DESC, v.version_id DESC`)
		.all(datasetId, docId) as unknown as StoredModelVersionRow[];
}

export function insertModelVersion(
	database: DatabaseSync,
	row: Omit<StoredModelVersionRow, "review_decision" | "review_note" | "reviewed_at">,
	promote: boolean,
): void {
	transaction(database, () => {
		database
			.prepare("INSERT OR IGNORE INTO model_update_series(dataset_id,doc_id) VALUES(?,?)")
			.run(row.dataset_id, row.doc_id);
		database
			.prepare(`INSERT INTO model_update_versions
			 (version_id,dataset_id,doc_id,parent_version_id,state,file_relpath,file_sha256,manifest_json,created_at)
			 VALUES(?,?,?,?,?,?,?,?,?)`)
			.run(
				row.version_id,
				row.dataset_id,
				row.doc_id,
				row.parent_version_id,
				row.state,
				row.file_relpath,
				row.file_sha256,
				row.manifest_json,
				row.created_at,
			);
		if (promote)
			database
				.prepare("UPDATE model_update_series SET current_version_id=? WHERE dataset_id=? AND doc_id=?")
				.run(row.version_id, row.dataset_id, row.doc_id);
	});
}

export function reviewModelVersion(
	database: DatabaseSync,
	versionId: string,
	decision: "approved" | "rejected",
	note: string,
	createdAt: string,
): void {
	transaction(database, () => {
		database
			.prepare("INSERT INTO model_update_reviews(version_id,decision,note,created_at) VALUES(?,?,?,?)")
			.run(versionId, decision, note, createdAt);
	});
}

export function promoteModelVersion(database: DatabaseSync, datasetId: string, docId: string, versionId: string): void {
	transaction(database, () => {
		database
			.prepare("INSERT OR IGNORE INTO model_update_series(dataset_id,doc_id) VALUES(?,?)")
			.run(datasetId, docId);
		database
			.prepare("UPDATE model_update_series SET current_version_id=? WHERE dataset_id=? AND doc_id=?")
			.run(versionId, datasetId, docId);
	});
}
