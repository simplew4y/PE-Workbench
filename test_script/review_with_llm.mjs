import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import OpenAI from "openai";

export function validateAssessment(result, payload) {
	const expected = new Set(payload.assumption_mapping.map((item) => item.assumption_id));
	const evidence = new Map(payload.wind_evidence.evidence.map((item) => [item.id, item]));
	const seen = new Set();
	const statuses = new Set(["supported", "challenged", "invalidated", "insufficient_evidence"]);
	if (!result.summary || !statuses.has(result.overall_status) || !Array.isArray(result.assessments))
		throw new Error("LLM 未返回有效的框架评估结构");
	for (const item of result.assessments) {
		if (!expected.has(item.assumption_id) || seen.has(item.assumption_id) || !statuses.has(item.status))
			throw new Error("LLM 假设编号缺失、重复或状态无效");
		seen.add(item.assumption_id);
		if (!Array.isArray(item.evidence_ids) || !item.model_action || !Array.isArray(item.missing_data) ||
			!Array.isArray(item.alternative_explanations) || typeof item.comparison !== "string" || typeof item.model_action.reason !== "string")
			throw new Error("LLM 评估缺少证据、模型动作或数据缺口");
		for (const id of item.evidence_ids) {
			const fact = evidence.get(id);
			if (!fact || fact.excluded_from_assessment) throw new Error(`LLM 引用了不存在或已排除的证据：${id}`);
		}
		const mapping = payload.assumption_mapping.find((entry) => entry.assumption_id === item.assumption_id);
		const cells = new Set(mapping.model_inputs.map((entry) => entry.editable_cell));
		if (!Array.isArray(item.model_action.input_cells) || !item.model_action.input_cells.length || item.model_action.input_cells.some((cell) => !cells.has(cell)))
			throw new Error(`LLM 建议了未核验的模型输入：${item.assumption_id}`);
		const comparable = item.comparability;
		const comparisonKeys = ["period_match", "currency_unit_match", "metric_scope_match", "baseline_restatement"];
		if (!comparable || !comparisonKeys.every((key) => Object.hasOwn(comparable, key)))
			throw new Error(`LLM 未明确证据可比性：${item.assumption_id}`);
		for (const key of comparisonKeys) {
			if (comparable[key] === null || typeof comparable[key] === "boolean") continue;
			// "CNY"等文本不代表可比性为true；降为未知并保留原值，不改变LLM的结论。
			result.validation_warnings ??= [];
			result.validation_warnings.push({ assumption_id: item.assumption_id, field: `comparability.${key}`,
				original_value: comparable[key], normalized_value: null, reason: "非布尔可比性字段按未确认处理；原始响应保持不变" });
			comparable[key] = null;
		}
		const comparableValue = item.evidence_ids.some((id) => {
			const fact = evidence.get(id);
			return typeof fact.value === "number" && !fact.flags.some((flag) =>
				["single_vs_cumulative_unknown", "unit_or_scale_unconfirmed", "accounting_currency_unconfirmed"].includes(flag));
		});
		if (item.status !== "insufficient_evidence" && (!comparableValue || comparable.period_match !== true ||
			comparable.currency_unit_match !== true || comparable.metric_scope_match !== true || comparable.baseline_restatement !== false))
			throw new Error(`LLM 用不可比或旧基线证据判定了假设成立/失效：${item.assumption_id}`);
		if (!["retain", "replace_actuals_only", "revise_forecast", "request_data"].includes(item.model_action.action))
			throw new Error("LLM 返回了无效的模型动作");
		if (item.model_action.new_value !== null) {
			const usable = item.evidence_ids.some((id) => {
				const fact = evidence.get(id);
				return typeof fact.value === "number" && !fact.flags.some((flag) =>
					["single_vs_cumulative_unknown", "unit_or_scale_unconfirmed", "accounting_currency_unconfirmed"].includes(flag));
			});
			if (!usable) throw new Error("LLM 缺少口径已核验的数值证据却建议了新数值");
		}
	}
	if (seen.size !== expected.size) throw new Error("LLM 未覆盖全部关键假设");
	if (!Array.isArray(result.thesis_assessments) || !Array.isArray(result.priority_followups) || !Array.isArray(result.limitations))
		throw new Error("LLM 缺少逻辑复核、补查或限制字段");
	if (result.valuation_attribution?.can_explain_new_valuation_change !== false)
		throw new Error("本轮缺少可比的新估值，不能断言估值变化归因");
	return result;
}

