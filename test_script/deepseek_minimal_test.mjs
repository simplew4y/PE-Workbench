// node test_script/deepseek_minimal_test.mjs
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

try {
	const envPath = "/Users/Admin/project/PE-Workbench/apps/web/.env.local";
	const env = { ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {}), ...process.env };
	const keyName = env.DEEPSEEK_API_KEY ? "DEEPSEEK_API_KEY" : "PE_INGEST_LLM_API_KEY";
	const apiKey = env[keyName]?.trim();
	const model = env.DEEPSEEK_MODEL || env.PE_INGEST_LLM_MODEL || "deepseek-chat";
	const baseURL = env.DEEPSEEK_BASE_URL || env.PE_INGEST_LLM_BASE_URL || "https://api.deepseek.com";
	if (!apiKey) throw new Error(`未配置 ${keyName}`);
	const url = new URL(`${baseURL.replace(/\/$/, "")}/chat/completions`);
	console.log(`接口：${url.origin}${url.pathname}`);
	console.log(`模型：${model}`);
	console.log(`密钥来源：${Object.hasOwn(process.env, keyName) ? "process.env" : envPath} → ${keyName}`);
	const response = await fetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: ok" }],
			thinking: { type: "disabled" }, max_tokens: 16, stream: false }),
		signal: AbortSignal.timeout(30_000),
	});
	console.log(`HTTP ${response.status}`);
	console.log((await response.text()).replaceAll(apiKey, "[REDACTED]").slice(0, 2000));
	if (!response.ok) process.exitCode = 1;
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
