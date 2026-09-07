import { describe, expect, it } from "vitest";
import { buildPeSystemPrompt } from "../src/system-prompt.ts";

describe("PE system prompt", () => {
	it("keeps the PE role and fixed project workspace contract", () => {
		const prompt = buildPeSystemPrompt("C:\\research\\project");
		expect(prompt).toContain("You are a PE (private equity research) expert");
		expect(prompt).toContain("The current project workspace is C:/research/project");
		expect(prompt).toContain("- raw/: original research source materials");
		expect(prompt).toContain("- meta/: system-managed metadata");
		expect(prompt).toContain("- generated/: all user-visible outputs");
	});

	it("lists registered core capabilities without embedding the presentation Skill", () => {
		const prompt = buildPeSystemPrompt("/workspace");
		expect(prompt).toContain("- pe_pdf_search:");
		expect(prompt).toContain("- pe_document_open:");
		expect(prompt).toContain("- pe_source_detail:");
		expect(prompt).toContain("- pe_valuation_output_locate:");
		expect(prompt).toContain("- pe_render_ui:");
		expect(prompt).toContain("Preserve the internal #pe-source?evidence_id= fragment exactly");
		expect(prompt).not.toContain("Presentation decision policy");
		expect(prompt).not.toContain("Component capabilities");
	});

	it("keeps valuation verification and version-bound evidence rules always available", () => {
		const prompt = buildPeSystemPrompt("/workspace");
		expect(prompt).toContain("prepared by the background Excel pipeline");
		expect(prompt).toContain("same doc_id throughout analysis");
		expect(prompt).toContain("historical citations must never silently resolve to the latest version");
		expect(prompt).toContain("call pe_valuation_output_locate before choosing an output cell");
		expect(prompt).toContain("ranked candidate, not recalculation proof");
		expect(prompt).toContain("Only status=verified");
		expect(prompt).toContain("distinguish structural_status from calculation_validation.status");
		expect(prompt).toContain("When only a screenshot, excerpt, or another analysis is available");
		expect(prompt).toContain("do not invent workbook verification, doc_id, cells, citations, or tool results");
	});

	it("keeps complete but natural valuation answers without forcing visual components", () => {
		const prompt = buildPeSystemPrompt("/workspace");
		for (const section of ["模型逻辑框架", "核心驱动因素", "盈利预测与敏感性分析", "模型核心风险点"]) {
			expect(prompt).toContain(section);
		}
		expect(prompt).toContain("Default to prose, even for complex research questions");
		expect(prompt).toContain("there is no component quota");
		expect(prompt).toContain("never hide essential conclusions behind clicks");
		expect(prompt).toContain("not limited to 3-5 lines or 250 Chinese characters");
		expect(prompt).toContain("answer narrow questions directly");
		expect(prompt).toContain("verified inputs, the applicable formula, consistent units");
		expect(prompt).toContain("not a live quote");
		expect(prompt).toContain("compact superscript citation markers with accessible source labels");
		expect(prompt).not.toMatch(/green (?:citation|source|evidence)/i);
	});
});
