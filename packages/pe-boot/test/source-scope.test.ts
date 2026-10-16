import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyPeSourceScope, withPeSourceScope } from "../src/source-scope.ts";

function fixture() {
	const database = new DatabaseSync(":memory:");
	database.exec(
		"CREATE TABLE documents (dataset_id TEXT, doc_id TEXT, version_no INTEGER);" +
			"INSERT INTO documents VALUES ('a','one',1),('a','two',2);" +
			"CREATE TABLE pdf_pages (doc_id TEXT, page_text TEXT);" +
			"INSERT INTO pdf_pages VALUES ('one','selected'),('two','excluded');",
	);
	return database;
}

describe("prompt source scope", () => {
	it("filters retrieval and direct page lookups, without changing the original tables", async () => {
		const input = { datasetId: "a", documents: [{ docId: "one", versionNo: 1, filename: "one.pdf" }] };
		await withPeSourceScope(input, async () => {
			input.documents.length = 0;
			await Promise.resolve();
			const database = fixture();
			try {
				applyPeSourceScope(database, "a");
				expect(
					database
						.prepare("SELECT doc_id FROM documents")
						.all()
						.map((row) => row.doc_id),
				).toEqual(["one"]);
				expect(database.prepare("SELECT * FROM pdf_pages WHERE doc_id='two'").all()).toEqual([]);
				expect(database.prepare("SELECT COUNT(*) AS n FROM main.documents").get()?.n).toBe(2);
			} finally {
				database.close();
			}
		});
		const database = fixture();
		try {
			applyPeSourceScope(database, "a");
			expect(database.prepare("SELECT COUNT(*) AS n FROM documents").get()?.n).toBe(2);
		} finally {
			database.close();
		}
	});

	it("keeps empty selection empty and rejects mismatched projects or versions", () => {
		for (const documents of [[], [{ docId: "one", versionNo: 2, filename: "one.pdf" }]]) {
			withPeSourceScope({ datasetId: "a", documents }, () => {
				const database = fixture();
				try {
					applyPeSourceScope(database, "a");
					expect(database.prepare("SELECT * FROM documents").all()).toEqual([]);
					expect(database.prepare("SELECT * FROM pdf_pages").all()).toEqual([]);
				} finally {
					database.close();
				}
			});
		}
		withPeSourceScope({ datasetId: "b", documents: [] }, () => {
			const database = fixture();
			try {
				expect(() => applyPeSourceScope(database, "a")).toThrow("another project");
			} finally {
				database.close();
			}
		});
	});

	it("isolates overlapping asynchronous prompts", async () => {
		await Promise.all(
			["one", "two"].map((docId) =>
				withPeSourceScope(
					{ datasetId: "a", documents: [{ docId, versionNo: docId === "one" ? 1 : 2, filename: docId }] },
					async () => {
						await Promise.resolve();
						const database = fixture();
						try {
							applyPeSourceScope(database, "a");
							expect(
								database
									.prepare("SELECT doc_id FROM documents")
									.all()
									.map((row) => row.doc_id),
							).toEqual([docId]);
						} finally {
							database.close();
						}
					},
				),
			),
		);
	});
});
