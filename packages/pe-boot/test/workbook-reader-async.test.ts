import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { registerPeDocuments } from "../src/documents.ts";
import { readWorkbookDocumentAsync, type WorkbookReadProgress } from "../src/workbook-reader.ts";
import { createDocumentProject } from "./document-fixture.ts";
import { writeWorkbookFixture } from "./workbook-source-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const datasetId = "async-reader";
	const root = createDocumentProject(datasetId);
	roots.push(root);
	const document = registerPeDocuments(root, datasetId, [
		{ name: "Model.xlsx", bytes: readFileSync(new URL("./fixtures/excel-parity.xlsx", import.meta.url)) },
	]).documents[0];
	return {
		root,
		datasetId,
		docId: String(document.doc_id),
		database: new DatabaseSync(join(root, "meta/collection.sqlite3")),
	};
}

function simulatedReader(root: string, mode: "retry" | "timeout" | "delay" | "error" | "change") {
	const script = join(root, "reader.cjs");
	const attempts = join(root, "attempts.json");
	writeFileSync(
		script,
		`#!${process.execPath}
const fs = require('node:fs');
const logPath = ${JSON.stringify(attempts)};
const attempts = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
attempts.push(process.pid);
fs.writeFileSync(logPath, JSON.stringify(attempts));
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const mode = ${JSON.stringify(mode)};
  if (mode === 'timeout' || mode === 'retry' && attempts.length === 1) { setInterval(() => {}, 1000); return; }
  if (mode === 'error') { process.stderr.write('broken workbook'); process.exitCode = 1; return; }
  if (mode === 'change') fs.appendFileSync(process.argv[process.argv.indexOf('--input') + 1], 'changed');
  const result = { ranges: request.ranges.map(range => ({ ...range, exists: true })) };
  setTimeout(() => process.stdout.write(JSON.stringify(result)), mode === 'delay' ? 120 : 0);
});
`,
		{ mode: 0o755 },
	);
	vi.stubEnv("PE_EXCEL_PYTHON", script);
	return () => JSON.parse(readFileSync(attempts, "utf8")) as number[];
}

it("validates every cited range across sheets in one response without hiding empty ranges", async () => {
	const { root, datasetId, docId, database } = fixture();
	try {
		writeWorkbookFixture(root, docId, [
			{ sheet: "Inputs", cell: "A1", value: 0 },
			{ sheet: "Inputs", cell: "B2", value: null, format: "0.00" },
			{ sheet: "Inputs", cell: "D80", value: null, comment: { author: "Reader", text: "Pending" } },
			{ sheet: "Output", cell: "A1", value: "=Inputs!A1" },
		]);
		const ranges = [
			{ sheet: "Inputs", range: "A1" },
			{ sheet: "Inputs", range: "A1:B4" },
			{ sheet: "Inputs", range: "B2" },
			{ sheet: "Inputs", range: "D80" },
			{ sheet: "Output", range: "A1" },
			{ sheet: "Output", range: "B1" },
		];
		const progress: WorkbookReadProgress[] = [];
		const result = await readWorkbookDocumentAsync(
			database,
			datasetId,
			docId,
			{ action: "validate", ranges },
			{ onProgress: (event) => progress.push(event) },
		);
		expect(result.ranges).toEqual(ranges.map((range, index) => ({ ...range, exists: index !== 5 })));
		expect(result).not.toHaveProperty("_navigation");
		expect(progress.map((event) => event.phase)).toEqual(["start", "complete"]);
		progress.length = 0;
		await readWorkbookDocumentAsync(
			database,
			datasetId,
			docId,
			{ action: "validate", ranges },
			{ onProgress: (event) => progress.push(event) },
		);
		expect(progress[0]).toMatchObject({ phase: "start", cacheHit: false });
	} finally {
		database.close();
	}
}, 20_000);

