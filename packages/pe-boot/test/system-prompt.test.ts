import { describe, expect, it } from "vitest";
import { buildPeSystemPrompt } from "../src/system-prompt.ts";

describe("PE presentation prompt", () => {
	it("compares relationship-based alternatives without another model or diversity quota", () => {
		const prompt = buildPeSystemPrompt("/workspace");
		expect(prompt).toContain("A tie goes to prose/Markdown");
		expect(prompt).toContain("Schema eligibility is necessary but never sufficient");
		expect(prompt).toContain("signed reconciliation from start to end");
		expect(prompt).toContain("No diversity quota, random routing");
		expect(prompt).toContain("all tool calls in the answer as one composition");
		expect(prompt.indexOf("Presentation decision policy")).toBeLessThan(prompt.indexOf("Component capabilities"));
	});

	it("documents the native UI contract without allowing arbitrary markup", () => {
		const prompt = buildPeSystemPrompt("/workspace");
		expect(prompt).toContain("`pe_render_ui` tool");
		expect(prompt).toContain("`company_overview`");
		expect(prompt).toContain("`financial_trend`");
		expect(prompt).toContain("`metric_comparison`");
		expect(prompt).toContain("`research_timeline`");
		expect(prompt).toContain("`relationship_map`");
		expect(prompt).toContain("`insight_callout`");
		expect(prompt).toContain("`source_collection`");
		expect(prompt).toContain("`research_brief`");
		expect(prompt).toContain("`valuation_range`");
		expect(prompt).toContain("`peer_quadrant`");
		expect(prompt).toContain("`catalyst_calendar`");
		expect(prompt).toContain("counterevidence");
		expect(prompt).toContain("actively art-direct it");
		expect(prompt).toContain("presentation.palette");
		expect(prompt).toContain("Preserve the internal #pe-source?evidence_id= fragment exactly");
		expect(prompt).toContain("Default to prose, even for complex research questions");
		expect(prompt).toContain("Visual presentation does not imply interaction");
		expect(prompt).not.toContain("For a multi-angle research question, compose");
		expect(prompt).toContain("current state → change or drivers → implication");
		expect(prompt).toContain("sharp, conversational research partner");
		expect(prompt).toContain('Avoid mechanical structures such as "一、二、三"');
		expect(prompt).toContain("Never simulate the tool with a fenced JSON block");
	});
});
