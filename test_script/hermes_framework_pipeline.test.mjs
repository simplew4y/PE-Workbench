import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadHermesMaterials, runHermesPipeline, validatePlan } from "./hermes_framework_pipeline.mjs";

function framework() {
	return { schemaVersion: 2, title: "Hermès 投资框架", sections: {
		researchSetup: { objective: "检验增长", markdown: "研究对象为爱马仕，关注增长能否转化为股东回报。" },
		currentAssessment: { summary: "本轮新总结", status: "本轮新判断", evidenceIds: ["W5 F"],
			markdown: "### 当前结论\n\n本轮新判断。\n\n### 核心依据\n\n本轮新总结。收入增长需要同时观察利润率和现金流。\n\n### 改判条件\n\n后续财报检验盈利能否兑现。" },
		businessModel: { markdown: "客户愿意为稀缺产品付费，新增产能经销量传导至收入与现金流。" },
		investmentJudgments: { items: [], markdown: "关键判断是销量增长的持续性，反面解释是需求走弱。" },
		valuation: { markdown: "保留历史模型结果，当前价格是否有吸引力取决于盈利路径。" },
		monitoring: { rules: [], markdown: "下次财报跟踪收入与现金流，检验核心假设。" },
		evidenceAndChanges: { changes: [], coverageGaps: ["来源口径待确认"], markdown: "来源：公司半年报。尚需确认部分数据口径。" },
	} };
}
const materials = { company: "Hermès International", asOf: "2026-10-16", baseline: { versionId: "v7", content: { title: "旧框架" } }, documents: [{ id: "L1", content: "公司资料" }] };
const plan = { queries: [{ category: "financials", query: "Hermès RMS.PA 营业收入" }] };
const response = (content) => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }], usage: { total_tokens: 12 } });

test("only validates the fields required to send a Wind query", () => {
	assert.equal(validatePlan(plan), plan);
	assert.throws(() => validatePlan({ queries: [{ category: "shell", query: "x" }] }), /Wind/);
	assert.throws(() => validatePlan({ queries: [{ category: "quote", query: "RMS.PA 最新股价" }] }), /证券代码/);
});

test("loads the current Hermes framework and explicit supporting files", async () => {
	const input = await loadHermesMaterials();
	assert.ok(input.baseline.versionId);
	assert.ok(input.documents.some((document) => document.path.endsWith("H1-2026.txt") && document.content.length > 1000));
});

test("prepare-only invokes neither paid service", async () => {
	const output = mkdtempSync(join(tmpdir(), "hermes-prepare-"));
	try {
		await runHermesPipeline({ output, materials, prepareOnly: true,
			complete: async () => { throw new Error("unexpected LLM call"); },
			windFetcher: async () => { throw new Error("unexpected Wind call"); },
		});
		assert.equal(JSON.parse(readFileSync(join(output, "run.json"), "utf8")).status, "prepared");
	} finally { rmSync(output, { recursive: true, force: true }); }
});

test("project company parameters replace Hermes in both prompts", async () => {
	const output = mkdtempSync(join(tmpdir(), "project-pipeline-"));
	try {
		await runHermesPipeline({ output, materials: { ...materials, company: "测试银行", ticker: "600000.SH" }, model: "deepseek-test",
			complete: async (stage, messages) => {
				assert.doesNotMatch(messages[0].content, /公司固定为Hermès|评价Hermès|证券RMS.PA/);
				if (stage === "plan") assert.match(messages[0].content, /测试银行.*600000.SH/);
				return response(stage === "plan" ? plan : framework());
			}, windFetcher: async () => ({ content: [{ type: "text", text: "公司披露" }] }),
		});
		assert.doesNotMatch(readFileSync(join(output, "summary.md"), "utf8"), /Hermès 投资观点/);
	} finally { rmSync(output, { recursive: true, force: true }); }
});

