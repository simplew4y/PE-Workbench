import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePeDocument, registerPeDocuments } from "../src/documents.ts";
import { discoverPeDrivers } from "../src/tools/driver-discover.ts";
import { peDriverSensitivityTool, runPeDriverSensitivity } from "../src/tools/driver-sensitivity.ts";

const temporaryDirectories: string[] = [];
const fixtures = join(import.meta.dirname, "fixtures");

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("driver sensitivity recalculation", () => {
	it("registers the recalculation tool", () => {
		expect(peDriverSensitivityTool.name).toBe("pe_driver_sensitivity");
	});

	it("discovers upstream inputs without presenting structural order as sensitivity", async () => {
		const root = mkdtempSync(join(tmpdir(), "pe-driver-discovery-"));
		temporaryDirectories.push(root);
		mkdirSync(join(root, "raw"));
		mkdirSync(join(root, "meta"));
		mkdirSync(join(root, "generated"));
		const bytes = readFileSync(join(fixtures, "excel-parity.xlsx"));
		const registered = registerPeDocuments(root, "discovery-dataset", [{ name: "excel-parity.xlsx", bytes }]);
		const docId = String(registered.documents[0].doc_id);
		await preparePeDocument(root, { docId });
		const result = discoverPeDrivers(root, {
			docId,
			outputSheet: "DCF",
			outputCellRef: "B7",
		});

		expect(result.output).toMatchObject({ sheet_name: "DCF", cell_ref: "B7" });
		expect(result.candidates.length).toBeGreaterThan(0);
		expect(result.candidates.every((candidate) => candidate.sensitivity_status === "not_run")).toBe(true);
		expect(result.sensitivity_ranking_available).toBe(false);
		expect(result.answer_contract).toContain("Do not call discovery_rank a sensitivity");
	});

	it.runIf(Boolean(process.env.PE_SPREADSHEET_RECALCULATOR))(
		"shocks upstream inputs, recalculates formula-derived nodes, ranks measured effects, and preserves the original",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "pe-driver-sensitivity-"));
			temporaryDirectories.push(root);
			mkdirSync(join(root, "raw"));
			mkdirSync(join(root, "meta"));
			mkdirSync(join(root, "generated"));
			const bytes = readFileSync(join(fixtures, "excel-parity.xlsx"));
			const registered = registerPeDocuments(root, "sensitivity-dataset", [{ name: "excel-parity.xlsx", bytes }]);
			const docId = String(registered.documents[0].doc_id);
			const result = await runPeDriverSensitivity(root, {
				docId,
				outputSheet: "DCF",
				outputCellRef: "B7",
				shockPercent: 5,
				maxDrivers: 10,
			});

			expect(result.status).toBe("completed");
			expect(result.output.baseline_value).toBeCloseTo(190, 8);
			expect(result.sensitivity_ranking_available).toBe(true);
			expect(result.original_unchanged).toBe(true);
			expect(result.ranked_drivers[0]).toMatchObject({ label: "Diluted shares", active_driver: true });
			const freeCashFlow = result.ranked_drivers.find((driver) => driver.label === "Free cash flow");
			expect(freeCashFlow?.up_output).toBeCloseTo(195, 8);
			expect(freeCashFlow?.propagation.map((node) => node.label)).toEqual([
				"Free cash flow",
				"DCF value",
				"Equity value",
				"Per share value",
			]);
			expect(existsSync(join(root, result.artifacts.result_json))).toBe(true);
			expect(existsSync(join(root, result.artifacts.summary_markdown))).toBe(true);
			expect(readFileSync(join(root, "raw", "excel-parity.xlsx"))).toEqual(bytes);
		},
		180_000,
	);
});