export function renderAssessment(result) {
	const lines = [result.summary, `整体状态：${result.overall_status}`];
	for (const item of result.assessments) {
		lines.push("", `${item.assumption_id}：${item.status}`, item.comparison, `信息性质：${item.new_information}`,
			`可比性：${JSON.stringify(item.comparability)}`,
			`证据：${item.evidence_ids.join("、") || "无可用证据"}`,
			`模型动作：${item.model_action.action}；${item.model_action.input_cells.join("、")}`,
			`建议新值：${JSON.stringify(item.model_action.new_value)}；${item.model_action.reason}`,
			`其他解释：${item.alternative_explanations.join("；")}`, `缺少数据：${item.missing_data.join("；")}`);
	}
	lines.push("", "投资逻辑复核");
	for (const item of result.thesis_assessments) lines.push(`${item.thesis_id}：${item.status}；${item.reason}`);
	lines.push("", "优先补查");
	for (const item of result.priority_followups)
		lines.push(`${item.assumption_ids.join("、")}；${item.periods.join("、")}；${item.fields.join("、")}；${item.reason}`);
	lines.push("", `估值归因：${result.valuation_attribution.reason}`, "", ...result.limitations);
	for (const note of result.validation_warnings ?? [])
		lines.push(`结构化注记：${note.assumption_id} ${note.field} 原值${JSON.stringify(note.original_value)}按未确认处理。`);
	return `${lines.join("\n")}\n`;
}