test("uses exactly two LLM calls and saves generated references even when Wind failed", async () => {
	const output = mkdtempSync(join(tmpdir(), "hermes-two-calls-"));
	const stages = [];
	try {
		await runHermesPipeline({ output, materials, model: "deepseek-test",
			complete: async (stage, messages) => {
				stages.push(stage);
				for (const path of ["investment-framework-builder/SKILL.md", "investment-framework-builder/references/report.md",
					"independent-investment-case/SKILL.md", "expectations-valuation/SKILL.md", "falsification-monitoring/SKILL.md"]) {
					const skill = readFileSync(new URL(`../packages/pe-boot/skills/${path}`, import.meta.url), "utf8");
					assert.ok(messages[0].content.includes(skill), `Missing skill body in actual LLM input: ${path}`);
				}
				const payload = JSON.parse(messages[1].content);
				assert.equal(Object.hasOwn(payload, "allowedEvidenceIds"), false);
				if (stage === "revision") assert.equal(payload.wind[0].status, "failed");
				return response(stage === "plan" ? { queries: [{ ...plan.queries[0], id: "overridden" }] } : framework());
			}, windFetcher: async () => { throw new Error("WIND_HTTP_403"); },
		});
		assert.deepEqual(stages, ["plan", "revision"]);
		const saved = JSON.parse(readFileSync(join(output, "framework.json"), "utf8"));
		assert.equal(saved.reportMarkdown, JSON.stringify(framework()));
		assert.match(readFileSync(join(output, "summary.md"), "utf8"), /本轮新总结/);
		assert.match(readFileSync(join(output, "summary.md"), "utf8"), /本轮新判断/);
		const report = readFileSync(join(output, "framework.md"), "utf8");
		assert.equal(report, JSON.stringify(framework()));
		assert.match(report, /客户愿意为稀缺产品付费/);
		assert.match(report, /W5 F/);
		assert.ok(existsSync(join(output, "wind-W1.json")));
		assert.equal(JSON.parse(readFileSync(join(output, "run.json"), "utf8")).status, "completed");
	} finally { rmSync(output, { recursive: true, force: true }); }
});

test("free prose, incomplete fields and malformed JSON are saved verbatim without a repair call", async () => {
	for (const content of ["# 新版框架\n\n自由生成的投资判断。", '{"sections":{"currentAssessment":{"summary":"已有判断但无markdown"}}}', "{broken"]) {
	const output = mkdtempSync(join(tmpdir(), "hermes-invalid-json-"));
	let calls = 0;
	try {
		await runHermesPipeline({ output, materials, model: "deepseek-test",
			complete: async (stage, _messages, options) => {
				calls++;
				assert.equal(options.response_format?.type, stage === "plan" ? "json_object" : undefined);
				return stage === "plan" ? response(plan) : { choices: [{ message: { content } }] };
			},
			windFetcher: async () => ({ content: [{ type: "text", text: "Wind原文" }] }),
		});
		assert.equal(calls, 2);
		assert.equal(existsSync(join(output, "revision-2-request.json")), false);
		assert.equal(readFileSync(join(output, "framework.md"), "utf8"), content);
		assert.equal(JSON.parse(readFileSync(join(output, "framework.json"), "utf8")).reportMarkdown, content);
		assert.equal(JSON.parse(readFileSync(join(output, "run.json"), "utf8")).status, "completed");
	} finally { rmSync(output, { recursive: true, force: true }); }
	}
});

test("resume reuses Wind and makes one generation call, ignoring old analysis validation", async () => {
	const output = mkdtempSync(join(tmpdir(), "hermes-resume-one-call-"));
	try {
		await assert.rejects(runHermesPipeline({ output, materials, model: "deepseek-test",
			complete: async (stage) => { if (stage !== "plan") throw new Error("connection interrupted"); return response(plan); },
			windFetcher: async () => ({ content: [{ type: "text", text: "已取得原文" }] }),
		}), /connection interrupted/);
		const first = readFileSync(join(output, "revision-1-request.json"), "utf8");
		writeFileSync(join(output, "analysis.json"), "{old-incomplete-analysis");
		let calls = 0;
		await runHermesPipeline({ output, materials, model: "deepseek-test", resume: true,
			complete: async (stage) => { calls++; assert.equal(stage, "revision"); return response(framework()); },
			windFetcher: async () => { throw new Error("repeated Wind call"); },
		});
		assert.equal(calls, 1);
		assert.equal(readFileSync(join(output, "revision-1-request.json"), "utf8"), first);
		assert.equal(readFileSync(join(output, "analysis.json"), "utf8"), "{old-incomplete-analysis");
		assert.equal(JSON.parse(readFileSync(join(output, "run.json"), "utf8")).status, "completed");
	} finally { rmSync(output, { recursive: true, force: true }); }
});
