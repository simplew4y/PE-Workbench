import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initializePeCollectionDatabase, openPeCollectionDatabase } from "../src/collection-schema.ts";
import { PeSourceError, preparePeDocument, registerPeDocuments } from "../src/documents.ts";
import { resolvePeEvidenceRecord, resolvePeEvidenceReference } from "../src/evidence.ts";
import { EXCEL_TABLES, excelParserRevision, excelPython } from "../src/excel-processing.ts";
import type { SqlRow } from "../src/tools/database.ts";
import { getPeExcelRange } from "../src/tools/excel-range.ts";
import { formulaTraceIsStructurallyComplete, tracePeFormula } from "../src/tools/formula-trace.ts";
import { readWorkbookDocument, readWorkbookFile } from "../src/workbook-reader.ts";

const fixtureBytes = readFileSync(new URL("./fixtures/excel-parity.xlsx", import.meta.url));
const roots: string[] = [];
const environment = {
	PE_EXCEL_TIMEOUT_MS: process.env.PE_EXCEL_TIMEOUT_MS,
	PE_EXCEL_PYTHON: process.env.PE_EXCEL_PYTHON,
};

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pe-excel-service-")));
	roots.push(root);
	mkdirSync(join(root, "raw"));
	mkdirSync(join(root, "meta"));
	const databasePath = join(root, "meta", "collection.sqlite3");
	initializePeCollectionDatabase(databasePath, { datasetId: "dataset", name: "Original project name" });
	return { root, databasePath };
}

function register(root: string, name = "Model.xlsx", bytes = fixtureBytes): SqlRow {
	return registerPeDocuments(root, "dataset", [{ name, bytes }]).documents[0];
}

function childPrepare(root: string, docId: string): Promise<{ cachePath: string; docId: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [
			"--experimental-strip-types",
			fileURLToPath(new URL("./fixtures/prepare-excel.ts", import.meta.url)),
			root,
			docId,
		]);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(stderr));
			else {
				try {
					resolve(JSON.parse(stdout) as { cachePath: string; docId: string });
				} catch (error) {
					reject(error);
				}
			}
		});
	});
}

