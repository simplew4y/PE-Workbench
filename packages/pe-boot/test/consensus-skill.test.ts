import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { registerPeTools } from "../src/tools/index.ts";

afterEach(() => vi.unstubAllEnvs());

it("discovers the consensus Skill and only references real enabled tools", () => {
	vi.stubEnv("PE_CONSENSUS_ENABLED", "1");
	const directory = join(dirname(dirname(fileURLToPath(import.meta.url))), "skills/pe-consensus-divergence");
	const result = loadSkillsFromDir({ dir: directory, source: "test" });
	expect(result.diagnostics).toEqual([]);
	expect(result.skills).toHaveLength(1);
	expect(result.skills[0].name).toBe("pe-consensus-divergence");
	expect(result.skills[0].disableModelInvocation).not.toBe(true);
	const registered = new Set<string>();
	registerPeTools({
		registerTool(tool: { name: string }) {
			registered.add(tool.name);
		},
		on() {},
	} as unknown as ExtensionAPI);
	const instructions = readFileSync(result.skills[0].filePath, "utf8");
	for (const name of instructions.match(/\bpe_[a-z_]+\b/g) ?? []) expect(registered.has(name), name).toBe(true);
});