export async function runAssessment(directory, repairExisting = false) {
	const input = JSON.parse(readFileSync(resolve(directory, "llm-input.json"), "utf8"));
	const payload = JSON.parse(input.messages.find((message) => message.role === "user").content);
	const envFile = resolve(fileURLToPath(new URL("../apps/web/.env.local", import.meta.url)));
	const config = { ...parseEnv(readFileSync(envFile, "utf8")), ...process.env };
	const model = config.PE_INGEST_LLM_MODEL?.trim();
	const apiKey = config.PE_INGEST_LLM_API_KEY?.trim();
	const baseURL = config.PE_INGEST_LLM_BASE_URL?.trim();
	if (!model || !apiKey || !baseURL) throw new Error("未配置完整的服务端 LLM");
	const extra = JSON.parse(config.PE_INGEST_LLM_EXTRA_BODY || "{}");
	const client = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 240000 });
	const startedAt = new Date().toISOString();
	const request = { ...extra, model, messages: input.messages, response_format: { type: "json_object" }, max_tokens: 8192, stream: false };
	// 请求中没有凭据，保存实际模型参数，便于复现这次判断。
	let response;
	if (repairExisting) {
		response = JSON.parse(readFileSync(resolve(directory, "llm-response.json"), "utf8"));
		for (const suffix of ["result.json", "result.txt", "run.json"])
			if (existsSync(resolve(directory, `llm-${suffix}`)) && !existsSync(resolve(directory, `llm-initial-${suffix}`)))
				copyFileSync(resolve(directory, `llm-${suffix}`), resolve(directory, `llm-initial-${suffix}`));
	} else {
		writeFileSync(resolve(directory, "llm-request.json"), `${JSON.stringify(request, null, 2)}\n`, { flag: "wx" });
		console.error(`正在调用已配置模型：${model}`);
		response = await client.chat.completions.create(request);
		writeFileSync(resolve(directory, "llm-response.json"), `${JSON.stringify(response, null, 2)}\n`, { flag: "wx" });
	}
	const initialResponse = response;
	let result;
	let repaired = repairExisting && existsSync(resolve(directory, "llm-repair-response.json"));
	if (repaired) response = JSON.parse(readFileSync(resolve(directory, "llm-repair-response.json"), "utf8"));
	try {
		if (response.choices[0]?.finish_reason !== "stop") throw new Error("LLM 初始输出不完整");
		result = validateAssessment(JSON.parse(response.choices[0].message.content), payload);
	} catch (error) {
		if (repaired) throw error;
		const initial = JSON.parse(response.choices[0]?.message?.content || "{}");
		const repairPayload = {
			context: payload.original_framework.context,
			original_metrics: payload.original_framework.metrics,
			original_theses: payload.original_framework.theses,
			assumption_mapping: payload.assumption_mapping.map((item) => ({ assumption_id: item.assumption_id,
				key_assumption: item.key_assumption, baseline: item.baseline,
				model_inputs: item.model_inputs.map((entry) => ({ period: entry.period, editable_cell: entry.editable_cell, value: entry.value })),
				sensitivities: item.sensitivities })),
			wind_evidence: payload.wind_evidence.evidence.filter((fact) => !fact.observation_date || fact.raw_locator.table === 2 ||
				fact.raw_locator.row === 1 || fact.observation_date.endsWith("06-30") || fact.raw_locator.row === 100),
			initial_assessment: initial,
			validation_error: error.message,
			corrections: ["H1旧值不能证明H2预测成立；A6/A7/A8/A14即便retain也应insufficient_evidence。",
				"0.90是汇率情景参数；方向/时点/用途未核验，A19应insufficient_evidence，不能仅因现汇不同判challenged。",
				"不要称累计和币种待核验的数据为同口径；不要引用已排除的Q4/未来值。",
				"每项必须填写comparability对象，字段period_match/currency_unit_match/metric_scope_match/baseline_restatement为true/false/null，另有notes。",
				"每项model_action.input_cells至少填写本条model_inputs中一个editable_cell；保留全部19项及原要求输出结构。"],
		};
		const repairRequest = { ...request, messages: [input.messages[0], { role: "user", content:
			`请根据以下定向复核意见修正先前评估。只使用这些列示证据，输出完整19项JSON而非补丁。\n${JSON.stringify(repairPayload)}` }] };
		writeFileSync(resolve(directory, "llm-repair-request.json"), `${JSON.stringify(repairRequest, null, 2)}\n`, { flag: "wx" });
		writeFileSync(resolve(directory, "llm-validation.json"), `${JSON.stringify({ initialAccepted: false, reason: error.message }, null, 2)}\n`, { flag: "wx" });
		console.error(`正在定向修正模型评估：${model}`);
		response = await client.chat.completions.create(repairRequest);
		writeFileSync(resolve(directory, "llm-repair-response.json"), `${JSON.stringify(response, null, 2)}\n`, { flag: "wx" });
		if (response.choices[0]?.finish_reason !== "stop") throw new Error("LLM 修正输出不完整");
		result = validateAssessment(JSON.parse(response.choices[0].message.content), payload);
		repaired = true;
	}
	writeFileSync(resolve(directory, "llm-result.json"), `${JSON.stringify(result, null, 2)}\n`);
	const text = renderAssessment(result);
	writeFileSync(resolve(directory, "llm-result.txt"), text);
	writeFileSync(resolve(directory, "llm-run.json"), `${JSON.stringify({ model, startedAt, finishedAt: new Date().toISOString(),
		responseId: response.id, finishReason: response.choices[0].finish_reason, usage: response.usage,
		initialUsage: initialResponse.usage, calls: repaired ? 2 : 1, repaired, status: "validated" }, null, 2)}\n`);
	process.stdout.write(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.length < 3 || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== "--repair-existing"))
			throw new Error("Usage: node review_with_llm.mjs <prepared-output-directory> [--repair-existing]");
		await runAssessment(resolve(process.argv[2]), process.argv[3] === "--repair-existing");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