it("keeps the event loop responsive and reuses successful validation without another process", async () => {
	const { root, datasetId, docId, database } = fixture();
	const attempts = simulatedReader(root, "delay");
	let ticks = 0;
	const timer = setInterval(() => ticks++, 10);
	const request = { action: "validate" as const, ranges: [{ sheet: "Valuation", range: "A98" }] };
	try {
		await readWorkbookDocumentAsync(database, datasetId, docId, request);
		expect(ticks).toBeGreaterThan(3);
		const progress: WorkbookReadProgress[] = [];
		await readWorkbookDocumentAsync(database, datasetId, docId, request, {
			onProgress: (event) => progress.push(event),
		});
		expect(progress).toEqual([expect.objectContaining({ phase: "complete", attempt: 0, cacheHit: true })]);
		expect(attempts()).toHaveLength(1);
	} finally {
		clearInterval(timer);
		database.close();
	}
});

it("retries one timed-out process, then reports the successful second attempt", async () => {
	const { root, datasetId, docId, database } = fixture();
	const attempts = simulatedReader(root, "retry");
	const progress: WorkbookReadProgress[] = [];
	try {
		await readWorkbookDocumentAsync(
			database,
			datasetId,
			docId,
			{ action: "validate", ranges: [{ sheet: "Valuation", range: "A97" }] },
			{ timeoutMs: 1000, onProgress: (event) => progress.push(event) },
		);
		expect(progress.map(({ phase, attempt }) => [phase, attempt])).toEqual([
			["start", 1],
			["retry", 2],
			["complete", 2],
		]);
		expect(attempts()).toHaveLength(2);
		for (const pid of attempts()) expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		database.close();
	}
});

it("stops after two timeouts and includes document and range context", async () => {
	const { root, datasetId, docId, database } = fixture();
	const attempts = simulatedReader(root, "timeout");
	try {
		const result = readWorkbookDocumentAsync(
			database,
			datasetId,
			docId,
			{ action: "validate", ranges: [{ sheet: "Valuation", range: "A96" }] },
			{ timeoutMs: 1000 },
		);
		await expect(result).rejects.toThrow(new RegExp(`${docId}.*Valuation.*A96.*attempt 2.*timed out`));
		await expect(result).rejects.toMatchObject({ code: "ETIMEDOUT", attempts: 2 });
		expect(attempts()).toHaveLength(2);
		for (const pid of attempts()) expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		database.close();
	}
});

it("cancels a running process promptly without retrying", async () => {
	const { root, datasetId, docId, database } = fixture();
	const attempts = simulatedReader(root, "timeout");
	const controller = new AbortController();
	const progress: WorkbookReadProgress[] = [];
	const cancellation = setInterval(() => {
		if (existsSync(join(root, "attempts.json"))) controller.abort();
	}, 10);
	try {
		await expect(
			readWorkbookDocumentAsync(
				database,
				datasetId,
				docId,
				{ action: "validate", ranges: [{ sheet: "Valuation", range: "A95" }] },
				{
					signal: controller.signal,
					onProgress: (event) => {
						progress.push(event);
					},
				},
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(progress.map((event) => event.phase)).toEqual(["start"]);
		expect(attempts()).toHaveLength(1);
		for (const pid of attempts()) expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		clearInterval(cancellation);
		database.close();
	}
});

it("does not retry parser errors or accept files changed during validation", async () => {
	const { root, datasetId, docId, database } = fixture();
	const attempts = simulatedReader(root, "error");
	try {
		const request = { action: "validate" as const, ranges: [{ sheet: "Valuation", range: "A94" }] };
		await expect(readWorkbookDocumentAsync(database, datasetId, docId, request)).rejects.toThrow("broken workbook");
		expect(attempts()).toHaveLength(1);
		simulatedReader(root, "change");
		await expect(readWorkbookDocumentAsync(database, datasetId, docId, request)).rejects.toThrow(
			"Original workbook changed during reading",
		);
		expect(attempts()).toHaveLength(2);
	} finally {
		database.close();
	}
});
