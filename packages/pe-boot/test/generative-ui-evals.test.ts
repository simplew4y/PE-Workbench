import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type EvaluationCase = {
	id: string;
	prompt: string;
	expected: "prose" | "leaf" | "brief" | "adaptive" | "safe-alternative";
	required: string[];
	forbidden: string[];
};

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const cases = JSON.parse(
	readFileSync(join(packageDirectory, "skills/pe-generative-ui/references/evaluation-cases.json"), "utf8"),
) as EvaluationCase[];

const knownKinds = new Set([
	"company_overview",
	"financial_trend",
	"metric_comparison",
	"research_timeline",
	"insight_callout",
	"source_collection",
	"relationship_map",
	"kpi_strip",
	"waterfall_chart",
	"risk_matrix",
	"segment_breakdown",
	"research_brief",
	"valuation_range",
	"peer_quadrant",
	"catalyst_calendar",
]);

describe("PE generative UI evaluation corpus", () => {
	it("contains a broad, unique set of routing and safety cases", () => {
		expect(cases.length).toBeGreaterThanOrEqual(20);
		expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
		expect(new Set(cases.map((item) => item.expected))).toEqual(
			new Set(["prose", "leaf", "brief", "adaptive", "safe-alternative"]),
		);
	});

	it("references only registered component kinds", () => {
		for (const evaluation of cases) {
			expect(evaluation.prompt.trim().length).toBeGreaterThan(0);
			for (const kind of [...evaluation.required, ...evaluation.forbidden]) expect(knownKinds.has(kind)).toBe(true);
			if (evaluation.expected === "brief") expect(evaluation.required).toContain("research_brief");
		}
	});
});
