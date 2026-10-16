import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectMaterials, pipelineConfiguration, runProjectPipeline } from "../../../../test_script/hermes_framework_pipeline.mjs";

export function frameworkPipelineStatus(env = process.env) {
  try { return { available: true, modelId: pipelineConfiguration(env).model, reason: null }; }
  catch (error) { return { available: false, modelId: null, reason: error.message }; }
}

// The JSON retains the structured document interface; the script's prose is the displayed report.
export function createFrameworkPipelineEngine(cwd, datasetId, config, dependencies = {}) {
  return { async generate(input, basis, signal, progress) {
    const materials = await loadProjectMaterials({ project: cwd, datasetId, company: config.company?.name, ticker: config.company?.ticker, signal,
      docIds: input.inputs.map(document => document.docId) });
    if (JSON.stringify(materials.baseline.content) !== JSON.stringify(basis)) throw new Error("框架已变化，请重新更新");
    const directory = join(cwd, "generated", "framework-pipeline");
    mkdirSync(directory, { recursive: true });
    const output = mkdtempSync(join(directory, `${materials.asOf}-`));
    progress?.("正在读取当前空间资料、规划 Wind 查询并生成新版框架。");
    await runProjectPipeline({ materials, output, signal, ...dependencies });
    signal.throwIfAborted();
    const result = JSON.parse(readFileSync(join(output, "framework.json"), "utf8"));
    progress?.("新版框架已生成。");
    // The application supplies storage metadata; the model's answer is preserved verbatim.
    return {
      schemaVersion: 2, title: result.title, reportMarkdown: readFileSync(join(output, "framework.md"), "utf8"),
      sections: {
        researchSetup: { objective: config.objective, horizon: "见框架正文", preferences: null, informationCutoff: materials.asOf },
        currentAssessment: { summary: "本轮总结与判断见框架正文。", status: "已更新", returnDrivers: [], keyUncertainties: [], changesSinceLastVersion: "详见本轮框架正文。", evidenceIds: [] },
        businessModel: { summary: "见框架正文。", evidenceIds: [], drivers: [], kpis: [] },
        investmentJudgments: { items: [] },
        valuation: { summary: "见框架正文。", marketExpectations: "见框架正文。", evidenceIds: [], forecastComparisons: [], scenarios: [], catalysts: [] },
        monitoring: { rules: [] },
        evidenceAndChanges: { sources: [], openQuestions: [], coverageGaps: [], changes: [] },
      },
    };
  } };
}
