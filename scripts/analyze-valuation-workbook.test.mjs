import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import OpenAI from "openai";
import {
	analyzeSheets,
	columnLabel,
	createAsk,
	DEFAULT_OPTIONS,
	overviewPayload,
	parallelMap,
	readSheets,
} from "./analyze-valuation-workbook.ts";

const options = { ...DEFAULT_OPTIONS, intervalMs: 0 };

function cell(row, column, value = row) {
	return {
		ref: `${columnLabel(column)}${row}`,
		row,
		column,
		value,
		formula: null,
		cachedValue: null,
		notes: { numberFormat: "General", comment: null },
	};
}

test("reads paginated xlsm, hidden/empty sheets, formulas, cached zero, annotations and formats", () => {
	const directory = mkdtempSync(join(tmpdir(), "workbook-analysis-test-"));
	try {
		const fixture = join(directory, "fixture.py");
		const path = join(directory, "model.xlsm");
		writeFileSync(
			fixture,
			`from openpyxl import Workbook
from openpyxl.comments import Comment
from pathlib import Path
from zipfile import ZipFile
import sys
import xml.etree.ElementTree as ET
p = Path(sys.argv[1])
w = Workbook()
s = w.active
s.title = 'Forecast'
for i in range(1, 1006):
    s.cell(i, 1, i)
s['B1'] = '2026E'
s['B2'] = '=A2*0'
s['B3'] = '=A3*2'
s['C4'].comment = Comment('Original note\\nSecond line', 'Analyst')
s['C4'].number_format = '0.0%'
s.row_dimensions[4].hidden = True
s.column_dimensions['C'].hidden = True
s['D1'] = 'Unit: CNY million'
s.merge_cells('D1:E1')
s['Z1500'].comment = Comment('Outside used range', 'Analyst')
hidden = w.create_sheet('__proto__')
hidden.sheet_state = 'hidden'
hidden['A1'] = 'Discount rate'
hidden['B1'] = 0.1
w.create_sheet('Empty')
notes_only = w.create_sheet('Notes only')
notes_only['B5'].comment = Comment('Comment-only sheet', 'Analyst')
w.save(p)
with ZipFile(p) as z:
    entries = {n: z.read(n) for n in z.namelist()}
ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
root = ET.fromstring(entries['xl/worksheets/sheet1.xml'])
for c in root.iter(ns + 'c'):
    if c.get('r') == 'B2':
        c.find(ns + 'v').text = '0'
entries['xl/worksheets/sheet1.xml'] = ET.tostring(root)
entries['[Content_Types].xml'] = entries['[Content_Types].xml'].replace(b'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', b'application/vnd.ms-excel.sheet.macroEnabled.main+xml')
with ZipFile(p, 'w') as z:
    for n, data in entries.items():
        z.writestr(n, data)
`,
		);
		execFileSync(process.env.PE_EXCEL_PYTHON || "packages/pe-boot/python/.venv/bin/python", [fixture, path]);
		const sheets = readSheets(path);
		assert.deepEqual(
			sheets.map((sheet) => sheet.name),
			["Forecast", "__proto__", "Empty", "Notes only"],
		);
		assert.equal(sheets[1].state, "hidden");
		assert.equal(sheets[2].cells.length, 0);
		assert.equal(sheets[0].cells.find((entry) => entry.ref === "Z1500").notes.comment.text, "Outside used range");
		assert.equal(sheets[3].cells.length, 1);
		assert.equal(sheets[3].cells[0].ref, "B5");
		assert.equal(sheets[3].cells[0].notes.comment.text, "Comment-only sheet");
		assert.equal(sheets[0].cells.filter((entry) => entry.column === 1).length, 1005);
		const cached = sheets[0].cells.find((entry) => entry.ref === "B2");
		assert.equal(cached.value, "=A2*0");
		assert.equal(cached.formula, "=A2*0");
		assert.equal(cached.cachedValue, 0);
		assert.equal(cached.notes.formulaCacheStatus, "present");
		assert.equal(sheets[0].cells.find((entry) => entry.ref === "B3").notes.formulaCacheStatus, "missing");
		const note = sheets[0].cells.find((entry) => entry.ref === "C4");
		assert.equal(note.notes.comment.text, "Original note\nSecond line");
		assert.equal(note.notes.hidden_row, true);
		assert.equal(note.notes.hidden_column, true);
		assert.equal(note.notes.numberFormat, "0.0%");
		assert.equal(sheets[0].cells.find((entry) => entry.ref === "D1").notes.merged_range, "D1:E1");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("two stages cover every occupied row/column; split large axes; preserve full originals", async () => {
	const longNote = "Original comment".repeat(300);
	const cells = Array.from({ length: 18 }, (_, index) => cell(index + 1, 1, `Metric ${index}`));
	for (let column = 2; column <= 32; column++)
		cells.push({ ...cell(18, column, "数据".repeat(1000)), notes: { comment: { text: longNote } } });
	const sheets = [
		{ name: "Forecast", state: "visible", usedRange: "A1:AF18", cells },
		{ name: "Valuation", state: "hidden", usedRange: "A1:B1", cells: [cell(1, 1, "DCF"), cell(1, 2, 100)] },
		{ name: "Empty", state: "visible", usedRange: null, cells: [] },
	];
	const calls = [];
	let active = 0;
	let peak = 0;
	const ask = createAsk(async (system, user) => {
		const request = JSON.parse(user);
		assert.ok(Buffer.byteLength(system) + Buffer.byteLength(user) <= options.inputBytes);
		calls.push(request);
		active++;
		peak = Math.max(peak, active);
		await sleep(2);
		active--;
		return JSON.stringify(
			request.items
				? {
						explanations: [...request.items]
							.reverse()
							.map((item) => ({ id: item.id, aiExplanation: `解释 ${item.id}` })),
					}
				: { summary: request.sheet ? `${request.sheet} 的说明` : "整体模型概览" },
		);
	}, options);
	const result = await analyzeSheets(sheets, ask, options);
	assert.equal(result.summary, "整体模型概览");
	assert.equal(peak, 2);
	assert.equal(calls.filter((request) => request.coverage).length, 3, "one first-pass request per sheet");
	const overviewEnd = calls.findIndex((request) => request.sheets);
	assert.equal(overviewEnd, 3, "model overview follows every sheet overview");
	assert.ok(calls.slice(overviewEnd + 1).every((request) => request.items));
	assert.equal(result.sheets[0].rows.length, 18);
	assert.equal(result.sheets[0].columns.length, 32);
	assert.ok(result.sheets[0].rows.at(-1).parts.length > 1, "large row was split");
	for (const sheet of result.sheets) {
		assert.ok([...sheet.rows, ...sheet.columns].every((entry) => entry.aiExplanation));
		const original = sheets.find((entry) => entry.name === sheet.name).cells;
		assert.deepEqual(
			sheet.rows
				.flatMap((row) => row.cells)
				.map((entry) => entry.ref)
				.sort(),
			original.map((entry) => entry.ref).sort(),
		);
		assert.deepEqual(
			sheet.columns
				.flatMap((column) => column.cells)
				.map((entry) => entry.ref)
				.sort(),
			original.map((entry) => entry.ref).sort(),
		);
	}
	assert.equal(result.sheets[0].rows.at(-1).cells.find((entry) => entry.ref === "B18").notes.comment.text, longNote);
	assert.equal(result.sheets[0].rows.at(-1).cells.find((entry) => entry.ref === "B18").value.length, 2000);
});

test("overview samples cover the sheet tail and report partial coverage", () => {
	const cells = Array.from({ length: 1500 }, (_, index) => cell(index + 1, 1));
	const payload = overviewPayload({ name: "Large", state: "visible", usedRange: "A1:A1500", cells }, options);
	assert.equal(payload.coverage.sampled, true);
	assert.equal(payload.coverage.totalCells, 1500);
	assert.ok(payload.cells.some((entry) => entry[0] === "A1500"));
	assert.ok(payload.cells.some((entry) => entry[0] === "A1"));
});

test("many sheet summaries are reduced in bounded groups before the final model summary", async () => {
	const sheets = Array.from({ length: 24 }, (_, index) => ({
		name: `Sheet${index}`,
		state: "visible",
		usedRange: null,
		cells: [],
	}));
	const requests = [];
	const ask = async (_label, payload, validate) => {
		requests.push(payload);
		assert.ok(Buffer.byteLength(JSON.stringify(payload)) < options.inputBytes);
		return validate({ summary: "模型概述".repeat(200) });
	};
	const result = await analyzeSheets(sheets, ask, options);
	assert.equal(result.sheets.length, 24);
	assert.equal(requests.filter((request) => request.coverage).length, 24);
	const reductions = requests.filter((request) => request.sheets);
	assert.ok(reductions.length > 1);
	assert.equal(reductions.slice(0, -1).flatMap((request) => request.sheets).length, 24);
});

test("request starts share one interval gate even when called concurrently", async () => {
	const starts = [];
	const ask = createAsk(
		async () => {
			starts.push(Date.now());
			return '{"summary":"ok"}';
		},
		{ ...options, intervalMs: 25 },
	);
	await Promise.all(Array.from({ length: 4 }, (_, index) => ask(String(index), {}, (value) => value.summary)));
	for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 24);
});

test("invalid JSON is retried, permanent auth errors are not, oversize input is rejected before calling", async () => {
	let calls = 0;
	const ask = createAsk(async () => (++calls === 1 ? "invalid" : '{"summary":"ok"}'), options);
	assert.equal(await ask("invalid json", {}, (value) => value.summary), "ok");
	assert.equal(calls, 2);
	let authCalls = 0;
	const auth = createAsk(async () => {
		authCalls++;
		throw new OpenAI.AuthenticationError(401, { message: "invalid key" }, "invalid key", new Headers());
	}, options);
	await assert.rejects(
		auth("auth", {}, (value) => value),
		/invalid key/,
	);
	assert.equal(authCalls, 1);
	await assert.rejects(
		auth("large", { text: "x".repeat(30_000) }, (value) => value),
		/exceeds inputBytes/,
	);
	assert.equal(authCalls, 1);
});

test("missing/duplicate item IDs fail instead of producing incomplete JSON", async () => {
	const ask = async (_label, payload, validate) => validate(payload.items ? { explanations: [] } : { summary: "ok" });
	await assert.rejects(
		analyzeSheets([{ name: "A", state: "visible", usedRange: "A1", cells: [cell(1, 1)] }], ask, options),
		/Incomplete row\/column explanations/,
	);
	const duplicate = async (_label, payload, validate) =>
		validate(
			payload.items
				? {
						explanations: [
							{ id: payload.items[0].id, aiExplanation: "x" },
							{ id: payload.items[0].id, aiExplanation: "x" },
						],
					}
				: { summary: "ok" },
		);
	await assert.rejects(
		analyzeSheets([{ name: "A", state: "visible", usedRange: "A1", cells: [cell(1, 1)] }], duplicate, options),
		/duplicate explanation id/,
	);
});

test("worker failure drains in-flight requests and does not start new work", async () => {
	const started = [];
	let drained = false;
	await assert.rejects(
		parallelMap([0, 1, 2, 3], 2, async (value) => {
			started.push(value);
			if (value === 0) {
				await sleep(2);
				throw new Error("fail");
			}
			await sleep(20);
			drained = true;
		}),
		/fail/,
	);
	assert.deepEqual(started, [0, 1]);
	assert.equal(drained, true);
});
