import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { resolvePeEvidenceRecord } from "../evidence.ts";
import {
	assertInformationSourceConfig,
	type InformationCollection,
	type InformationFact,
	type InformationSourceConfig,
	informationCurrencyCode,
	informationDisplayText,
	informationSourceConfig,
} from "../information-source-model.ts";
import { readInformationView } from "../information-source-store.ts";
import { parseSourceId } from "../source.ts";
import { readWindSnapshot } from "../trusted-sources.ts";
import { validateAutomaticSetup } from "./automatic-setup.ts";
import {
	captureResearchInputs,
	currentResearchVersion,
	getResearchFramework,
	insertResearchDraft,
	publishResearchDraftAsync,
	validateResearchEvidence,
} from "./framework.ts";
import { equivalentComparisonPeriod } from "./iteration-impact.ts";
import {
	type FrameworkIteration,
	type IterationArtifact,
	type IterationEngine,
	type IterationImpacts,
	type IterationObservations,
	type IterationStage,
	type IterationStatus,
	validateIterationImpacts,
	validateIterationObservations,
} from "./iteration-model.ts";
import {
	freezeIterationModelBaseline,
	getIterationModelConfig,
	saveIterationModelConfig,
} from "./iteration-model-update.ts";
import {
	observationReviewReasons,
	quoteContainsNumber,
	synchronizeIterationScope,
	validateLinkedObservationText,
	validateObservationContext,
} from "./iteration-quality.ts";
import { type FrameworkContent, isFrameworkDocument, ResearchError, validateFrameworkContent } from "./model.ts";
import { researchTransaction, withResearchDatabase } from "./storage.ts";
import { shanghaiToday, trackingPeriods } from "./tracking-periods.ts";

