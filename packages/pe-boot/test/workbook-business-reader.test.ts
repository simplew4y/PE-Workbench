import { rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { sourceId } from "../src/source.ts";
import { validatePeModel } from "../src/tools/model-validate.ts";
import { resolvePeValuationDate } from "../src/tools/valuation-date.ts";
import { locatePeValuationOutputs } from "../src/tools/valuation-output.ts";
import {
	buildPeValuationReport,
	type PeValuationReportOptions,
	type ReportFactRequest,
} from "../src/tools/valuation-report.ts";
import { saveStockTracker } from "../src/tracking.ts";
import { workbookSourceFixture } from "./workbook-source-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fact(id = "target", cell = "B7", label = "Target Price"): ReportFactRequest {
	return {
		id,
		sheet_name: "Valuation",
		cell_ref: cell,
		expected_label: label,
		expected_unit: "CNY/share",
		role: id === "price" ? "current_price" : "target_price",
		context: {
			label: { sheet: "Valuation", cell: cell.replace("B", "A"), text: label },
			unit: { sheet: "Valuation", cell: "B7", text: '"CNY/share" 0.00', field: "number_format" },
		},
	};
}

function report(docId: string, facts = [fact()]): PeValuationReportOptions {
	return {
		docId,
		scope: "focused",
		facts,
		calculations: [],
		sections: [{ title: "估值依据", fact_ids: facts.map((item) => item.id) }],
	};
}

it("uses original cells for search, date selection, model checks, reporting and tracking without full cell tables", async () => {
	const { root, docId, datasetId } = await workbookSourceFixture();
	roots.push(root);
	const found = locatePeValuationOutputs(root, { docId, query: "Target Price" });
	expect(found.matches).toEqual(
		expect.arrayContaining([expect.objectContaining({ cell_ref: "A7", raw_value: "Target Price" })]),
	);
	expect(found).not.toHaveProperty("selected_output");
	const date = resolvePeValuationDate(root, {
		docId,
		dateSource: { sheet: "Valuation", cell: "B1", text: "2026-08-31T00:00:00" },
		labelSource: { sheet: "Valuation", cell: "A1", text: "Valuation Date" },
		valuationDate: "2026-08-31",
	});
	expect(date).toMatchObject({ status: "inferred", valuation_date: "2026-08-31" });
	expect(date.evidence_ids).toHaveLength(2);
	expect(validatePeModel(root, { docId })).toMatchObject({
		scan_complete: true,
		formula_reference_validation: { status: "not_run" },
	});
	const options = report(docId, [fact(), fact("price", "B6", "Current Price")]);
	options.calculations = [{ id: "upside", operation: "upside", left: "target", right: "price" }];
	options.sections[0].fact_ids.push("upside");
	const rendered = buildPeValuationReport(root, options);
	expect(rendered.status, rendered.issues.join("\n")).toBe("ready");
	expect(rendered.calculations[0].value).toBeCloseTo(0.2);
	expect(rendered.rendered_report).toContain("120.00 CNY/股");
	expect(rendered.rendered_report).toContain("#pe-source?evidence_id=source%3A");
	const evidenceId = sourceId({ docId, location: { kind: "excel", sheet: "Valuation", range: "B7" } });
	const tracked = saveStockTracker(
		root,
		datasetId,
		{
			name: "Source target",
			code: "000001.SZ",
			currency: "CNY",
			startDate: "2026-01-01",
			targetDate: "2027-12-31",
			enabled: false,
			rule: { kind: "target", base: 120, effectiveDate: "2026-08-31", evidenceId },
		},
		0,
	);
	expect(tracked.valuation).toMatchObject({ base: 120, sourceValue: 120, docId });
	expect(() =>
		saveStockTracker(
			root,
			datasetId,
			{ ...tracked.config, rule: { kind: "target", base: 121, effectiveDate: "2026-08-31", evidenceId } },
			tracked.revision,
		),
	).toThrow("does not match");
	const bound = saveStockTracker(
		root,
		datasetId,
		{
			...tracked.config,
			id: undefined,
			rule: {
				kind: "cell",
				docId,
				sheet: "Valuation",
				cell: "B7",
				label: "Target Price",
				period: "2026",
				unit: "CNY/share",
				context: { ...fact().context, period: { sheet: "Valuation", cell: "B1", text: "2026-08-31T00:00:00" } },
				multipliers: { bear: 0.8, base: 1, bull: 1.2 },
				minValue: 1,
				maxValue: 200,
			},
		},
		0,
	);
	expect(bound.valuation).toMatchObject({ bear: 96, base: 120, bull: 144 });
	if (bound.config.rule.kind !== "cell") throw new Error("Expected cell rule");
	bound.config.rule.context!.unit.text = "changed unit";
	const stale = saveStockTracker(root, datasetId, bound.config, bound.revision);
	expect(stale.valuation?.base).toBe(120);
	expect(stale.valuationStatus).toBe("stale");
}, 30_000);

it("rejects wrong source context, incompatible conversions and unavailable formula caches", async () => {
	const { root, docId } = await workbookSourceFixture();
	roots.push(root);
	const wrong = fact();
	wrong.context!.label.text = "Wrong label";
	expect(buildPeValuationReport(root, report(docId, [wrong])).issues.join(" ")).toContain("does not match");
	expect(
		buildPeValuationReport(root, report(docId, [{ ...fact(), display_unit: "USD/share" }])).issues.join(" "),
	).toContain("incompatible unit");
	const unavailable = { ...fact(), sheet_name: "Hidden assumptions", cell_ref: "B2" };
	expect(buildPeValuationReport(root, report(docId, [unavailable])).status).toBe("blocked");
	expect(() =>
		resolvePeValuationDate(root, {
			docId,
			dateSource: { sheet: "Valuation", cell: "B1", text: "wrong" },
			labelSource: { sheet: "Valuation", cell: "A1", text: "Valuation Date" },
			valuationDate: "2026-08-31",
		}),
	).toThrow("does not match");
}, 30_000);

it("renders only agent-selected outputs and keeps prose validation separate", async () => {
	const { root, docId } = await workbookSourceFixture();
	roots.push(root);
	const options = report(docId);
	options.scope = "overview";
	options.facts[0].valuation_method = "Selected model method";
	const result = buildPeValuationReport(root, options);
	expect(result.status, result.issues.join("\n")).toBe("ready");
	expect(result.rendered_report).toContain("Selected model method");
	expect(result.rendered_report).toContain("=B5/10");
	options.sections[0].analysis = "收入增长20%。";
	expect(buildPeValuationReport(root, options)).toMatchObject({ status: "blocked", repair_scope: "sections" });
	const empty = report(docId, []);
	empty.scope = "overview";
	expect(buildPeValuationReport(root, empty).status).toBe("blocked");
}, 30_000);
