import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	initializePeCollectionDatabase,
	openPeCollectionDatabase,
	rollbackPeTransaction,
} from "../src/collection-schema.ts";
import { registerPeDocuments } from "../src/documents.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

const roots: string[] = [];
function project(): { root: string; path: string } {
	const root = fs.mkdtempSync(join(tmpdir(), "pe-storage-failure-"));
	roots.push(root);
	for (const name of ["raw", "meta"]) fs.mkdirSync(join(root, name));
	const path = join(root, "meta", "collection.sqlite3");
	initializePeCollectionDatabase(path, { datasetId: "dataset", name: "Storage test" });
	return { root, path };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("storage failure recovery", () => {
	it("closes a connection when enabling its WAL fails", () => {
		const { path } = project();
		const failure = Object.assign(new Error("unable to open database file"), { errcode: 14 });
		let opened: DatabaseSync | undefined;
		vi.spyOn(DatabaseSync.prototype, "exec").mockImplementationOnce(function (this: DatabaseSync) {
			opened = this;
			throw failure;
		});
		expect(() => openPeCollectionDatabase(path)).toThrow(failure);
		expect(opened).toBeDefined();
		expect(opened?.isOpen).toBe(false);
	});

	it("handles SQLite's automatic rollback after SQLITE_FULL", () => {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec("CREATE TABLE payload(value BLOB)");
			const pages = database.prepare("PRAGMA page_count").get()?.page_count;
			database.exec(`PRAGMA max_page_count=${pages}; BEGIN IMMEDIATE`);
			expect(() => database.exec("INSERT INTO payload VALUES (zeroblob(1048576))")).toThrow(
				"database or disk is full",
			);
			expect(database.isTransaction).toBe(false);
			expect(() => rollbackPeTransaction(database)).not.toThrow();
			expect(database.prepare("SELECT COUNT(*) AS count FROM payload").get()?.count).toBe(0);
		} finally {
			database.close();
		}
	});

	it("preserves the migration error when SQLite aborts the transaction itself", () => {
		const { path } = project();
		const database = new DatabaseSync(path);
		try {
			database.exec(`CREATE TRIGGER reject_migration BEFORE UPDATE ON schema_metadata
				BEGIN SELECT RAISE(ROLLBACK, 'storage write rejected'); END`);
			expect(() => initializePeCollectionDatabase(path)).toThrow("storage write rejected");
			database.exec("BEGIN IMMEDIATE; ROLLBACK");
			expect(database.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
		} finally {
			database.close();
		}
	});

	it("cleans up new originals after an automatic upload rollback and permits retry", () => {
		const { root, path } = project();
		const database = new DatabaseSync(path);
		const files = [{ name: "notes.txt", bytes: Buffer.from("complete original") }];
		try {
			database.exec(`CREATE TRIGGER reject_upload BEFORE INSERT ON documents
				BEGIN SELECT RAISE(ROLLBACK, 'upload storage rejected'); END`);
			expect(() => registerPeDocuments(root, "dataset", files)).toThrow("upload storage rejected");
			expect(fs.readdirSync(join(root, "raw"))).toEqual([]);
			expect(database.prepare("SELECT COUNT(*) AS count FROM documents").get()?.count).toBe(0);
			database.exec("DROP TRIGGER reject_upload");
			expect(registerPeDocuments(root, "dataset", files).fileCount).toBe(1);
			expect(fs.readFileSync(join(root, "raw", "notes.txt"), "utf8")).toBe("complete original");
		} finally {
			database.close();
		}
	});

	it("removes partially written uploads without modifying previously registered originals", () => {
		const { root, path } = project();
		const original = [{ name: "notes.txt", bytes: Buffer.from("original") }];
		registerPeDocuments(root, "dataset", original);
		const failure = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		const write = vi.mocked(fs.writeFileSync).getMockImplementation();
		if (!write) throw new Error("Missing filesystem implementation");
		vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
			write(file, "partial");
			throw failure;
		});
		const replacement = [{ name: "notes.txt", bytes: Buffer.from("replacement") }];
		expect(() => registerPeDocuments(root, "dataset", replacement)).toThrow(failure);
		expect(fs.readdirSync(join(root, "raw"))).toEqual(["notes.txt"]);
		expect(fs.readFileSync(join(root, "raw", "notes.txt"), "utf8")).toBe("original");
		const database = new DatabaseSync(path);
		try {
			expect(database.prepare("SELECT version_no,is_current FROM documents").all()).toEqual([
				{ version_no: 1, is_current: 1 },
			]);
		} finally {
			database.close();
		}
		expect(registerPeDocuments(root, "dataset", replacement).documents[0].version_no).toBe(2);
	});
});
