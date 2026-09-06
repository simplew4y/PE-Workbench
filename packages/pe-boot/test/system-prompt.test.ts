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

describe("PE PDF and Excel prompt", () => {
	it("preserves the PDF branch workspace, base tools, and page evidence contract", () => {
		const prompt = buildPeSystemPrompt("/workspace");
		expect(prompt).toContain("The current project workspace is /workspace");
		for (const name of ["read", "bash", "edit", "write", "pe_pdf_search", "pe_pdf_read"])
			expect(prompt).toContain(`- ${name}:`);
		expect(prompt).toContain("Preserve their page: citations");
		expect(prompt).toContain("Preserve the internal #pe-source?evidence_id= fragment exactly");
		expect(prompt).not.toContain("Uploads register originals without parsing");
		expect(prompt).toContain("Presentation rules:");
		expect(prompt).toContain("For supported Word, PowerPoint, and text documents");
	});

	it("adds complete Excel verification and immutable source routing", () => {
		const prompt = buildPeSystemPrompt("/workspace");
		expect(prompt).toContain("Legacy cell: links remain resolvable");
		expect(prompt).toContain("historical citations must never silently resolve to the latest version");
		expect(prompt).toContain("before choosing an output cell");
		expect(prompt).toContain('Only status=verified supports the phrase "verified valuation date"');
		expect(prompt).toContain("preserve ambiguous candidates instead of choosing the first label match");
		for (const section of ["模型逻辑框架", "核心驱动因素", "盈利预测与敏感性分析", "模型核心风险点"])
			expect(prompt).toContain(section);
		expect(prompt).toContain("A model-entered or cached price is not a live quote");
	});
});
