import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { validateGeneratedModelData } from "../scripts/model-data.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["cn", "legacy", "both", "global-only"])("hydrates a clean checkout using %s catalog", (variant) => {
	const root = mkdtempSync(join(tmpdir(), "pi-kimi-hydration-"));
	roots.push(root);
	for (const entry of ["scripts", "src/api/cloudflare.ts", "src/providers/kimi-coding.models.ts"]) {
		mkdirSync(join(root, entry, ".."), { recursive: true });
		cpSync(join(packageRoot, entry), join(root, entry), { recursive: true });
	}
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	writeFileSync(
		join(root, "src/models.generated.ts"),
		'import { KIMI_CODING_MODELS } from "./providers/kimi-coding.models.ts";\n',
	);
	const model = {
		id: "kimi-for-coding",
		name: "Kimi",
		tool_call: true,
		reasoning: true,
		limit: { context: 1048576, output: 32768 },
		modalities: { input: ["text", "image"] },
		reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
	};
	const catalog = {
		...(variant === "cn" || variant === "both"
			? {
					"kimi-code-plan-cn": {
						models: {
							"kimi-for-coding": model,
							k2p7: { ...model, id: "k2p7" },
							"no-tools": { ...model, id: "no-tools", tool_call: false },
						},
					},
				}
			: {}),
		...(variant === "legacy" || variant === "both"
			? {
					"kimi-for-coding": {
						models: { "kimi-for-coding": { ...model, limit: { context: 262144, output: 32768 } } },
					},
				}
			: {}),
		"kimi-code-plan-global": { models: { "global-only": { ...model, id: "global-only" } } },
		"alibaba-token-plan": {
			models: Object.fromEntries(
				[
					"deepseek-v4-flash-0731",
					"deepseek-v4-pro",
					"deepseek-v4-pro-0813",
					"glm-5.2",
					"qwen3.6-flash",
					"qwen3.7-max",
					"qwen3.7-plus",
					"qwen3.8-max",
				].map((id) => [id, { id, name: id, tool_call: true }]),
			),
		},
	};
	const preload = join(root, "fetch.mjs");
	writeFileSync(
		preload,
		`const catalog = ${JSON.stringify(catalog)};
globalThis.fetch = async (url) => {
  if (String(url) === "https://models.dev/api.json") return Response.json(catalog);
  if (["https://openrouter.ai/api/v1/models", "https://ai-gateway.vercel.sh/v1/models"].includes(String(url))) return Response.json({ data: [] });
  throw new Error("Unexpected fetch: " + url);
};`,
	);
	expect(existsSync(join(root, "src/providers/data"))).toBe(false);
	const result = spawnSync(
		process.execPath,
		["--import", pathToFileURL(preload).href, "scripts/generate-models.ts", "--strict", "--data-only"],
		{ cwd: root, encoding: "utf8", timeout: 10000 },
	);
	if (variant === "global-only") {
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Cannot hydrate missing providers: kimi-coding");
		expect(existsSync(join(root, "src/providers/data"))).toBe(false);
		return;
	}
	expect(result.status, result.stdout + result.stderr).toBe(0);
	validateGeneratedModelData(root);
	const values = JSON.parse(readFileSync(join(root, "src/providers/data/kimi-coding.json"), "utf8"));
	expect(Object.keys(values["anthropic-messages"])).toEqual(["kimi-for-coding"]);
	expect(values["anthropic-messages"]["kimi-for-coding"]).toMatchObject({
		provider: "kimi-coding",
		api: "anthropic-messages",
		baseUrl: "https://api.kimi.com/coding",
		contextWindow: variant === "legacy" ? 262144 : 1048576,
		input: ["text", "image"],
		compat: { allowEmptySignature: true, forceAdaptiveThinking: true },
		thinkingLevelMap: { low: "low", high: "high", max: "max" },
	});
});
