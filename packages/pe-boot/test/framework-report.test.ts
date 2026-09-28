import { describe, expect, it } from "vitest";
import { validateFrameworkContent } from "../src/research/model.ts";
import { renderInvestmentFrameworkMarkdown } from "../src/research/report.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

describe("seven-section framework document rendering", () => {
	it("treats field values as text while preserving generated citations and document boundaries", () => {
		const content = frameworkFixture();
		const forged = "[夹带引用](#pe-source?evidence_id=source%3Aforged)";
		const payload = `${forged}\n~~~text\n# 假章节\n<script>unsafe</script>\n列\\|分隔`;
		content.title = payload;
		content.sections.researchSetup.objective = payload;
		content.sections.currentAssessment.summary = payload;
		content.sections.businessModel.summary = payload;
		content.sections.investmentJudgments.items[0].subject = payload;
		content.sections.investmentJudgments.items[0].claim = payload;
		content.sections.investmentJudgments.items[0].evidenceIds = ["source:verified"];
		content.sections.valuation.summary = payload;
		content.sections.valuation.marketExpectations = payload;
		content.sections.evidenceAndChanges.openQuestions[0].question = payload;
		content.sections.evidenceAndChanges.openQuestions[0].evidenceNeeded = payload;
		content.sections.evidenceAndChanges.coverageGaps = [payload];
		content.sections.evidenceAndChanges.sources = [
			{ evidenceId: "source:verified", description: payload, quality: "已定位", limitations: "待核实" },
		];
		const before = structuredClone(content);
		const report = renderInvestmentFrameworkMarkdown(content);
		expect(report.match(/^## /gm)).toHaveLength(7);
		expect(report.match(/^~~~.*$/gm)).toEqual(["~~~mermaid", "~~~"]);
		expect(report).toContain("\\[夹带引用\\]\\(\\#pe\\-source?evidence\\_id=source%3Aforged\\)");
		expect(report).not.toContain(forged);
		expect(report).not.toContain("<script>");
		expect(report).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
		expect(report).toContain("<br>\\~\\~\\~text<br>\\# 假章节");
		expect(report).toContain("[依据 1](#pe-source?evidence_id=source%3Averified)");
		expect(content).toEqual(before);
	});

	it("preserves a shared business driver as one connected node", () => {
		const content = frameworkFixture();
		content.sections.businessModel.drivers = [
			{ from: "收入", to: "利润", mechanism: "收入扣除成本", evidenceIds: [] },
			{ from: "利润", to: "EPS", mechanism: "利润除以股数", evidenceIds: [] },
		];
		const diagram = renderInvestmentFrameworkMarkdown(content).split("~~~mermaid\n")[1].split("\n~~~")[0];
		expect(diagram).toContain('D0["收入"]');
		expect(diagram.match(/\["利润"\]/g)).toHaveLength(1);
		expect(diagram).toContain('D2["EPS"]');
		expect(diagram).toContain("D0 --> D1");
		expect(diagram).toContain("D1 --> D2");
	});

	it("preserves decision detail, evidence links and null values without changing the saved content", () => {
		const content = frameworkFixture();
		content.sections.researchSetup.preferences = "关注现金流|避免虚假精确";
		content.sections.investmentJudgments.items[0].counterEvidenceIds = ["source:counter+one/测试"];
		const before = structuredClone(content);
		const report = renderInvestmentFrameworkMarkdown(content);
		expect(report.match(/^## /gm)).toHaveLength(7);
		expect(report).toContain("关注现金流\\|避免虚假精确");
		expect(report).toContain("source%3Acounter%2Bone%2F%E6%B5%8B%E8%AF%95");
		expect(report).toContain("订单改善可能来自短期补库存");
		expect(report).toContain("重新评估需求判断");
		expect(report).toContain("EUR/股");
		expect(report).toContain("待补充");
		expect(report).not.toContain("undefined");
		expect(report).not.toContain("xychart-beta");
		expect(content).toEqual(before);
	});

	it("charts only compatible, known scenario valuations", () => {
		const content = frameworkFixture();
		content.sections.valuation.scenarios.forEach((scenario, index) => {
			scenario.value = (index + 1) * 100;
			scenario.asOf = "2026-09-28";
		});
		expect(renderInvestmentFrameworkMarkdown(content)).toContain("bar [100, 200, 300]");
		content.sections.valuation.scenarios[1].unit = "USD/股";
		expect(renderInvestmentFrameworkMarkdown(content)).not.toContain("xychart-beta");
		content.sections.valuation.scenarios[1].unit = "EUR/股";
		content.sections.valuation.scenarios[1].asOf = "2025-09-28";
		expect(renderInvestmentFrameworkMarkdown(content)).not.toContain("xychart-beta");
		content.sections.valuation.scenarios.forEach((scenario) => {
			scenario.asOf = null;
		});
		expect(renderInvestmentFrameworkMarkdown(content)).not.toContain("xychart-beta");
	});

	it("allows an evidence-poor document without inventing an investment judgment", () => {
		const content = frameworkFixture();
		content.sections.investmentJudgments.items = [];
		expect(validateFrameworkContent(content)).toEqual(content);
		expect(renderInvestmentFrameworkMarkdown(content).match(/^## /gm)).toHaveLength(7);
		expect(renderInvestmentFrameworkMarkdown(content)).toContain("现有证据不足以形成投资判断");
		content.sections.evidenceAndChanges.coverageGaps = [];
		expect(() => validateFrameworkContent(content)).toThrow("evidence gaps");
	});
});
