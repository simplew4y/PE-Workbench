import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerPeDocuments } from "../src/documents.ts";
import { excelPython } from "../src/excel-processing.ts";
import {
	applyPeModelUpdate,
	listPeModelVersions,
	peModelUpdateTool,
	reviewPeModelVersion,
} from "../src/tools/model-update.ts";

const temporaryDirectories: string[] = [];
const fixturePath = join(import.meta.dirname, "fixtures", "excel-parity.xlsx");

function project(format: "xlsx" | "xlsm") {
	const root = mkdtempSync(join(tmpdir(), "pe-model-update-test-"));
	temporaryDirectories.push(root);
	for (const directory of ["raw", "meta", "generated"]) mkdirSync(join(root, directory));
	const filename = `excel-parity.${format}`;
	let bytes = readFileSync(fixturePath);
	if (format === "xlsm") {
		const script = join(root, "macro-format-fixture.py");
		writeFileSync(
			script,
			"import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as source,zipfile.ZipFile(sys.argv[2],'w') as target:\n for entry in source.infolist():\n  value=source.read(entry.filename)\n  if entry.filename=='[Content_Types].xml': value=value.replace(b'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',b'application/vnd.ms-excel.sheet.macroEnabled.main+xml')\n  target.writestr(entry,value)\n",
		);
		const result = spawnSync(excelPython(), [script, fixturePath, join(root, filename)], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr);
		bytes = readFileSync(join(root, filename));
	}
	const registered = registerPeDocuments(root, "model-update-dataset", [{ name: filename, bytes }]);
	return { root, bytes, filename, docId: String(registered.documents[0].doc_id) };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("controlled rolling model updates", () => {
	it("registers the model update tool", () => {
		expect(peModelUpdateTool.name).toBe("pe_model_update");
	});

	it.runIf(Boolean(process.env.PE_SPREADSHEET_RECALCULATOR)).each(["xlsx", "xlsm"] as const)(
		"writes, recalculates and rolls forward %s without changing its format or original",
		async (format) => {
			const { root, bytes, filename, docId } = project(format);
			const actuals = await applyPeModelUpdate(root, {
				docId,
				changes: [
					{
						sheet: "DCF",
						cell: "B2",
						expectedValue: 100,
						newValue: 120,
						kind: "actual",
						evidenceIds: ["filing-q3"],
						reason: "Replace the prior forecast with reported free cash flow",
					},
				],
				outputs: [{ key: "per_share_value", sheet: "DCF", cell: "B7" }],
				promoteIfEligible: true,
			});

			expect(actuals).toMatchObject({
				state: "current_research",
				can_advance_baseline: true,
				promoted: true,
				outputs: { per_share_value: 210 },
				validation: { recalculated: true, hard_errors: [], new_error_cells: [] },
				source: { unchanged: true },
			});
			expect(existsSync(join(root, actuals.file.path))).toBe(true);
			expect(actuals.file.path.endsWith(`.${format}`)).toBe(true);
			expect(readFileSync(join(root, "raw", filename))).toEqual(bytes);

			const candidate = await applyPeModelUpdate(root, {
				docId,
				changes: [
					{
						sheet: "DCF",
						cell: "B1",
						expectedValue: 0.1,
						newValue: 0.12,
						kind: "assumption",
						metricId: "wacc",
						evidenceIds: ["rates", "risk-premium"],
						reason: "Reflect the updated financing and risk environment",
					},
				],
				outputs: [{ key: "per_share_value", sheet: "DCF", cell: "B7" }],
				reviewItems: [
					{
						metricId: "wacc",
						period: "2026Q3",
						originalForecast: 0.1,
						actual: 0.12,
						tolerance: { maxAbsoluteVariance: 0.005 },
						evidenceIds: ["rates", "risk-premium"],
						revision: {
							proposedValue: 0.12,
							evidenceIds: ["rates", "risk-premium"],
							hasBaseBearBullScenarios: true,
						},
					},
				],
			});

			expect(candidate).toMatchObject({
				parent_version_id: actuals.version_id,
				state: "candidate",
				approval_eligible: true,
				can_advance_baseline: false,
				promoted: false,
				outputs: { per_share_value: 190 },
				validation: { hard_errors: [], new_error_cells: [] },
			});

			const reviewed = await reviewPeModelVersion(root, {
				docId,
				versionId: candidate.version_id,
				decision: "approved",
				note: "Researcher approved the WACC revision and its evidence.",
				promoteIfApproved: true,
			});
			expect(reviewed).toMatchObject({ effective_state: "reviewed", promoted: true });

			const history = await listPeModelVersions(root, { docId });
			expect(history.current_version_id).toBe(candidate.version_id);
			expect(history.versions).toHaveLength(2);
			expect(history.versions.map((version) => version.version_id)).toEqual([
				candidate.version_id,
				actuals.version_id,
			]);

			await expect(
				applyPeModelUpdate(root, {
					docId,
					changes: [
						{
							sheet: "DCF",
							cell: "B7",
							expectedValue: 190,
							newValue: 200,
							kind: "actual",
							evidenceIds: ["manual"],
							reason: "Attempted output override",
						},
					],
				}),
			).rejects.toThrow("Refusing to overwrite formula cell DCF!B7");
			expect((await listPeModelVersions(root, { docId })).versions).toHaveLength(2);
		},
		180_000,
	);
});
