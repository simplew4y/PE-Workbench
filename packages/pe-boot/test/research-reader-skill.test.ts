import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as AgentSdk from "@earendil-works/pi-coding-agent";
import { createAgentSessionFromServices, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { PE_SKILLS_DIRECTORY } from "../src/capabilities.ts";
import { createPiResearchEngine } from "../src/research/pi-engine.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const sdk = await importOriginal<typeof AgentSdk>();
	return { ...sdk, createAgentSessionFromServices: vi.fn() };
});

it("discovers only skills and preloads shared references without granting filesystem or external access", async () => {
	const modelRuntime = { getModel: () => ({}), refresh: async () => undefined } as unknown as ModelRuntime;
	vi.mocked(createAgentSessionFromServices).mockImplementation(async ({ services, tools }) => {
		const loaded = services.resourceLoader.getSkills();
		expect(loaded.diagnostics).toEqual([]);
		const names = [
			"pe-document-retrieval",
			"pe-financial-model-reader",
			"pe-financial-model-understanding",
			"investment-framework-builder",
			"pe-investment-research",
		];
		expect(loaded.skills.map((skill) => skill.name)).toEqual(names);
		const instructions = services.resourceLoader.getAppendSystemPrompt();
		const files = [
			"pe-document-retrieval/SKILL.md",
			"pe-financial-model-reader/SKILL.md",
			"pe-financial-model-understanding/SKILL.md",
			"valuation-model-review/references/model-understanding.md",
			"valuation-model-review/references/valuation-methods.md",
			"investment-framework-builder/SKILL.md",
			"investment-framework-builder/references/state-contract.md",
			"investment-framework-builder/references/report.md",
			"valuation-model-review/references/chart-quality.md",
			"pe-investment-research/SKILL.md",
		];
		expect(instructions).toEqual(files.map((file) => readFileSync(join(PE_SKILLS_DIRECTORY, file), "utf8")));
		expect(new Set(instructions).size).toBe(instructions.length);
		expect(tools).toEqual(["pe_research_read", "pe_research_submit"]);
		throw new Error("Session configuration checked without a model call");
	});
	const engine = createPiResearchEngine("/unused", "dataset", modelRuntime, "test", "test");
	await expect(
		engine.generate({ objective: "分析模型", inputs: [], asOf: "2026-09-17" }, null, new AbortController().signal),
	).rejects.toThrow("Session configuration checked");
	expect(createAgentSessionFromServices).toHaveBeenCalledOnce();
});
