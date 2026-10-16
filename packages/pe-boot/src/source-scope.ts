import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

export interface PeSourceScope {
	datasetId: string;
	documents: Array<{ docId: string; versionNo: number; filename: string }>;
}

const sourceScope = new AsyncLocalStorage<PeSourceScope | undefined>();

/** Each prompt owns an immutable snapshot; previews and other sessions stay unscoped. */
export function withPeSourceScope<T>(scope: PeSourceScope | undefined, action: () => T): T {
	return sourceScope.run(scope ? structuredClone(scope) : undefined, action);
}

/** Connection-local read views filter before ranking, pagination, and direct lookups. */
export function applyPeSourceScope(database: DatabaseSync, datasetId: string): void {
	const scope = sourceScope.getStore();
	if (!scope) return;
	if (scope.datasetId !== datasetId) throw new Error("Source selection belongs to another project");
	const allowed = new Map(scope.documents.map((document) => [document.docId, document.versionNo]));
	const tables = database.prepare("SELECT name, sql FROM main.sqlite_master WHERE type='table'").all();
	const documentColumns = database.prepare("PRAGMA main.table_info(documents)").all();
	const version = documentColumns.some((column) => column.name === "version_no") ? "COALESCE(version_no, 1)" : "1";
	database.function("pe_selected_source", (docId, versionNo) =>
		allowed.get(String(docId)) === Number(versionNo) ? 1 : 0,
	);
	database.exec(
		`CREATE TEMP VIEW documents AS SELECT * FROM main.documents WHERE pe_selected_source(doc_id, ${version})=1`,
	);
	for (const table of tables) {
		if (table.name === "documents" || /CREATE VIRTUAL TABLE/i.test(String(table.sql))) continue;
		const name = `"${String(table.name).replaceAll('"', '""')}"`;
		if (
			!database
				.prepare(`PRAGMA main.table_info(${name})`)
				.all()
				.some((column) => column.name === "doc_id")
		)
			continue;
		database.exec(
			"CREATE TEMP VIEW " +
				name +
				" AS SELECT * FROM main." +
				name +
				" WHERE doc_id IN (SELECT doc_id FROM temp.documents)",
		);
	}
}