afterEach(() => {
	for (const [key, value] of Object.entries(environment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("immutable Excel registration and shared preparation", () => {
	it("preserves the published cache and all rows when a repair fails, then retries the same version", async () => {
		const { root, databasePath } = fixture();
		const document = register(root);
		const first = await preparePeDocument(root, { docId: String(document.doc_id) });
		const database = openPeCollectionDatabase(databasePath);
		try {
			const snapshot = EXCEL_TABLES.map((table) =>
				database.prepare(`SELECT * FROM ${table} WHERE doc_id=?`).all(document.doc_id),
			);
			const pointer = database.prepare("SELECT * FROM document_cache WHERE doc_id=?").get(document.doc_id);
			const original = readFileSync(first.filePath);
			rmSync(first.readablePath);
			process.env.PE_EXCEL_TIMEOUT_MS = "1";
			await expect(preparePeDocument(root, { docId: String(document.doc_id) })).rejects.toThrow("exceeded");
			expect(database.prepare("SELECT * FROM document_cache WHERE doc_id=?").get(document.doc_id)).toEqual(pointer);
			expect(
				EXCEL_TABLES.map((table) => database.prepare(`SELECT * FROM ${table} WHERE doc_id=?`).all(document.doc_id)),
			).toEqual(snapshot);
			delete process.env.PE_EXCEL_TIMEOUT_MS;
			const refreshed = await preparePeDocument(root, { docId: String(document.doc_id) });
			expect(refreshed.document.doc_id).toBe(document.doc_id);
			expect(readFileSync(first.filePath)).toEqual(original);
			expect(
				EXCEL_TABLES.map((table) => database.prepare(`SELECT * FROM ${table} WHERE doc_id=?`).all(document.doc_id)),
			).toEqual(snapshot);
			const attempt = database
				.prepare("SELECT attempt FROM processing_jobs WHERE doc_id=?")
				.get(document.doc_id)?.attempt;
			await preparePeDocument(root, { docId: String(document.doc_id) });
			expect(
				database.prepare("SELECT attempt FROM processing_jobs WHERE doc_id=?").get(document.doc_id)?.attempt,
			).toBe(attempt);
		} finally {
			database.close();
		}
	}, 20_000);

	it("initializes catalog identity when the project metadata is empty", () => {
		const { root, databasePath } = fixture();
		const database = openPeCollectionDatabase(databasePath);
		try {
			database.exec("DELETE FROM project_metadata");
			expect(register(root).dataset_id).toBe("dataset");
			expect(database.prepare("SELECT dataset_id FROM project_metadata").get()?.dataset_id).toBe("dataset");
		} finally {
			database.close();
		}
	});

	it("excludes archived documents from current lookup but can read their historical references", async () => {
		const { root, databasePath } = fixture();
		const document = register(root);
		const database = openPeCollectionDatabase(databasePath);
		try {
			database.prepare("UPDATE documents SET lifecycle_state='archived' WHERE doc_id=?").run(document.doc_id);
			expect(registerPeDocuments(root, "dataset", []).fileCount).toBe(0);
			await expect(preparePeDocument(root, { path: "Model.xlsx" })).rejects.toMatchObject({ status: 404 });
			expect((await preparePeDocument(root, { docId: String(document.doc_id) })).document.lifecycle_state).toBe(
				"archived",
			);
		} finally {
			database.close();
		}
	}, 20_000);

	it("rejects renamed non-OOXML and extension mismatches before registering any originals", () => {
		const { root, databasePath } = fixture();
		expect(() => register(root, "Renamed.xlsx", Buffer.from("PK not a workbook"))).toThrow(PeSourceError);
		expect(() => register(root, "Wrong.xlsm")).toThrow("content type");
		expect(readdirSync(join(root, "raw"))).toEqual([]);
		const database = openPeCollectionDatabase(databasePath);
		try {
			expect(database.prepare("SELECT * FROM documents").all()).toHaveLength(0);
		} finally {
			database.close();
		}
	});

	it("preserves exact filename identity, same-current deduplication and A to B to A versions", () => {
		const { root, databasePath } = fixture();
		const first = register(root);
		expect(register(root).doc_id).toBe(first.doc_id);
		const second = register(root, "Model.xlsx", Buffer.concat([fixtureBytes, Buffer.from("version B")]));
		const third = register(root);
		const other = register(root, "model.xlsx");
		expect([first.version_no, second.version_no, third.version_no]).toEqual([1, 2, 3]);
		expect(new Set([first.doc_id, second.doc_id, third.doc_id]).size).toBe(3);
		expect(first.checksum).toBe(third.checksum);
		expect(other.logical_doc_id).not.toBe(first.logical_doc_id);
		expect(third.supersedes_doc_id).toBe(second.doc_id);
		expect(readFileSync(join(root, String(first.stored_path)))).toEqual(fixtureBytes);
		const database = openPeCollectionDatabase(databasePath);
		try {
			expect(
				database
					.prepare("SELECT doc_id FROM documents WHERE is_current=1 ORDER BY doc_id")
					.all()
					.map((row) => row.doc_id)
					.sort(),
			).toEqual([third.doc_id, other.doc_id].sort());
			expect(database.prepare("SELECT name FROM project_metadata WHERE id=1").get()?.name).toBe(
				"Original project name",
			);
			expect(database.prepare("SELECT status FROM documents WHERE doc_id=?").get(third.doc_id)?.status).toBe(
				"queued",
			);
		} finally {
			database.close();
		}
	});

	it("publishes navigation without full cell materialization and reads original values on demand", async () => {
		const { root, databasePath } = fixture();
		const document = register(root);
		const prepared = await preparePeDocument(root, { docId: String(document.doc_id) });
		expect((await preparePeDocument(root, { path: "raw/Model.xlsx" })).cachePath).toBe(prepared.cachePath);
		const readable = readFileSync(prepared.readablePath, "utf8");
		expect(readable).toContain("Sheet: Valuation");
		expect(readable).not.toContain("x".repeat(5100));
		expect(existsSync(join(dirname(prepared.cachePath), "workbook.json"))).toBe(false);
		expect(existsSync(join(dirname(prepared.cachePath), "text-index.json"))).toBe(true);
		const database = openPeCollectionDatabase(databasePath);
		try {
			for (const table of ["excel_cells", "excel_formula_references", "valuation_date_candidates", "metric_facts"])
				expect(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
			const result = readWorkbookDocument(database, "dataset", String(document.doc_id), {
				action: "read",
				sheet: "Valuation",
				range: "B7",
			});
			const cell = (result.cells as SqlRow[])[0];
			expect(cell).toMatchObject({ cached_value: "120", formula: "=B5/10" });
			expect(resolvePeEvidenceRecord(database, "dataset", String(cell.evidence_id))).toBeDefined();
			const search = readWorkbookDocument(database, "dataset", String(document.doc_id), {
				action: "search",
				query: "Long original note",
			});
			expect((search.cells as SqlRow[])[0].raw_value).toContain("x".repeat(5100));
			expect(search.index_used).toBe(true);
			expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			database.close();
		}
		const ranges = [
			{ sheet: "Valuation", range: "B7" },
			{ sheet: "Hidden assumptions", range: "B1" },
		];
		const firstPage = getPeExcelRange(root, { docId: String(document.doc_id), ranges, maxCells: 1 });
		expect(firstPage).toMatchObject({ matching_cell_count: 2, next_offset: 1, complete: false });
		const lastPage = getPeExcelRange(root, { docId: String(document.doc_id), ranges, maxCells: 1, offset: 1 });
		expect(lastPage).toMatchObject({
			complete: true,
			next_offset: null,
			cells: [{ sheet_state: "veryHidden", numeric_value: 2 }],
		});
		const trace = tracePeFormula(root, { docId: String(document.doc_id), sheetName: "Formula cases", cellRef: "A2" });
		const input = trace.nodes.find((node) => node.sheet_name === "Hidden assumptions" && node.cell_ref === "B1");
		expect(input).toMatchObject({ depth: 1, numeric_value: 2, sheet_state: "veryHidden" });
		expect(trace.edges.find((edge) => edge.defined_name === "Input_Growth")?.target_cell_ids).toContain(
			input?.cell_id,
		);
		expect(trace.issues).toContainEqual(
			expect.objectContaining({
				code: "formula_cache_unavailable",
				source_sheet: "Formula cases",
				source_cell_ref: "A2",
			}),
		);
		expect(formulaTraceIsStructurallyComplete(trace)).toBe(true);
	}, 20_000);

	it("repairs missing artifacts and table rows without changing version or legacy evidence IDs", async () => {
		const { root, databasePath } = fixture();
		const document = register(root);
		const database = openPeCollectionDatabase(databasePath);
		database
			.prepare(
				"INSERT INTO excel_cells(cell_id,dataset_id,doc_id,sheet_name,cell_ref,row_index,col_index,value_type) VALUES('oldcell','dataset',?,'Valuation','B7',7,2,'formula')",
			)
			.run(document.doc_id);
		database
			.prepare(
				"INSERT INTO metric_facts(fact_id,dataset_id,doc_id,metric_name,sheet_name,cell_ref) VALUES('oldfact','dataset',?,'Target Price','Valuation','B7')",
			)
			.run(document.doc_id);
		const first = await preparePeDocument(root, { docId: String(document.doc_id) });
		const before = database
			.prepare("SELECT evidence_id FROM evidence_locations WHERE doc_id=? ORDER BY evidence_id")
			.all(document.doc_id);
		expect(before).toHaveLength(2);
		for (const id of ["cell:oldcell", "fact:oldfact"])
			expect(resolvePeEvidenceReference(root, id)).toEqual({
				docId: document.doc_id,
				location: { kind: "excel", sheet: "Valuation", range: "B7" },
			});
		rmSync(first.readablePath);
		const second = await preparePeDocument(root, { docId: String(document.doc_id) });
		expect(second.cachePath).not.toBe(first.cachePath);
		database.prepare("DELETE FROM excel_sheets WHERE doc_id=? AND sheet_name='Valuation'").run(document.doc_id);
		const third = await preparePeDocument(root, { docId: String(document.doc_id) });
		try {
			expect(third.cachePath).not.toBe(second.cachePath);
			expect(existsSync(second.cachePath)).toBe(true);
			expect(third.document.doc_id).toBe(document.doc_id);
			expect(
				database
					.prepare("SELECT evidence_id FROM evidence_locations WHERE doc_id=? ORDER BY evidence_id")
					.all(document.doc_id),
			).toEqual(before);
			expect(
				database.prepare("SELECT attempt FROM processing_jobs WHERE doc_id=?").get(document.doc_id)?.attempt,
			).toBe(3);
		} finally {
			database.close();
		}
	}, 20_000);

	it("shares an in-flight parse between independent Node processes", async () => {
		const { root, databasePath } = fixture();
		const document = register(root);
		const results = await Promise.all([
			childPrepare(root, String(document.doc_id)),
			childPrepare(root, String(document.doc_id)),
		]);
		expect(results[0]).toEqual(results[1]);
		const database = openPeCollectionDatabase(databasePath);
		try {
			expect(
				database.prepare("SELECT attempt FROM processing_jobs WHERE doc_id=?").get(document.doc_id)?.attempt,
			).toBe(1);
		} finally {
			database.close();
		}
	}, 20_000);

	it("recovers an expired lease and removes its abandoned stage", async () => {
		const { root, databasePath } = fixture();
		const document = register(root);
		const revision = excelParserRevision();
		const owner = "12345678-1234-1234-1234-123456789abc";
		const stage = join(root, "meta", "excel", String(document.doc_id), revision, `.${owner}.tmp`);
		mkdirSync(stage, { recursive: true });
		utimesSync(stage, 1, 1);
		const database = openPeCollectionDatabase(databasePath);
		database
			.prepare(
				"INSERT INTO processing_jobs(job_key,doc_id,revision,status,owner_id,lease_expires_at,attempt,created_at,updated_at) VALUES (?,?,?,'processing',?,1,1,'old','old')",
			)
			.run(`${document.doc_id}:${revision}`, document.doc_id, revision, owner);
		const prepared = await preparePeDocument(root, { docId: String(document.doc_id) });
		try {
			expect(prepared.document.status).toBe("completed_with_warnings");
			expect(existsSync(stage)).toBe(false);
			expect(
				database.prepare("SELECT attempt FROM processing_jobs WHERE doc_id=?").get(document.doc_id)?.attempt,
			).toBe(2);
		} finally {
			database.close();
		}
	}, 20_000);

	it("does not partially publish failed parsing and can retry the registered version", async () => {
		const { root, databasePath } = fixture();
		const document = register(root);
		process.env.PE_EXCEL_TIMEOUT_MS = "1";
		await expect(preparePeDocument(root, { docId: String(document.doc_id) })).rejects.toThrow("exceeded");
		const database = openPeCollectionDatabase(databasePath);
		try {
			for (const table of EXCEL_TABLES)
				expect(database.prepare(`SELECT * FROM ${table} WHERE doc_id=?`).all(document.doc_id)).toHaveLength(0);
			expect(database.prepare("SELECT * FROM document_cache").all()).toHaveLength(0);
			expect(database.prepare("SELECT status FROM documents WHERE doc_id=?").get(document.doc_id)?.status).toBe(
				"failed",
			);
			delete process.env.PE_EXCEL_TIMEOUT_MS;
			expect((await preparePeDocument(root, { docId: String(document.doc_id) })).document.doc_id).toBe(
				document.doc_id,
			);
			expect(
				database.prepare("SELECT attempt FROM processing_jobs WHERE doc_id=?").get(document.doc_id)?.attempt,
			).toBe(2);
		} finally {
			database.close();
		}
	}, 20_000);

	it("refuses missing or modified originals, including when their derived cache is warm", async () => {
		const { root } = fixture();
		const document = register(root);
		const prepared = await preparePeDocument(root, { docId: String(document.doc_id) });
		const request = { action: "read", sheet: "Valuation", range: "B7" } as const;
		readWorkbookFile(prepared.filePath, request, String(document.checksum));
		writeFileSync(prepared.filePath, "modified");
		expect(() => readWorkbookFile(prepared.filePath, request, String(document.checksum))).toThrow(
			"Original file changed",
		);
		await expect(preparePeDocument(root, { docId: String(document.doc_id) })).rejects.toMatchObject({ status: 409 });
		rmSync(prepared.filePath);
		await expect(preparePeDocument(root, { docId: String(document.doc_id) })).rejects.toMatchObject({ status: 404 });
	}, 20_000);

	it("rejects publication by an owner that lost its lease while Python was running", async () => {
		const { root, databasePath } = fixture();
		const document = register(root);
		const python = excelPython();
		const marker = join(root, "parser-started");
		const wrapper = join(root, "slow-python");
		writeFileSync(
			wrapper,
			`#!/usr/bin/env python3\nimport os, time\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\ntime.sleep(1)\nos.execv(${JSON.stringify(python)}, [${JSON.stringify(python)}] + __import__('sys').argv[1:])\n`,
			{ mode: 0o700 },
		);
		process.env.PE_EXCEL_PYTHON = wrapper;
		const pending = preparePeDocument(root, { docId: String(document.doc_id) });
		const rejected = expect(pending).rejects.toThrow("lease was lost");
		while (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 10));
		const database = openPeCollectionDatabase(databasePath);
		// This write also proves that Python is running outside the publishing transaction.
		database
			.prepare("UPDATE processing_jobs SET owner_id='replacement', lease_expires_at=? WHERE doc_id=?")
			.run(Date.now() + 30_000, document.doc_id);
		await rejected;
		try {
			expect(database.prepare("SELECT * FROM document_cache").all()).toHaveLength(0);
			expect(
				database.prepare("SELECT owner_id,status FROM processing_jobs WHERE doc_id=?").get(document.doc_id),
			).toMatchObject({ owner_id: "replacement", status: "processing" });
			for (const table of EXCEL_TABLES) expect(database.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(0);
		} finally {
			database.close();
		}
	}, 20_000);

	it.each(["processing", "completed", undefined])(
		"cleans up an expired owner without overwriting a newer %s revision",
		async (newerStatus) => {
			const { root, databasePath } = fixture();
			const document = register(root);
			const python = excelPython();
			const marker = join(root, "parser-started");
			const wrapper = join(root, "slow-python");
			writeFileSync(
				wrapper,
				`#!/usr/bin/env python3\nimport os, time\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\ntime.sleep(1)\nos.execv(${JSON.stringify(python)}, [${JSON.stringify(python)}] + __import__('sys').argv[1:])\n`,
				{ mode: 0o700 },
			);
			process.env.PE_EXCEL_PYTHON = wrapper;
			const pending = expect(preparePeDocument(root, { docId: String(document.doc_id) })).rejects.toThrow(
				"lease was lost",
			);
			while (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 10));
			const database = openPeCollectionDatabase(databasePath);
			try {
				database.prepare("UPDATE processing_jobs SET lease_expires_at=1 WHERE doc_id=?").run(document.doc_id);
				if (newerStatus) {
					database
						.prepare(
							"INSERT INTO processing_jobs(job_key,doc_id,revision,status,owner_id,lease_expires_at,attempt,created_at,updated_at) VALUES (?,?,?,?,'newer-owner',?,1,'now','now')",
						)
						.run(
							`${document.doc_id}:newer-revision`,
							document.doc_id,
							"newer-revision",
							newerStatus,
							Date.now() + 30_000,
						);
					database.prepare("UPDATE documents SET status=? WHERE doc_id=?").run(newerStatus, document.doc_id);
				}
				await pending;
				expect(database.prepare("SELECT status FROM documents WHERE doc_id=?").get(document.doc_id)?.status).toBe(
					newerStatus ?? "failed",
				);
				expect(
					database.prepare("SELECT status FROM processing_jobs WHERE revision='newer-revision'").get()?.status,
				).toBe(newerStatus);
				expect(
					database
						.prepare("SELECT status FROM processing_jobs WHERE job_key=?")
						.get(`${document.doc_id}:${excelParserRevision()}`)?.status,
				).toBe("failed");
			} finally {
				database.close();
			}
		},
		20_000,
	);
});
