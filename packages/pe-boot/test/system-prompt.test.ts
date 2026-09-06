import { describe, expect, it } from "vitest";
import { buildPeSystemPrompt } from "../src/system-prompt.ts";

describe("PE PDF and Excel prompt", () => {
	it("preserves the PDF branch workspace, base tools, and page evidence contract", () => {
		const prompt = buildPeSystemPrompt("/workspace");
		expect(prompt).toContain("You serve financial researcher 小天");
		expect(prompt).toContain("The current project workspace is /workspace");
		for (const name of ["read", "bash", "edit", "write", "pe_pdf_search", "pe_pdf_read"])
			expect(prompt).toContain(`- ${name}:`);
		expect(prompt).toContain("Preserve their page: citations");
		expect(prompt).toContain("Preserve the internal #pe-source?evidence_id= fragment exactly");
		expect(prompt).not.toContain("Uploads register originals without parsing");
		expect(prompt).not.toContain("Presentation rules:");
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