export * from "./iteration-model.ts";
export const ITERATION_PROCESSOR_VERSION = "2";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS framework_iteration_settings(dataset_id TEXT PRIMARY KEY, test_project INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS framework_iterations(
 id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, request_id TEXT NOT NULL, request_json TEXT NOT NULL,
 status TEXT NOT NULL, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, record_json TEXT NOT NULL,
 UNIQUE(dataset_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS framework_iteration_active ON framework_iterations(dataset_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS framework_iteration_artifacts(
 run_id TEXT NOT NULL REFERENCES framework_iterations(id), stage TEXT NOT NULL, artifact_json TEXT NOT NULL,
 PRIMARY KEY(run_id,stage)
);
CREATE TRIGGER IF NOT EXISTS framework_iteration_artifacts_immutable BEFORE UPDATE ON framework_iteration_artifacts BEGIN SELECT RAISE(ABORT,'Iteration artifacts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS framework_iteration_artifacts_no_delete BEFORE DELETE ON framework_iteration_artifacts BEGIN SELECT RAISE(ABORT,'Iteration artifacts are immutable'); END;
CREATE TABLE IF NOT EXISTS framework_iteration_artifact_attempts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,stage TEXT NOT NULL,artifact_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS framework_iteration_invalid_artifacts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,artifact_json TEXT NOT NULL,reason TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS framework_iteration_artifact_attempts_no_update BEFORE UPDATE ON framework_iteration_artifact_attempts BEGIN SELECT RAISE(ABORT,'Iteration artifacts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS framework_iteration_artifact_attempts_no_delete BEFORE DELETE ON framework_iteration_artifact_attempts BEGIN SELECT RAISE(ABORT,'Iteration artifacts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS framework_iteration_invalid_artifacts_no_update BEFORE UPDATE ON framework_iteration_invalid_artifacts BEGIN SELECT RAISE(ABORT,'Iteration invalidations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS framework_iteration_invalid_artifacts_no_delete BEFORE DELETE ON framework_iteration_invalid_artifacts BEGIN SELECT RAISE(ABORT,'Iteration invalidations are immutable'); END;
CREATE TABLE IF NOT EXISTS framework_iteration_attempts(
 run_id TEXT NOT NULL, token TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT, PRIMARY KEY(run_id,token)
);
CREATE TABLE IF NOT EXISTS framework_iteration_usage(run_id TEXT NOT NULL, usage_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS framework_iteration_diagnostics(run_id TEXT NOT NULL, diagnostic_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS framework_iteration_stage_attempts(
 id TEXT PRIMARY KEY,run_id TEXT NOT NULL,stage TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,status TEXT
);`;
function database<T>(cwd: string, datasetId: string, action: (db: DatabaseSync) => T): T {
	return withResearchDatabase(cwd, datasetId, (db) => {
		db.exec(SCHEMA);
		return action(db);
	});
}
function load(db: DatabaseSync, datasetId: string, id: string): FrameworkIteration {
	const row = db.prepare("SELECT * FROM framework_iterations WHERE dataset_id=? AND id=?").get(datasetId, id);
	if (!row) throw new ResearchError(404, "Iteration not found");
	const run = JSON.parse(String(row.record_json)) as FrameworkIteration;
	run.status = row.status as IterationStatus;
	run.leaseToken = row.lease_token as string | null;
	run.leaseUntil = Number(row.lease_until);
	const invalid = db
		.prepare("SELECT artifact_json,reason FROM framework_iteration_invalid_artifacts WHERE run_id=? ORDER BY rowid")
		.all(id);
	run.invalidArtifacts = invalid.map((r) => ({
		...(JSON.parse(String(r.artifact_json)) as IterationArtifact),
		reason: String(r.reason),
	}));
	const invalidJson = new Set(invalid.map((r) => String(r.artifact_json)));
	const artifacts = db
		.prepare(
			"SELECT artifact_json FROM framework_iteration_artifacts WHERE run_id=? UNION ALL SELECT artifact_json FROM framework_iteration_artifact_attempts WHERE run_id=?",
		)
		.all(id, id)
		.filter((r) => !invalidJson.has(String(r.artifact_json)))
		.map((r) => JSON.parse(String(r.artifact_json)) as IterationArtifact)
		.sort((a, b) => a.at.localeCompare(b.at));
	run.artifacts = [...new Map(artifacts.map((a) => [a.stage, a])).values()];
	run.usage = db
		.prepare("SELECT usage_json FROM framework_iteration_usage WHERE run_id=? ORDER BY rowid")
		.all(id)
		.map((r) => JSON.parse(String(r.usage_json)));
	run.diagnostics = db
		.prepare("SELECT diagnostic_json FROM framework_iteration_diagnostics WHERE run_id=? ORDER BY rowid")
		.all(id)
		.map((r) => JSON.parse(String(r.diagnostic_json)));
	run.executionAttempts = db
		.prepare("SELECT started_at,finished_at,status FROM framework_iteration_attempts WHERE run_id=? ORDER BY rowid")
		.all(id)
		.map((row) => ({
			startedAt: String(row.started_at),
			finishedAt: row.finished_at as string | null,
			status: row.status as string | null,
		}));
	run.stageAttempts = db
		.prepare(
			"SELECT stage,started_at,finished_at,status FROM framework_iteration_stage_attempts WHERE run_id=? ORDER BY rowid",
		)
		.all(id)
		.map((row) => ({
			stage: String(row.stage),
			startedAt: String(row.started_at),
			finishedAt: row.finished_at as string | null,
			status: String(row.status),
		}));
	return run;
}
function save(db: DatabaseSync, run: FrameworkIteration): void {
	if (run.status === "running") run.leaseUntil = Date.now() + 60_000;
	run.updatedAt = new Date().toISOString();
	db.prepare(
		"UPDATE framework_iterations SET status=?,lease_token=?,lease_until=?,record_json=? WHERE id=? AND dataset_id=?",
	).run(run.status, run.leaseToken, run.leaseUntil, JSON.stringify({ ...run, artifacts: [] }), run.id, run.datasetId);
}
function reconcile(db: DatabaseSync, datasetId: string): void {
	for (const row of db
		.prepare("SELECT id FROM framework_iterations WHERE dataset_id=? AND status='running' AND lease_until<=?")
		.all(datasetId, Date.now())) {
		const run = load(db, datasetId, String(row.id));
		const receipt = db
			.prepare("SELECT version_id FROM research_versions WHERE dataset_id=? AND request_id=?")
			.get(datasetId, `iteration_${run.id}`);
		run.status = receipt ? "published" : "blocked";
		run.versionId = receipt ? String(receipt.version_id) : null;
		run.error = receipt ? null : "执行中断，请恢复任务。";
		run.leaseToken = null;
		run.leaseUntil = 0;
		save(db, run);
		db.prepare(
			"UPDATE framework_iteration_attempts SET finished_at=?,status=? WHERE run_id=? AND finished_at IS NULL",
		).run(new Date().toISOString(), run.status, run.id);
		db.prepare(
			"UPDATE framework_iteration_stage_attempts SET finished_at=?,status='interrupted' WHERE run_id=? AND status='running'",
		).run(new Date().toISOString(), run.id);
	}
	for (const row of db
		.prepare(
			"SELECT id FROM framework_iterations WHERE dataset_id=? AND status IN ('queued','running','review_required')",
		)
		.all(datasetId)) {
		const run = load(db, datasetId, String(row.id));
		try {
			fresh(db, run);
		} catch (error) {
			run.status = "blocked";
			run.error = error instanceof Error ? error.message : "输入已变化，请新建运行。";
			run.leaseToken = null;
			run.leaseUntil = 0;
			save(db, run);
			db.prepare(
				"UPDATE framework_iteration_attempts SET finished_at=?,status='blocked' WHERE run_id=? AND finished_at IS NULL",
			).run(new Date().toISOString(), run.id);
			db.prepare(
				"UPDATE framework_iteration_stage_attempts SET finished_at=?,status='interrupted' WHERE run_id=? AND status='running'",
			).run(new Date().toISOString(), run.id);
		}
	}
}
export function iterationProjectSettings(cwd: string, datasetId: string): { testProject: boolean } {
	return database(cwd, datasetId, (db) => ({
		testProject:
			db.prepare("SELECT test_project FROM framework_iteration_settings WHERE dataset_id=?").get(datasetId)
				?.test_project === 1,
	}));
}
export function setIterationTestProject(cwd: string, datasetId: string, enabled: boolean): void {
	database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			reconcile(db, datasetId);
			if (
				db
					.prepare(
						"SELECT 1 FROM framework_iterations WHERE dataset_id=? AND status IN ('queued','running','review_required')",
					)
					.get(datasetId)
			)
				throw new ResearchError(409, "请先结束当前迭代再修改测试项目设置。");
			db.prepare(
				"INSERT INTO framework_iteration_settings VALUES(?,?) ON CONFLICT(dataset_id) DO UPDATE SET test_project=excluded.test_project",
			).run(datasetId, Number(enabled));
		}),
	);
}
export function createFrameworkIteration(
	cwd: string,
	datasetId: string,
	input: {
		requestId: string;
		basisVersionId: string;
		modelId: string;
		uploadIdentity: string;
		monitorRunId?: string;
		contextDocIds?: string[];
		automaticSetup?: boolean;
		company?: { name: string; ticker: string };
		changeReview?: boolean;
		sourceMode?: "documents" | "sources";
		sourceConfig?: InformationSourceConfig;
	},
): FrameworkIteration {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || !input.modelId || !input.basisVersionId)
		throw new ResearchError(400, "Invalid iteration request");
	if (input.automaticSetup && !input.monitorRunId)
		throw new ResearchError(400, "Automatic setup requires a project update run");
	if (input.sourceMode === "sources") {
		if (!input.sourceConfig) throw new ResearchError(400, "缺少信息源配置。");
		assertInformationSourceConfig(input.sourceConfig);
		if (!input.monitorRunId) input = { ...input, changeReview: true };
	}
	return database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			reconcile(db, datasetId);
			if (
				input.monitorRunId &&
				!db
					.prepare(`SELECT 1 FROM research_monitor_runs r JOIN research_monitor_plans p ON p.dataset_id=r.dataset_id
			 WHERE r.dataset_id=? AND r.run_id=? AND r.status='running' AND r.lease_until>? AND r.plan_revision=p.revision
			 AND json_extract(p.config_json,'$.updatePolicy')='direct' AND json_extract(p.config_json,'$.mode')='auto'`)
					.get(datasetId, input.monitorRunId, Date.now())
			)
				throw new ResearchError(409, "自动更新计划已改变，请重新开始。");
			const request = JSON.stringify(input);
			const prior = db
				.prepare("SELECT id,request_json FROM framework_iterations WHERE dataset_id=? AND request_id=?")
				.get(datasetId, input.requestId);
			if (prior) {
				if (prior.request_json !== request) throw new ResearchError(409, "Request ID belongs to different input");
				return load(db, datasetId, String(prior.id));
			}
			if (currentResearchVersion(db, datasetId) !== input.basisVersionId)
				throw new ResearchError(409, "框架基线已更新。");
			const basis = db
				.prepare("SELECT content_json,inputs_json FROM research_versions WHERE dataset_id=? AND version_id=?")
				.get(datasetId, input.basisVersionId);
			if (!basis || !isFrameworkDocument(JSON.parse(String(basis.content_json))))
				throw new ResearchError(409, "请先在聊天中确认完整七节框架。");
			if (input.sourceConfig) {
				const content = JSON.parse(String(basis.content_json)) as FrameworkContent;
				const codes = [
					...new Set(
						`${content.title}\n${content.sections.researchSetup.objective}`.match(
							/\b[A-Z0-9-]+\.(?:HK|SH|SZ|BJ|O|N)\b/gu,
						) ?? [],
					),
				];
				if (codes.length === 1 && codes[0] !== input.sourceConfig.companyTicker)
					throw new ResearchError(409, "公司证券代码与框架基线冲突，请核实身份后新建运行。");
			}
			if (
				db
					.prepare("SELECT 1 FROM framework_iterations WHERE dataset_id=? AND status IN ('queued','running')")
					.get(datasetId)
			)
				throw new ResearchError(409, "项目已有活跃迭代任务。");
			const at = new Date().toISOString();
			const run: FrameworkIteration = {
				id: randomUUID(),
				datasetId,
				requestId: input.requestId,
				basisVersionId: input.basisVersionId,
				modelId: input.modelId,
				processorVersion: ITERATION_PROCESSOR_VERSION,
				...(input.monitorRunId ? { monitorRunId: input.monitorRunId } : {}),
				...(input.automaticSetup
					? { automaticSetup: true, ...(input.company ? { company: input.company } : {}) }
					: {}),
				sourceMode: input.sourceMode ?? "documents",
				...(input.sourceConfig ? { sourceConfig: input.sourceConfig } : {}),
				changeReview: input.changeReview === true,
				automatic: input.monitorRunId
					? true
					: input.changeReview
						? false
						: db
								.prepare("SELECT test_project FROM framework_iteration_settings WHERE dataset_id=?")
								.get(datasetId)?.test_project === 1,
				status: "queued",
				reviewReasons: [],
				stage: input.automaticSetup ? "prepare" : input.sourceMode === "sources" ? "collect" : "ingest",
				ingestJobId: null,
				inputs: input.contextDocIds
					? captureResearchInputs(db, datasetId, [
							...new Set([
								...(JSON.parse(String(basis.inputs_json)) as { docId: string }[]).map((entry) => entry.docId),
								...input.contextDocIds,
							]),
						])
					: JSON.parse(String(basis.inputs_json)),
				newDocIds: [],
				artifacts: [],
				invalidArtifacts: [],
				usage: [],
				diagnostics: [],
				draftId: null,
				versionId: null,
				error: null,
				createdAt: at,
				updatedAt: at,
				leaseToken: null,
				leaseUntil: 0,
			};
			fresh(db, run);
			db.prepare("INSERT INTO framework_iterations VALUES(?,?,?,?,'queued',NULL,0,?)").run(
				run.id,
				datasetId,
				run.requestId,
				request,
				JSON.stringify(run),
			);
			return run;
		}),
	);
}
export function listFrameworkIterations(cwd: string, datasetId: string, beforeId?: string): FrameworkIteration[] {
	return database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			reconcile(db, datasetId);
			const cursor =
				beforeId === undefined
					? undefined
					: db
							.prepare("SELECT rowid FROM framework_iterations WHERE dataset_id=? AND id=?")
							.get(datasetId, beforeId);
			if (beforeId !== undefined && !cursor) throw new ResearchError(404, "Iteration history cursor not found");
			return db
				.prepare("SELECT id FROM framework_iterations WHERE dataset_id=? AND rowid<? ORDER BY rowid DESC LIMIT 100")
				.all(datasetId, cursor ? Number(cursor.rowid) : Number.MAX_SAFE_INTEGER)
				.map((r) => load(db, datasetId, String(r.id)));
		}),
	);
}
export function getFrameworkIteration(cwd: string, datasetId: string, id: string): FrameworkIteration {
	return database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			reconcile(db, datasetId);
			return load(db, datasetId, id);
		}),
	);
}
export function recordIterationUsage(
	cwd: string,
	datasetId: string,
	id: string,
	value: FrameworkIteration["usage"][number],
): void {
	database(cwd, datasetId, (db) => {
		load(db, datasetId, id);
		db.prepare("INSERT INTO framework_iteration_usage VALUES(?,?)").run(id, JSON.stringify(value));
	});
}
export function recordIterationDiagnostic(
	cwd: string,
	datasetId: string,
	id: string,
	value: FrameworkIteration["diagnostics"][number],
): void {
	database(cwd, datasetId, (db) => {
		load(db, datasetId, id);
		db.prepare("INSERT INTO framework_iteration_diagnostics VALUES(?,?)").run(id, JSON.stringify(value));
	});
}
export function attachIterationIngest(cwd: string, datasetId: string, id: string, jobId: string): void {
	database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			const run = load(db, datasetId, id);
			if (run.status !== "queued" || run.ingestJobId) throw new ResearchError(409, "Upload already attached");
			run.ingestJobId = jobId;
			save(db, run);
		}),
	);
}
export function failIterationSubmission(cwd: string, datasetId: string, id: string): void {
	database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			const run = load(db, datasetId, id);
			if (run.status !== "queued") return;
			run.status = "failed";
			run.error = "上传未能完成，请检查资料后新建运行。";
			save(db, run);
		}),
	);
}
export function cancelFrameworkIteration(cwd: string, datasetId: string, id: string): void {
	database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			const run = load(db, datasetId, id);
			if (["published", "no_change", "rejected"].includes(run.status))
				throw new ResearchError(409, "已完成的运行不能取消。");
			run.status = "cancelled";
			run.leaseToken = null;
			run.leaseUntil = 0;
			save(db, run);
			db.prepare(
				"UPDATE framework_iteration_attempts SET finished_at=?,status='cancelled' WHERE run_id=? AND finished_at IS NULL",
			).run(new Date().toISOString(), run.id);
			db.prepare(
				"UPDATE framework_iteration_stage_attempts SET finished_at=?,status='cancelled' WHERE run_id=? AND status='running'",
			).run(new Date().toISOString(), run.id);
		}),
	);
}
function owns(db: DatabaseSync, run: FrameworkIteration): void {
	if (
		!db
			.prepare(
				"SELECT 1 FROM framework_iterations WHERE id=? AND dataset_id=? AND status='running' AND lease_token=? AND lease_until>?",
			)
			.get(run.id, run.datasetId, run.leaseToken, Date.now())
	)
		throw new ResearchError(409, "Iteration cancelled or lease expired");
}
function fresh(db: DatabaseSync, run: FrameworkIteration): void {
	if (run.sourceMode === "sources") {
		if (!run.sourceConfig) throw new ResearchError(409, "信息源配置缺失，请新建运行。");
		assertInformationSourceConfig(run.sourceConfig);
	}
	if (run.processorVersion !== ITERATION_PROCESSOR_VERSION)
		throw new ResearchError(409, "处理器版本已变化，请新建运行；旧产物保留。");
	if (currentResearchVersion(db, run.datasetId) !== run.basisVersionId)
		throw new ResearchError(409, "框架基线已变化，请基于最新版本新建运行。");
	if (
		run.inputs.length &&
		JSON.stringify(
			captureResearchInputs(
				db,
				run.datasetId,
				run.inputs.map((i) => i.docId),
			),
		) !== JSON.stringify(run.inputs)
	)
		throw new ResearchError(409, "证据版本已变化，请新建运行。");
}
function artifact(db: DatabaseSync, run: FrameworkIteration, stage: IterationStage, value: unknown): void {
	const item = { stage, value, at: new Date().toISOString() };
	if (db.prepare("SELECT 1 FROM framework_iteration_artifacts WHERE run_id=? AND stage=?").get(run.id, stage))
		db.prepare("INSERT INTO framework_iteration_artifact_attempts VALUES(?,?,?,?)").run(
			randomUUID(),
			run.id,
			stage,
			JSON.stringify(item),
		);
	else db.prepare("INSERT INTO framework_iteration_artifacts VALUES(?,?,?)").run(run.id, stage, JSON.stringify(item));
	run.artifacts.push(item);
}
export function validateIterationAnalysis(
	db: DatabaseSync,
	run: FrameworkIteration,
	basis: FrameworkContent,
	observations: IterationObservations,
	impacts?: IterationImpacts,
): void {
	const newIds = new Set(run.newDocIds);
	if (
		observations.coverage.length !== newIds.size ||
		new Set(observations.coverage.map((c) => c.docId)).size !== newIds.size ||
		observations.coverage.some((c) => !newIds.has(c.docId) || !c.readLocations.length)
	)
		throw new ResearchError(400, "新资料读取覆盖记录不完整。");
	const quoteErrors: string[] = [];
	const errors: string[] = [];
	const boundSourceFacts = new Map<string, InformationFact>();
	for (const observation of observations.observations) {
		if (!newIds.has(observation.docId)) throw new ResearchError(400, "Observation is outside new documents");
		if (typeof observation.value === "number" && !quoteContainsNumber(observation.quote, observation.value))
			errors.push(`提取数值不在原文引述中：${observation.id}`);
		const quotes: string[] = [];
		const sourceFacts: InformationFact[] = [];
		const sourceLines = new Map<number, string>();
		const sourceRows = new Map<number, string>();
		let sourceView = false;
		for (const id of observation.evidenceIds) {
			const reference = parseSourceId(id);
			if (!reference || reference.docId !== observation.docId || !resolvePeEvidenceRecord(db, run.datasetId, id)) {
				errors.push(`Invalid observation evidence：${observation.id}，请原样复制读取工具返回的ID：${id}`);
				continue;
			}
			if (reference.location.kind === "pdf") {
				const pages = db
					.prepare("SELECT page_text FROM pdf_pages WHERE doc_id=? AND page_number BETWEEN ? AND ?")
					.all(observation.docId, reference.location.pageStart, reference.location.pageEnd);
				quotes.push(pages.map((p) => String(p.page_text)).join("\n"));
			}
			if (reference.location.kind === "text") {
				const { lineStart, lineEnd } = reference.location;
				const view = readInformationView(db, run.datasetId, observation.docId);
				const snapshot = view ?? readWindSnapshot(db, run.datasetId, observation.docId);
				if (snapshot)
					quotes.push(
						snapshot.text
							.split("\n")
							.slice(lineStart - 1, lineEnd)
							.join("\n"),
					);
				if (view) {
					sourceView = true;
					const lines = view.text.split("\n");
					for (const fact of view.manifest.view.facts.filter(
						(fact) => fact.line >= lineStart && fact.line <= lineEnd,
					)) {
						sourceFacts.push(fact);
						sourceLines.set(fact.line, lines[fact.line - 1]);
						let start = fact.line - 2;
						while (start >= 0 && !lines[start].startsWith("数据表 ")) start--;
						let end = fact.line;
						while (end < lines.length && lines[end] !== "") end++;
						sourceRows.set(fact.line, lines.slice(start + 1, end).join("\n"));
					}
				}
			}
		}
		if (sourceView) {
			const fact = sourceFacts.find(
				(value) =>
					value.metric === observation.sourceField &&
					value.value === observation.value &&
					observation.quote.includes(informationDisplayText(value.metric)) &&
					(sourceLines.get(value.line) ?? "")
						.replace(/\s/g, "")
						.toLowerCase()
						.includes(observation.quote.replace(/\s/g, "").toLowerCase()),
			);
			if (!fact)
				errors.push(
					`来源字段与数值配对不匹配：${observation.id}，sourceField必须复制locations.metric的原列名，并引用含有该列名和对应数值的完整证据行。`,
				);
			else {
				boundSourceFacts.set(observation.id, fact);
				if (
					!(sourceRows.get(fact.line) ?? "")
						.replace(/\s/g, "")
						.toLowerCase()
						.includes(observation.context.basisQuote.replace(/\s/g, "").toLowerCase())
				)
					errors.push(
						`来源口径引述不在对应数据行：${observation.id}，basisQuote须引用当前字段的完整证据行或同一供应商数据行的上下文，不能借用其他业务行的标签。`,
					);
				if (observation.context.periodKind !== fact.periodKind)
					errors.push(
						`来源期间分类不匹配：${observation.id}，context.periodKind使用locations.periodKind，不从年份或季度标签推定单期或累计。`,
					);
				if (fact.role && observation.role !== fact.role)
					errors.push(`来源角色不匹配：${observation.id}，role必须保留原始角色${fact.role}，不得混淆实际与预测。`);
				if (!fact.role && observation.role !== "unknown")
					errors.push(`来源实际或预测角色未明确：${observation.id}，role使用unknown并保留缺口，不能猜成fact。`);
				if (observation.context.scope !== fact.scope)
					errors.push(
						`来源业务口径不匹配：${observation.id}，context.scope使用locations.scope；缺失时填null，不从查询或指标常识补写。`,
					);
				if (observation.unit !== fact.unit)
					errors.push(`来源单位不匹配：${observation.id}，原单位为${fact.unit ?? "未提供"}，不得推算或换写。`);
				if (
					!fact.period &&
					(observation.period || observation.context.periodKind !== "unknown" || observation.context.asOf)
				)
					errors.push(
						`来源未明确该字段报告期：${observation.id}，period与asOf填null、periodKind用unknown，并记录缺口；不能套用最新报告期。`,
					);
				if (fact.period && !equivalentComparisonPeriod(observation.period, fact.period))
					errors.push(`来源报告期不匹配：${observation.id}，原字段期间为${fact.period}。`);
			}
		}
		if (
			quotes.length &&
			!quotes.some((q) =>
				q.replace(/\s/g, "").toLowerCase().includes(observation.quote.replace(/\s/g, "").toLowerCase()),
			)
		)
			quoteErrors.push(observation.id);
		if (
			quotes.length &&
			!quotes.some((q) =>
				q
					.replace(/\s/g, "")
					.toLowerCase()
					.includes(observation.context.basisQuote.replace(/\s/g, "").toLowerCase()),
			)
		)
			quoteErrors.push(`${observation.id}.context`);
		try {
			validateObservationContext(observation);
		} catch (error) {
			if (!(error instanceof ResearchError) || error.status !== 400) throw error;
			errors.push(error.message);
		}
	}
	if (quoteErrors.length)
		errors.unshift(
			`原文引述不匹配：${quoteErrors.join("、")}。引述必须存在于该观察 evidenceIds 所引用的原文页中。若 basisQuote 来自另一页，先读取该页，再把工具返回的 source ID 加入本观察 evidenceIds；不能只引用指标所在页。若引述本身被拼接或改写，则复制连续原文，不删掉中间行。`,
		);
	if (errors.length) throw new ResearchError(400, errors.join("\n"));
	if (!impacts) return;
	const judgments = new Set(basis.sections.investmentJudgments.items.map((j) => j.id));
	const sections = new Set(Object.keys(basis.sections));
	const impactErrors: string[] = [];
	for (const [index, impact] of impacts.impacts.entries()) {
		const label = `impacts[${index}]`;
		if (
			run.sourceMode === "sources" &&
			!impact.comparable &&
			["supports", "weakens", "overturns"].includes(impact.relation)
		)
			impactErrors.push(
				`${label}：信息源财务口径未确认可比，不能据数值差异支持、削弱或推翻判断；改为unresolved或supplements，保留原判断置信度，补充待核实项，不计算半年与全年完成率或年化偏差。`,
			);
		if (impact.judgmentIds.some((id) => !judgments.has(id)) || impact.sections.some((s) => !sections.has(s)))
			impactErrors.push(
				`${label}：未知判断或章节；judgmentIds仅可用${[...judgments].join("、")}，sections仅可用${[...sections].join("、")}。`,
			);
		const linked = observations.observations.filter((o) => impact.observationIds.includes(o.id));
		if (
			linked.length !== new Set(impact.observationIds).size ||
			impact.evidenceIds.some((id) => !linked.some((o) => o.evidenceIds.includes(id)))
		)
			impactErrors.push(
				`${label}：影响未关联提取证据；只能引用所关联观察的evidenceIds。可用观察ID：${observations.observations.map((o) => o.id).join("、")}。`,
			);
		if (impact.proposedChange && impact.judgmentIds.length && !impact.sections.includes("investmentJudgments"))
			impactErrors.push(`${label}：修改判断的建议必须包含investmentJudgments章节。`);
		if (impact.proposedChange && !impact.sections.length) impactErrors.push(`${label}：修改建议缺少目标章节。`);
		for (const observation of linked) {
			const sourceFact = boundSourceFacts.get(observation.id);
			if (
				impact.comparable &&
				sourceFact &&
				/收入|利润|费用|现金|资产|负债|毛利|EBIT|revenue|profit|cost/iu.test(sourceFact.metric) &&
				!/%|百分|率/u.test(sourceFact.unit ?? sourceFact.metric)
			) {
				const comparison = informationCurrencyCode(impact.comparisonBasis?.currency);
				if (!comparison || informationCurrencyCode(sourceFact.currency) !== comparison)
					impactErrors.push(
						`${label}：基线币种未确认或与来源币种${sourceFact.currency ?? "未知"}不同；comparisonBasis.currency必须来自原框架，币种未核实时comparable=false，不推算汇率或偏差。`,
					);
			}
			if (
				impact.comparable &&
				sourceFact &&
				(!sourceFact.role ||
					(!sourceFact.currency &&
						/收入|利润|费用|现金|资产|负债|毛利|EBIT|revenue|profit|cost/iu.test(sourceFact.metric) &&
						!/%|百分|率/u.test(sourceFact.unit ?? sourceFact.metric)))
			)
				impactErrors.push(
					`${label}：${observation.id} 的原始币种或实际/预测角色未确认，不得声明可比或计算确定偏差。`,
				);
			try {
				validateLinkedObservationText(observation, `${impact.reason}\n${impact.proposedChange || ""}`);
			} catch (error) {
				if (!(error instanceof ResearchError) || error.status !== 400) throw error;
				impactErrors.push(`${label}：${error.message}`);
			}
			const comparison = impact.comparisonBasis;
			if (
				impact.comparable &&
				(!comparison ||
					!observation.context.scope ||
					observation.context.periodKind === "unknown" ||
					!equivalentComparisonPeriod(observation.period, comparison.period) ||
					comparison.periodKind !== observation.context.periodKind ||
					comparison.scope.normalize("NFKC").replace(/\s/g, "").toLowerCase() !==
						observation.context.scope.normalize("NFKC").replace(/\s/g, "").toLowerCase())
			)
				impactErrors.push(
					`${label}：比较期间或口径不一致：${observation.id}。观察期间=${observation.period}，分类=${observation.context.periodKind}，范围=${observation.context.scope}；提交比较=${JSON.stringify(comparison)}。scope只写业务范围，数值与比较解释放reason；确认同口径后使用规范范围。口径未确认时保留真实comparisonBasis并设comparable=false，不计算确定偏差。多项观察范围不同应拆分影响，不强行统一。`,
				);
		}
	}
	if (impacts.substantive && !impacts.impacts.some((i) => i.proposedChange && i.relation !== "unrelated"))
		impactErrors.push("Substantive change has no supported proposal");
	if (!impacts.substantive && impacts.impacts.some((i) => i.proposedChange && i.relation !== "unrelated"))
		impactErrors.push("无实质变化的结果不能同时提出需要修订的判断。");
	if (impactErrors.length) throw new ResearchError(400, impactErrors.join("\n"));
}
export function validateIterationRevision(
	basis: FrameworkContent,
	candidate: FrameworkContent,
	impacts: IterationImpacts,
	observations?: IterationObservations,
): void {
	if (
		observations?.observations.some((observation) => observation.sourceField) &&
		!impacts.impacts.some((impact) => impact.comparable && impact.proposedChange)
	) {
		for (const scenario of basis.sections.valuation.scenarios) {
			const updated = candidate.sections.valuation.scenarios.find((value) => value.id === scenario.id);
			if (!updated) throw new ResearchError(400, `信息源口径待核实，不能删除原估值情景${scenario.id}。`);
			for (const key of ["value", "unit", "expectedReturn"] as const)
				if (!isDeepStrictEqual(scenario[key], updated[key]))
					throw new ResearchError(400, `信息源口径待核实且未重算，不能改变估值情景${scenario.id}的${key}。`);
		}
	}
	if (observations) {
		for (const observation of observations.observations) {
			function visit(value: unknown): void {
				if (!value || typeof value !== "object") return;
				if (Array.isArray(value)) {
					for (const entry of value) visit(entry);
					return;
				}
				const record = value as Record<string, unknown>;
				const ids = record.evidenceIds ?? (typeof record.evidenceId === "string" ? [record.evidenceId] : undefined);
				if (Array.isArray(ids) && ids.some((id) => observation.evidenceIds.includes(String(id)))) {
					const text = Object.entries(record)
						.filter(([key]) => key !== "before")
						.map(([, entry]) => entry)
						.flatMap((entry) =>
							typeof entry === "string"
								? [entry]
								: Array.isArray(entry)
									? entry.filter((item) => typeof item === "string")
									: [],
						)
						.join("\n");
					validateLinkedObservationText(observation, text);
				}
				for (const entry of Object.values(record)) visit(entry);
			}
			visit(candidate.sections);
		}
	}
	if (candidate.title !== basis.title) throw new ResearchError(400, "Framework title must remain stable");
	if (candidate.sections.researchSetup.informationCutoff !== null)
		throw new ResearchError(400, "新增资料的信息截止日未经核实，必须置空。");
	if (
		/只使用|仅使用|仅依据|只依据|only (?:use|using|based on)/i.test(basis.sections.researchSetup.objective) &&
		candidate.sections.researchSetup.objective === basis.sections.researchSetup.objective
	)
		throw new ResearchError(400, "新增资料后必须更新研究设置中的旧资料范围说明。");
	const changedSections = new Set(impacts.impacts.filter((i) => i.proposedChange).flatMap((i) => i.sections));
	const changedIds = new Set(impacts.impacts.filter((i) => i.proposedChange).flatMap((i) => i.judgmentIds));
	for (const impact of impacts.impacts.filter((i) => i.proposedChange && i.relation !== "unrelated")) {
		for (const section of impact.sections) {
			const key = section as keyof FrameworkContent["sections"];
			if (isDeepStrictEqual(basis.sections[key], candidate.sections[key]))
				throw new ResearchError(400, `修改建议未落实：${section}`);
		}
		for (const id of impact.judgmentIds) {
			if (
				isDeepStrictEqual(
					basis.sections.investmentJudgments.items.find((i) => i.id === id),
					candidate.sections.investmentJudgments.items.find((i) => i.id === id),
				)
			)
				throw new ResearchError(400, `修改判断建议未落实：${id}`);
		}
	}
	for (const [key, value] of Object.entries(basis.sections)) {
		if (["researchSetup", "evidenceAndChanges", "currentAssessment"].includes(key) || changedSections.has(key))
			continue;
		if (!isDeepStrictEqual(value, candidate.sections[key as keyof FrameworkContent["sections"]]))
			throw new ResearchError(400, `Unrelated section changed: ${key}`);
	}
	if (
		candidate.sections.researchSetup.horizon !== basis.sections.researchSetup.horizon ||
		candidate.sections.researchSetup.preferences !== basis.sections.researchSetup.preferences
	)
		throw new ResearchError(400, "不能改变用户研究期限或偏好。");
	for (const item of basis.sections.investmentJudgments.items) {
		const updated = candidate.sections.investmentJudgments.items.find((i) => i.id === item.id);
		if (!updated) throw new ResearchError(400, `Stable judgment ID removed: ${item.id}`);
		const related = impacts.impacts.filter((impact) => impact.proposedChange && impact.judgmentIds.includes(item.id));
		if (
			related.length &&
			related.every(
				(impact) =>
					!impact.comparable &&
					impact.observationIds.some((id) =>
						observations?.observations.some((observation) => observation.id === id && observation.sourceField),
					),
			)
		) {
			for (const key of ["claim", "invalidation", "counterEvidenceIds"] as const)
				if (!isDeepStrictEqual(item[key], updated[key]))
					throw new ResearchError(
						400,
						`信息源口径待核实，不能改变判断${item.id}的${key}；保留原经济判断，仅补充问题、取证动作和来源。`,
					);
			if (item.confidence.level !== updated.confidence.level)
				throw new ResearchError(
					400,
					`信息源口径待核实，不能改变判断${item.id}的confidence.level；保留原值${item.confidence.level}。`,
				);
		}
		if (!changedIds.has(item.id) && !isDeepStrictEqual(item, updated))
			throw new ResearchError(400, `Unrelated judgment changed: ${item.id}`);
		if (
			changedIds.has(item.id) &&
			!isDeepStrictEqual(item, updated) &&
			!candidate.sections.evidenceAndChanges.changes.some(
				(c) =>
					c.judgmentIds.includes(item.id) &&
					c.evidenceIds.some((id) =>
						impacts.impacts.some((i) => i.judgmentIds.includes(item.id) && i.evidenceIds.includes(id)),
					),
			)
		)
			throw new ResearchError(400, `Missing evidenced change record: ${item.id}`);
	}
	for (const item of candidate.sections.investmentJudgments.items.filter(
		(j) => !basis.sections.investmentJudgments.items.some((b) => b.id === j.id),
	)) {
		if (
			item.origin !== "research" ||
			!item.evidenceIds.some((id) => impacts.impacts.some((i) => i.proposedChange && i.evidenceIds.includes(id)))
		)
			throw new ResearchError(400, `New judgment has no corresponding impact: ${item.id}`);
	}
}

export async function runFrameworkIteration(
	cwd: string,
	datasetId: string,
	id: string,
	engine: IterationEngine,
	ingest: (run: FrameworkIteration, signal: AbortSignal) => Promise<{ docIds: string[]; warnings: string[] }>,
	externalSignal: AbortSignal,
): Promise<FrameworkIteration> {
	const run = database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			reconcile(db, datasetId);
			const value = load(db, datasetId, id);
			if (!["queued", "blocked", "failed"].includes(value.status))
				throw new ResearchError(409, "运行当前不可恢复。");
			if (value.processorVersion !== ITERATION_PROCESSOR_VERSION)
				throw new ResearchError(409, "处理器版本已变化，请新建运行。");
			if (
				db
					.prepare(
						"SELECT 1 FROM framework_iterations WHERE dataset_id=? AND id<>? AND status IN ('queued','running')",
					)
					.get(datasetId, id)
			)
				throw new ResearchError(409, "项目已有活跃任务。");
			fresh(db, value);
			value.status = "running";
			value.error = null;
			value.leaseToken = randomUUID();
			value.leaseUntil = Date.now() + 60_000;
			save(db, value);
			db.prepare("INSERT INTO framework_iteration_attempts VALUES(?,?,?,NULL,NULL)").run(
				id,
				value.leaseToken,
				new Date().toISOString(),
			);
			return value;
		}),
	);
	const stop = new AbortController();
	const signal = AbortSignal.any([externalSignal, stop.signal, AbortSignal.timeout(20 * 60_000)]);
	const heartbeat = setInterval(() => {
		try {
			database(cwd, datasetId, (db) =>
				researchTransaction(db, () => {
					owns(db, run);
					fresh(db, run);
					db.prepare("UPDATE framework_iterations SET lease_until=? WHERE id=? AND lease_token=?").run(
						Date.now() + 60_000,
						id,
						run.leaseToken,
					);
				}),
			);
		} catch (error) {
			stop.abort(error);
		}
	}, 10_000);
	function checkpoint(stage: IterationStage, value: unknown): void {
		signal.throwIfAborted();
		database(cwd, datasetId, (db) =>
			researchTransaction(db, () => {
				owns(db, run);
				fresh(db, run);
				artifact(db, run, stage, value);
				save(db, run);
			}),
		);
	}
	async function stage<T>(name: IterationStage, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const completed = run.artifacts.find((a) => a.stage === name);
		if (completed) {
			try {
				if (name === "revise") {
					const storedBasis = getResearchFramework(cwd, datasetId).versions.find(
						(v) => v.id === run.basisVersionId,
					)!.content;
					if (!isFrameworkDocument(storedBasis)) throw new ResearchError(409, "Complete framework required");
					validateIterationRevision(
						storedBasis,
						validateFrameworkContent(completed.value),
						validateIterationImpacts(run.artifacts.find((a) => a.stage === "impact")?.value),
						validateIterationObservations(run.artifacts.find((a) => a.stage === "extract")?.value),
					);
					database(cwd, datasetId, (db) =>
						validateResearchEvidence(db, datasetId, validateFrameworkContent(completed.value), run.inputs),
					);
				}
				return completed.value as T;
			} catch (error) {
				if (!(error instanceof ResearchError) || error.status !== 400) throw error;
				database(cwd, datasetId, (db) =>
					researchTransaction(db, () => {
						owns(db, run);
						fresh(db, run);
						const invalid = run.artifacts.filter(
							(a) => a === completed || (name === "revise" && a.stage === "validate"),
						);
						for (const entry of invalid) {
							db.prepare("INSERT INTO framework_iteration_invalid_artifacts VALUES(?,?,?,?)").run(
								randomUUID(),
								id,
								JSON.stringify(entry),
								error.message,
							);
							run.invalidArtifacts.push({ ...entry, reason: error.message });
						}
						run.artifacts = run.artifacts.filter((a) => !invalid.includes(a));
						if (name === "revise") {
							if (run.draftId)
								db.prepare(
									"UPDATE research_drafts SET status='rejected',revision=revision+1 WHERE dataset_id=? AND draft_id=? AND status='open'",
								).run(datasetId, run.draftId);
							run.draftId = null;
						}
					}),
				);
			}
		}
		run.stage = name;
		database(cwd, datasetId, (db) =>
			researchTransaction(db, () => {
				owns(db, run);
				fresh(db, run);
				save(db, run);
			}),
		);
		const stageSignal = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
		for (let attempt = 0; ; attempt++) {
			const attemptId = randomUUID();
			database(cwd, datasetId, (db) =>
				db
					.prepare("INSERT INTO framework_iteration_stage_attempts VALUES(?,?,?,?,NULL,'running')")
					.run(attemptId, id, name, new Date().toISOString()),
			);
			try {
				stageSignal.throwIfAborted();
				const value = await execute(stageSignal);
				checkpoint(name, value);
				database(cwd, datasetId, (db) =>
					db
						.prepare("UPDATE framework_iteration_stage_attempts SET finished_at=?,status='completed' WHERE id=?")
						.run(new Date().toISOString(), attemptId),
				);
				return value;
			} catch (error) {
				database(cwd, datasetId, (db) =>
					db
						.prepare(
							"UPDATE framework_iteration_stage_attempts SET finished_at=?,status='failed' WHERE id=? AND status='running'",
						)
						.run(new Date().toISOString(), attemptId),
				);
				if (
					attempt >= 2 ||
					stageSignal.aborted ||
					error instanceof ResearchError ||
					!(error instanceof Error) ||
					!/ECONNRESET|ETIMEDOUT|network|fetch failed|\b(502|503|504)\b/i.test(error.message)
				)
					throw error;
				await delay(1000 * (attempt + 1), undefined, { signal: stageSignal });
			}
		}
	}
	try {
		const basis = getResearchFramework(cwd, datasetId).versions.find((v) => v.id === run.basisVersionId)!.content;
		if (!isFrameworkDocument(basis)) throw new ResearchError(409, "Complete framework required");
		if (run.automaticSetup) {
			const setup = await stage("prepare", async (stageSignal) => {
				if (!engine.prepare) throw new ResearchError(409, "自动读取模型的服务暂不可用，请稍后点击立即更新重试。");
				return validateAutomaticSetup(cwd, datasetId, run, basis, await engine.prepare(run, basis, stageSignal));
			});
			if (!run.preparedModelRevision) {
				const model = saveIterationModelConfig(cwd, datasetId, setup.model);
				run.preparedModelRevision = model.revision;
			} else if (getIterationModelConfig(cwd, datasetId)?.revision !== run.preparedModelRevision) {
				throw new ResearchError(409, "本轮使用的模型已改变，请重新更新。");
			}
			run.sourceConfig = informationSourceConfig(setup.companyName, setup.companyTicker, ["wind-financials"]);
			const asOf = shanghaiToday(new Date(run.createdAt));
			run.sourceConfig.trackingWindow = { valuationDate: setup.valuationDate, asOf };
			run.sourceConfig.defaultPeriods = trackingPeriods(setup.valuationDate, asOf);
			run.sourceMode = "sources";
			database(cwd, datasetId, (db) =>
				researchTransaction(db, () => {
					owns(db, run);
					fresh(db, run);
					save(db, run);
				}),
			);
			const baseline = freezeIterationModelBaseline(cwd, datasetId, run.id);
			if (baseline.error) throw new ResearchError(409, baseline.error);
		}
		let collection: InformationCollection | undefined;
		if (run.monitorRunId && !run.artifacts.some((a) => a.stage === "ingest")) {
			const result = await ingest(run, signal);
			run.newDocIds = [...new Set(result.docIds)];
			run.inputs = database(cwd, datasetId, (db) =>
				captureResearchInputs(db, datasetId, [
					...new Set([...run.inputs.map((input) => input.docId), ...run.newDocIds]),
				]),
			);
			checkpoint("ingest", result);
		}
		if (run.sourceMode === "sources") {
			collection = await stage("collect", async (stageSignal) => {
				if (!engine.collect) throw new ResearchError(409, "信息源采集器不可用。");
				const collected = await engine.collect(run, basis, stageSignal);
				if (!collected.docIds.length && !(run.monitorRunId && run.newDocIds.length))
					throw new ResearchError(
						409,
						"没有可读取的相关财务数据；空结果和调用失败不代表无需调整。修复来源问题后可手动恢复，采集预算不重置。",
					);
				return collected;
			});
			if (!collection.docIds.length && !(run.monitorRunId && run.newDocIds.length))
				throw new ResearchError(409, "没有可读取的相关财务数据；空结果和调用失败不代表无需调整。");
			const baseline = getResearchFramework(cwd, datasetId).versions.find(
				(value) => value.id === run.basisVersionId,
			)!;
			run.newDocIds = [
				...new Set([
					...run.newDocIds,
					...collection.docIds.filter((docId) => !baseline.inputs.some((input) => input.docId === docId)),
				]),
			];
			database(cwd, datasetId, (db) =>
				researchTransaction(db, () => {
					owns(db, run);
					fresh(db, run);
					run.inputs = captureResearchInputs(db, datasetId, [
						...new Set([
							...run.inputs.map((input) => input.docId),
							...baseline.inputs.map((input) => input.docId),
							...collection!.docIds,
						]),
					]);
					run.reviewReasons = [...collection!.warnings];
					save(db, run);
				}),
			);
			if (!run.newDocIds.length) {
				run.status = "no_change";
				return run;
			}
		} else if (!run.artifacts.some((a) => a.stage === "ingest")) {
			const result = await ingest(run, signal);
			database(cwd, datasetId, (db) => {
				owns(db, run);
				fresh(db, run);
			});
			run.newDocIds = [...new Set(result.docIds)];
			if (!run.newDocIds.length) throw new ResearchError(409, "没有可读取的新资料。");
			const baseline = getResearchFramework(cwd, datasetId).versions.find((v) => v.id === run.basisVersionId)!;
			run.inputs = database(cwd, datasetId, (db) =>
				captureResearchInputs(db, datasetId, [
					...new Set([...baseline.inputs.map((i) => i.docId), ...run.newDocIds]),
				]),
			);
			checkpoint("ingest", result);
		}
		const observations = await stage("extract", async (stageSignal) => {
			const result = validateIterationObservations(await engine.extract(run, basis, stageSignal));
			database(cwd, datasetId, (db) => validateIterationAnalysis(db, run, basis, result));
			return result;
		});
		database(cwd, datasetId, (db) =>
			validateIterationAnalysis(db, run, basis, validateIterationObservations(observations)),
		);
		run.reviewReasons = [...(collection?.warnings ?? []), ...observationReviewReasons(observations)];
		for (const input of run.inputs.filter((i) => run.newDocIds.includes(i.docId))) {
			const fileType = database(
				cwd,
				datasetId,
				(db) =>
					db.prepare("SELECT file_type FROM documents WHERE dataset_id=? AND doc_id=?").get(datasetId, input.docId)
						?.file_type,
			);
			if (fileType !== "pdf")
				run.reviewReasons.push(
					`${input.docId}：${run.sourceMode === "sources" ? "来源字段、报告期和单位" : "表格原文、表头和脚注"}需人工核查`,
				);
		}
		const impacts = await stage("impact", async (stageSignal) => {
			const result = validateIterationImpacts(await engine.impact(run, basis, observations, stageSignal));
			database(cwd, datasetId, (db) => validateIterationAnalysis(db, run, basis, observations, result));
			return result;
		});
		database(cwd, datasetId, (db) =>
			validateIterationAnalysis(db, run, basis, observations, validateIterationImpacts(impacts)),
		);
		if (!impacts.substantive) run.status = "no_change";
		else {
			const candidate = await stage("revise", async (stageSignal) => {
				const content = validateFrameworkContent(
					synchronizeIterationScope(await engine.revise(run, basis, observations, impacts, stageSignal)),
				);
				validateIterationRevision(basis, content, impacts, observations);
				database(cwd, datasetId, (db) => validateResearchEvidence(db, datasetId, content, run.inputs));
				return content;
			});
			validateIterationRevision(basis, candidate, impacts, observations);
			if (isDeepStrictEqual(candidate, basis)) run.status = "no_change";
			else {
				const existingValidation = run.artifacts.find((a) => a.stage === "validate");
				const result = existingValidation
					? (existingValidation.value as { draftId: string })
					: database(cwd, datasetId, (db) =>
							researchTransaction(db, () => {
								owns(db, run);
								fresh(db, run);
								const draft = insertResearchDraft(
									db,
									datasetId,
									candidate,
									run.inputs,
									run.basisVersionId,
									new Date().toISOString(),
								);
								const result = { draftId: draft.id };
								run.draftId = draft.id;
								run.stage = "validate";
								artifact(db, run, "validate", result);
								save(db, run);
								return result;
							}),
						);
				run.draftId = result.draftId;
				if (run.reviewReasons.length && !run.monitorRunId) run.automatic = false;
				if (run.automatic) {
					run.stage = "publish";
					database(cwd, datasetId, (db) =>
						researchTransaction(db, () => {
							owns(db, run);
							save(db, run);
						}),
					);
					const version = await publishResearchDraftAsync(
						cwd,
						datasetId,
						{
							draftId: run.draftId,
							revision: 1,
							expectedVersionId: run.basisVersionId,
							requestId: `iteration_${run.id}`,
							iteration: { runId: run.id, leaseToken: run.leaseToken!, automatic: true },
						},
						{ signal },
					);
					run.versionId = version.id;
					run.status = "published";
				} else run.status = "review_required";
			}
		}
	} catch (error) {
		run.status = error instanceof ResearchError && [401, 402, 403, 409].includes(error.status) ? "blocked" : "failed";
		run.error = error instanceof Error ? error.message : "迭代失败。";
		recordIterationDiagnostic(cwd, datasetId, id, {
			stage: run.stage,
			tool: "pe_iteration_execution_error",
			error: run.error,
			at: new Date().toISOString(),
		});
	} finally {
		clearInterval(heartbeat);
		database(cwd, datasetId, (db) =>
			researchTransaction(db, () => {
				const current = load(db, datasetId, id);
				if (current.status !== "running" || current.leaseToken !== run.leaseToken) return;
				const receipt = db
					.prepare("SELECT version_id FROM research_versions WHERE dataset_id=? AND request_id=?")
					.get(datasetId, `iteration_${id}`);
				if (receipt) {
					run.versionId = String(receipt.version_id);
					run.status = "published";
					run.error = null;
				}
				db.prepare("UPDATE framework_iteration_attempts SET finished_at=?,status=? WHERE run_id=? AND token=?").run(
					new Date().toISOString(),
					run.status,
					id,
					run.leaseToken,
				);
				run.leaseToken = null;
				run.leaseUntil = 0;
				save(db, run);
			}),
		);
	}
	return getFrameworkIteration(cwd, datasetId, id);
}
export async function decideFrameworkIteration(
	cwd: string,
	datasetId: string,
	id: string,
	accept: boolean,
	signal: AbortSignal,
): Promise<FrameworkIteration> {
	const run = getFrameworkIteration(cwd, datasetId, id);
	if (run.status === "published" && accept) return run;
	if (run.status !== "review_required" || !run.draftId) throw new ResearchError(409, "没有待确认草稿。");
	if (accept) {
		if (run.changeReview) throw new ResearchError(409, "本轮需要逐项审查，请发布已接受的修改。");
		const draft = getResearchFramework(cwd, datasetId).drafts.find((entry) => entry.id === run.draftId);
		if (!draft || draft.status !== "open") throw new ResearchError(409, "待确认草稿已变化。");
		const version = await publishResearchDraftAsync(
			cwd,
			datasetId,
			{
				draftId: run.draftId,
				revision: draft.revision,
				expectedVersionId: run.basisVersionId,
				requestId: `iteration_${id}`,
				iteration: { runId: id, automatic: false },
			},
			{ signal },
		);
		run.versionId = version.id;
		run.status = "published";
	} else {
		database(cwd, datasetId, (db) =>
			researchTransaction(db, () => {
				const current = load(db, datasetId, id);
				if (current.status !== "review_required") throw new ResearchError(409, "草稿状态已变化。");
				db.prepare(
					"UPDATE research_drafts SET status='rejected',revision=revision+1 WHERE draft_id=? AND dataset_id=? AND status='open'",
				).run(current.draftId, datasetId);
				current.status = "rejected";
				save(db, current);
			}),
		);
	}
	return getFrameworkIteration(cwd, datasetId, id);
}
