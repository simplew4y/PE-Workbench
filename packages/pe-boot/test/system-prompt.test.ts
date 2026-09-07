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
});
