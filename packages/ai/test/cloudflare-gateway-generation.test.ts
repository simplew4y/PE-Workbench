import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL, CLOUDFLARE_WORKERS_AI_BASE_URL } from "../src/api/cloudflare.ts";
import type { Api, Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];
const workerId = "@cf/moonshotai/kimi-k2.6";
const gatewayId = `workers-ai/${workerId}`;
const workerModel = {
	id: workerId,
	name: "Workers model",
	tool_call: true,
	reasoning: true,
	modalities: { input: ["text", "image"] },
	cost: { input: 0.6, output: 2.5, cache_read: 0.15, cache_write: 0.2 },
	limit: { context: 262144, output: 32768 },
};

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function generateCatalog(gatewayModels?: Record<string, unknown>): Record<string, Record<string, Model<Api>>> {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-cloudflare-generation-"));
	temporaryRoots.push(fixtureRoot);
	const isolatedPackageRoot = join(fixtureRoot, "package");
	mkdirSync(isolatedPackageRoot);
	for (const entry of ["package.json", "scripts", "src"]) {
		cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
	}
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
	const catalog = {
		"alibaba-token-plan": {
			models: Object.fromEntries(individualModelIds.map((id) => [id, { id, name: id, tool_call: true }])),
		},
		"cloudflare-workers-ai": {
			models: {
				[workerId]: workerModel,
				"@cf/test/text-model": { id: "@cf/test/text-model", name: "Text model", tool_call: true },
				"@cf/test/no-tools": { id: "@cf/test/no-tools", name: "No tools", tool_call: false },
				"@cf/test/unknown-tools": { id: "@cf/test/unknown-tools", name: "Unknown tools" },
			},
		},
		...(gatewayModels === undefined ? {} : { "cloudflare-ai-gateway": { models: gatewayModels } }),
	};
	const preloadPath = join(fixtureRoot, "mock-catalogs.mjs");
	writeFileSync(
		preloadPath,
		`const catalog = ${JSON.stringify(catalog)};\n` +
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
	return JSON.parse(readFileSync(join(outputDir, "models.json"), "utf8"));
}

describe("Cloudflare AI Gateway model generation", () => {
	it.each(["absent", "empty", "partial"] as const)(
		"includes tool-capable Workers AI models when the gateway catalog is %s",
		(state) => {
			const gatewayModels =
				state === "absent"
					? undefined
					: state === "empty"
						? {}
						: { "openai/gpt-4o": { id: "openai/gpt-4o", name: "GPT-4o", tool_call: true } };
			const catalog = generateCatalog(gatewayModels);
			const gateway = catalog["cloudflare-ai-gateway"];
			expect(gateway?.[gatewayId]).toMatchObject({
				id: gatewayId,
				name: workerModel.name,
				provider: "cloudflare-ai-gateway",
				api: "openai-completions",
				baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 262144,
				maxTokens: 32768,
				cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0.2 },
				compat: {
					sendSessionAffinityHeaders: true,
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
					maxTokensField: "max_tokens",
				},
			});
			expect(gateway["workers-ai/@cf/test/text-model"]).toMatchObject({ input: ["text"], reasoning: false });
			expect(gateway["workers-ai/@cf/test/no-tools"]).toBeUndefined();
			expect(gateway["workers-ai/@cf/test/unknown-tools"]).toBeUndefined();
			expect(catalog["cloudflare-workers-ai"][workerId]).toMatchObject({
				id: workerId,
				provider: "cloudflare-workers-ai",
				baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
			});
			if (state === "partial") expect(gateway["gpt-4o"]).toMatchObject({ api: "openai-responses" });
		},
	);

	it("preserves gateway-specific metadata without duplicating Workers AI entries", () => {
		const catalog = generateCatalog({
			[gatewayId]: {
				...workerModel,
				id: gatewayId,
				name: "Gateway override",
				limit: { context: 65536, output: 8192 },
			},
		});
		const gateway = catalog["cloudflare-ai-gateway"];
		expect(gateway[gatewayId]).toMatchObject({ name: "Gateway override", contextWindow: 65536, maxTokens: 8192 });
		expect(Object.keys(gateway).filter((id) => id === gatewayId)).toHaveLength(1);
		expect(catalog["cloudflare-workers-ai"][workerId].contextWindow).toBe(262144);
	});

	it("does not override an explicit gateway tool-support restriction", () => {
		const catalog = generateCatalog({ [gatewayId]: { ...workerModel, id: gatewayId, tool_call: false } });
		expect(catalog["cloudflare-ai-gateway"][gatewayId]).toBeUndefined();
		expect(catalog["cloudflare-workers-ai"][workerId]).toBeDefined();
	});
});
