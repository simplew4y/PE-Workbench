import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { resolvePeEvidenceRecord } from "../evidence.ts";
import { parseSourceId } from "../source.ts";
import {
	captureResearchInputs,
	currentResearchVersion,
	getResearchFramework,
	insertResearchDraft,
	publishResearchDraftAsync,
	validateResearchEvidence,
} from "./framework.ts";
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
	observationReviewReasons,
	synchronizeIterationScope,
	validateLinkedObservationText,
	validateObservationContext,
} from "./iteration-quality.ts";
import { type FrameworkContent, isFrameworkDocument, ResearchError, validateFrameworkContent } from "./model.ts";
import { researchTransaction, withResearchDatabase } from "./storage.ts";

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
	input: { requestId: string; basisVersionId: string; modelId: string; uploadIdentity: string },
): FrameworkIteration {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || !input.modelId || !input.basisVersionId)
		throw new ResearchError(400, "Invalid iteration request");
	return database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			reconcile(db, datasetId);
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
				automatic:
					db.prepare("SELECT test_project FROM framework_iteration_settings WHERE dataset_id=?").get(datasetId)
						?.test_project === 1,
				status: "queued",
				reviewReasons: [],
				stage: "ingest",
				ingestJobId: null,
				inputs: JSON.parse(String(basis.inputs_json)),
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
export function listFrameworkIterations(cwd: string, datasetId: string): FrameworkIteration[] {
	return database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			reconcile(db, datasetId);
			return db
				.prepare("SELECT id FROM framework_iterations WHERE dataset_id=? ORDER BY rowid DESC LIMIT 100")
				.all(datasetId)
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
	for (const observation of observations.observations) {
		if (!newIds.has(observation.docId)) throw new ResearchError(400, "Observation is outside new documents");
		if (
			typeof observation.value === "number" &&
			!Array.from(observation.quote.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)).some(
				(m) => Number(m[0].replace(/,/g, "")) === observation.value,
			)
		)
			throw new ResearchError(400, `提取数值不在原文引述中：${observation.id}`);
		const quotes: string[] = [];
		for (const id of observation.evidenceIds) {
			const reference = parseSourceId(id);
			if (!reference || reference.docId !== observation.docId || !resolvePeEvidenceRecord(db, run.datasetId, id))
				throw new ResearchError(400, "Invalid observation evidence");
			if (reference.location.kind === "pdf") {
				const pages = db
					.prepare("SELECT page_text FROM pdf_pages WHERE doc_id=? AND page_number BETWEEN ? AND ?")
					.all(observation.docId, reference.location.pageStart, reference.location.pageEnd);
				quotes.push(pages.map((p) => String(p.page_text)).join("\n"));
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
	}
	if (quoteErrors.length)
		throw new ResearchError(
			400,
			`原文引述不匹配：${quoteErrors.join("、")}。每项请复制一个连续原文片段，不拼接删掉中间行的表格或句子。`,
		);
	for (const observation of observations.observations) validateObservationContext(observation);
	if (!impacts) return;
	const judgments = new Set(basis.sections.investmentJudgments.items.map((j) => j.id));
	const sections = new Set(Object.keys(basis.sections));
	for (const impact of impacts.impacts) {
		if (impact.judgmentIds.some((id) => !judgments.has(id)) || impact.sections.some((s) => !sections.has(s)))
			throw new ResearchError(
				400,
				`影响引用了未知框架内容。judgmentIds仅可用：${[...judgments].join("、")}（问题ID不是判断ID）；sections仅可用：${[...sections].join("、")}。新增信息的judgmentIds填空数组。`,
			);
		const linked = observations.observations.filter((o) => impact.observationIds.includes(o.id));
		if (
			linked.length !== new Set(impact.observationIds).size ||
			impact.evidenceIds.some((id) => !linked.some((o) => o.evidenceIds.includes(id)))
		)
			throw new ResearchError(
				400,
				`影响未关联提取证据：observationIds=${impact.observationIds.join("、")}。证据仅可使用这些提取项的evidenceIds，不能添加其他页的ID。可用观察ID：${observations.observations.map((o) => o.id).join("、")}。`,
			);
		if (impact.proposedChange && impact.judgmentIds.length && !impact.sections.includes("investmentJudgments"))
			throw new ResearchError(400, "修改判断的建议必须包含investmentJudgments章节。");
		if (impact.proposedChange && !impact.sections.length) throw new ResearchError(400, "修改建议缺少目标章节。");
		for (const observation of linked) {
			validateLinkedObservationText(observation, `${impact.reason}\n${impact.proposedChange || ""}`);
			const comparison = impact.comparisonBasis;
			if (
				impact.comparable &&
				(!comparison ||
					!observation.context.scope ||
					observation.context.periodKind === "unknown" ||
					comparison.period !== observation.period ||
					comparison.periodKind !== observation.context.periodKind ||
					comparison.scope !== observation.context.scope)
			)
				throw new ResearchError(400, `比较期间或口径不一致：${observation.id}`);
		}
	}
	if (impacts.substantive && !impacts.impacts.some((i) => i.proposedChange && i.relation !== "unrelated"))
		throw new ResearchError(400, "Substantive change has no supported proposal");
	if (!impacts.substantive && impacts.impacts.some((i) => i.proposedChange && i.relation !== "unrelated"))
		throw new ResearchError(400, "无实质变化的结果不能同时提出需要修订的判断。");
}
export function validateIterationRevision(
	basis: FrameworkContent,
	candidate: FrameworkContent,
	impacts: IterationImpacts,
	observations?: IterationObservations,
): void {
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
		if (!run.artifacts.some((a) => a.stage === "ingest")) {
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
		run.reviewReasons = observationReviewReasons(observations);
		for (const input of run.inputs.filter((i) => run.newDocIds.includes(i.docId))) {
			const fileType = database(
				cwd,
				datasetId,
				(db) =>
					db.prepare("SELECT file_type FROM documents WHERE dataset_id=? AND doc_id=?").get(datasetId, input.docId)
						?.file_type,
			);
			if (fileType !== "pdf") run.reviewReasons.push(`${input.docId}：表格原文、表头和脚注需人工核查`);
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
				if (run.reviewReasons.length) run.automatic = false;
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
		const version = await publishResearchDraftAsync(
			cwd,
			datasetId,
			{
				draftId: run.draftId,
				revision: 1,
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
