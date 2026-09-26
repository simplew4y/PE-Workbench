import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Api, Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
let fixtureRoot: string;
let catalog: Record<string, Record<string, Model<Api>>>;

beforeAll(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "pi-zai-generation-"));
	const isolatedPackageRoot = join(fixtureRoot, "package");
	mkdirSync(isolatedPackageRoot);
	for (const entry of ["package.json", "scripts", "src"]) {
		cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
	}
	const referenceCosts = {
		"glm-4.6v": { input: 0.3, output: 0.9 },
		"glm-5.1": { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
		"glm-5v-turbo": { input: 1.2, output: 4, cache_read: 0.24, cache_write: 0 },
		"glm-5.2": { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
	};
	const codingModels = Object.fromEntries(
		[...Object.keys(referenceCosts), "glm-5.2-highspeed", "glm-5.3"].map((id) => [
			id,
			{
				id,
				name: id,
				tool_call: true,
				reasoning: true,
				modalities: { input: id === "glm-4.6v" ? ["text", "image"] : ["text"] },
				limit: { context: 128000, output: 32768 },
				cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
			},
		]),
	);
	const individualModelIds = [
		"deepseek-v4-flash-0731",
		"deepseek-v4-pro",
		"deepseek-v4-pro-0813",
		"glm-5.2",
		"qwen3.6-flash",
		"qwen3.7-max",
		"qwen3.7-plus",
		"qwen3.8-max",
	];
	const sourceCatalog = {
		zai: {
			models: Object.fromEntries(Object.entries(referenceCosts).map(([id, cost]) => [id, { id, name: id, cost }])),
		},
		"zai-coding-plan": { models: codingModels },
		"zhipuai-coding-plan": { models: codingModels },
		"alibaba-token-plan": {
			models: Object.fromEntries(individualModelIds.map((id) => [id, { id, name: id, tool_call: true }])),
		},
	};
	const preloadPath = join(fixtureRoot, "mock-catalogs.mjs");
	writeFileSync(
		preloadPath,
		`const catalog = ${JSON.stringify(sourceCatalog)};\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  const url = String(input);\n` +
			`  if (url === "https://models.dev/api.json") return Response.json(catalog);\n` +
			`  if (url === "https://openrouter.ai/api/v1/models" || url === "https://ai-gateway.vercel.sh/v1/models") {\n` +
			`    return Response.json({ data: [] });\n` +
			`  }\n` +
			`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
			`};\n`,
	);
	const outputDir = join(fixtureRoot, "catalog");
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preloadPath).href,
			"scripts/generate-models.ts",
			"--strict",
			"--json-only",
			"--json-output",
			outputDir,
		],
		{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 },
	);
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	catalog = JSON.parse(readFileSync(join(outputDir, "models.json"), "utf8"));
}, 15_000);

afterAll(() => rmSync(fixtureRoot, { force: true, recursive: true }));

it("preserves vision model metadata on the China Coding Plan catalog", () => {
	const model = catalog["zai-coding-cn"]["glm-4.6v"];

	expect(model).toMatchObject({
		id: "glm-4.6v",
		provider: "zai-coding-cn",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32768,
		compat: {
			maxTokensField: "max_tokens",
			thinkingFormat: "zai",
			zaiToolStream: true,
		},
	});
});

it("uses API-equivalent reference costs for Coding Plan models", () => {
	for (const provider of ["zai", "zai-coding-cn"]) {
		for (const id of ["glm-5.1", "glm-5.2"]) {
			expect(catalog[provider][id].cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
		}
		expect(catalog[provider]["glm-5v-turbo"].cost).toEqual({ input: 1.2, output: 4, cacheRead: 0.24, cacheWrite: 0 });
	}
});

it("keeps zero costs for Coding Plan models without a matching API price", () => {
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	for (const provider of ["zai", "zai-coding-cn"]) {
		expect(catalog[provider]["glm-5.2-highspeed"].cost).toEqual(zeroCost);
		expect(catalog[provider]["glm-5.3"].cost).toEqual(zeroCost);
	}
});
