import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getPeMemoVersion, listPeMemoHistory } from "../tools/memo-storage.ts";
import { fetchWindSnapshot, WIND_CATEGORIES, type WindQuery } from "../trusted-sources.ts";
import { captureResearchInputs, createResearchDraft, getResearchFramework, publishResearchDraft } from "./framework.ts";
import { type FrameworkContent, ResearchError } from "./model.ts";
import { researchTransaction, withResearchDatabase } from "./storage.ts";
import type { ResearchEngine, ResearchJobInput } from "./watch.ts";

export interface MonitorConfig {
	enabled: boolean;
	mode: "auto" | "review";
	intervalHours: number;
	objective: string;
	queries: WindQuery[];
	includeMemos: boolean;
}
export interface MonitorEvent {
	at: string;
	stage: string;
	status: string;
	detail: string;
	docId?: string;
	evidenceId?: string;
}
export interface MonitorRun {
	id: string;
	startedAt: string;
	finishedAt: string | null;
	status: string;
	events: MonitorEvent[];
	input?: ResearchJobInput;
	basisVersionId?: string;
	draftId?: string;
	versionId?: string;
	changes?: Array<{ id: string; before: string | null; after: string | null; reason: string }>;
	error?: string;
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS research_monitor_plans (
 dataset_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, enabled INTEGER NOT NULL,
 revision INTEGER NOT NULL, next_run_at INTEGER NOT NULL, cursor_json TEXT NOT NULL,
 heartbeat_at INTEGER
);
CREATE TABLE IF NOT EXISTS research_monitor_runs (
 run_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, plan_revision INTEGER NOT NULL,
 status TEXT NOT NULL, lease_until INTEGER NOT NULL, result_json TEXT NOT NULL, started_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS research_monitor_active ON research_monitor_runs(dataset_id) WHERE status='running';
`;
function database<T>(cwd: string, datasetId: string, action: (db: DatabaseSync) => T): T {
	return withResearchDatabase(cwd, datasetId, (db) => {
		db.exec(SCHEMA);
		return action(db);
	});
}
export function getResearchMonitor(cwd: string, datasetId: string) {
	return database(cwd, datasetId, (db) => {
		const row = db.prepare("SELECT * FROM research_monitor_plans WHERE dataset_id=?").get(datasetId);
		return {
			config: row ? (JSON.parse(String(row.config_json)) as MonitorConfig) : null,
			revision: row ? Number(row.revision) : 0,
			nextRunAt: row ? Number(row.next_run_at) : null,
			heartbeatAt: row?.heartbeat_at ? Number(row.heartbeat_at) : null,
			workerOnline: !!row?.heartbeat_at && Date.now() - Number(row.heartbeat_at) < 30_000,
			runs: db
				.prepare(
					"SELECT result_json FROM research_monitor_runs WHERE dataset_id=? ORDER BY started_at DESC LIMIT 30",
				)
				.all(datasetId)
				.map((entry) => JSON.parse(String(entry.result_json)) as MonitorRun),
		};
	});
}
export function saveResearchMonitor(cwd: string, datasetId: string, value: unknown, revision: number) {
	if (!value || typeof value !== "object") throw new ResearchError(400, "Invalid monitoring plan");
	const c = value as MonitorConfig;
	if (
		typeof c.enabled !== "boolean" ||
		!["auto", "review"].includes(c.mode) ||
		!Number.isInteger(c.intervalHours) ||
		c.intervalHours < 1 ||
		c.intervalHours > 168 ||
		typeof c.objective !== "string" ||
		!c.objective.trim() ||
		c.objective.length > 6000 ||
		typeof c.includeMemos !== "boolean" ||
		!Array.isArray(c.queries) ||
		c.queries.length > 6 ||
		c.queries.some(
			(q) =>
				!q ||
				!WIND_CATEGORIES.includes(q.category) ||
				typeof q.query !== "string" ||
				!q.query.trim() ||
				q.query.length > 2000,
		) ||
		new Set(c.queries.map((q) => q.category)).size !== c.queries.length
	)
		throw new ResearchError(400, "Invalid plan: interval 1–168 hours, at most one query per Wind category");
	const config: MonitorConfig = {
		enabled: c.enabled,
		mode: c.mode,
		intervalHours: c.intervalHours,
		objective: c.objective.trim(),
		queries: c.queries.map((q) => ({ category: q.category, query: q.query.trim() })),
		includeMemos: c.includeMemos,
	};
	if (c.enabled && !getResearchFramework(cwd, datasetId).currentVersionId)
		throw new ResearchError(409, "Publish an initial framework before enabling monitoring");
	database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			const row = db.prepare("SELECT revision FROM research_monitor_plans WHERE dataset_id=?").get(datasetId);
			if ((row ? Number(row.revision) : 0) !== revision)
				throw new ResearchError(409, "Monitoring settings changed; reload");
			db.prepare(`INSERT INTO research_monitor_plans VALUES(?,?,?,?,?,'',NULL)
			ON CONFLICT(dataset_id) DO UPDATE SET config_json=excluded.config_json,enabled=excluded.enabled,revision=excluded.revision,next_run_at=excluded.next_run_at,cursor_json='',heartbeat_at=NULL`).run(
				datasetId,
				JSON.stringify(config),
				Number(config.enabled),
				revision + 1,
				Date.now(),
			);
		}),
	);
	return getResearchMonitor(cwd, datasetId);
}
export function requestResearchMonitorRun(cwd: string, datasetId: string): void {
	database(cwd, datasetId, (db) => {
		if (
			db
				.prepare("UPDATE research_monitor_plans SET next_run_at=? WHERE dataset_id=? AND enabled=1")
				.run(Date.now(), datasetId).changes !== 1
		)
			throw new ResearchError(409, "Enable monitoring first");
	});
}

// One bounded run per project. The durable lease fences competing workers and late publication.
export async function runResearchMonitor(
	cwd: string,
	datasetId: string,
	engine: ResearchEngine,
	signal: AbortSignal,
	fetchSnapshot: typeof fetchWindSnapshot = fetchWindSnapshot,
): Promise<boolean> {
	signal.throwIfAborted();
	const claim = database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			const now = Date.now();
			db.prepare("UPDATE research_monitor_plans SET heartbeat_at=? WHERE dataset_id=?").run(now, datasetId);
			for (const row of db
				.prepare("SELECT * FROM research_monitor_runs WHERE dataset_id=? AND status='running' AND lease_until<=?")
				.all(datasetId, now)) {
				const run = JSON.parse(String(row.result_json)) as MonitorRun;
				run.status = "interrupted";
				run.finishedAt = new Date(now).toISOString();
				run.error = "Worker interrupted; unprocessed inputs will be checked again";
				// Publication can have committed immediately before a crash; recover its receipt.
				const published = db
					.prepare("SELECT version_id FROM research_versions WHERE dataset_id=? AND request_id=?")
					.get(datasetId, `monitor_${run.id}`);
				if (published) {
					run.status = "published";
					run.versionId = String(published.version_id);
					delete run.error;
				}
				db.prepare("UPDATE research_monitor_runs SET status=?,result_json=? WHERE run_id=?").run(
					run.status,
					JSON.stringify(run),
					run.id,
				);
			}
			const row = db
				.prepare("SELECT * FROM research_monitor_plans WHERE dataset_id=? AND enabled=1 AND next_run_at<=?")
				.get(datasetId, now);
			if (
				!row ||
				db.prepare("SELECT 1 FROM research_monitor_runs WHERE dataset_id=? AND status='running'").get(datasetId)
			)
				return null;
			const run: MonitorRun = {
				id: randomUUID(),
				startedAt: new Date(now).toISOString(),
				finishedAt: null,
				status: "running",
				events: [],
			};
			db.prepare("INSERT INTO research_monitor_runs VALUES(?,?,?,'running',?,?,?)").run(
				run.id,
				datasetId,
				row.revision,
				now + 600_000,
				JSON.stringify(run),
				run.startedAt,
			);
			db.prepare("UPDATE research_monitor_plans SET next_run_at=? WHERE dataset_id=?").run(
				now + 3600_000 * (JSON.parse(String(row.config_json)) as MonitorConfig).intervalHours,
				datasetId,
			);
			return {
				run,
				config: JSON.parse(String(row.config_json)) as MonitorConfig,
				revision: Number(row.revision),
				cursor: String(row.cursor_json),
			};
		}),
	);
	if (!claim) return false;
	const { run, config, revision } = claim;
	const stopped = new AbortController();
	const runSignal = AbortSignal.any([signal, stopped.signal, AbortSignal.timeout(540_000)]);
	const heartbeat = setInterval(() => {
		try {
			database(cwd, datasetId, (db) => {
				if (
					db
						.prepare(
							"UPDATE research_monitor_plans SET heartbeat_at=? WHERE dataset_id=? AND revision=? AND enabled=1",
						)
						.run(Date.now(), datasetId, claim.revision).changes !== 1
				)
					stopped.abort(new Error("Monitoring paused or settings changed"));
			});
		} catch (error) {
			stopped.abort(error);
		}
	}, 10_000);
	function persist() {
		database(cwd, datasetId, (db) => {
			if (
				db
					.prepare(
						"UPDATE research_monitor_runs SET result_json=? WHERE run_id=? AND status='running' AND lease_until>?",
					)
					.run(JSON.stringify(run), run.id, Date.now()).changes !== 1
			)
				throw new ResearchError(409, "Monitoring lease expired");
		});
	}
	function event(stage: string, status: string, detail: string, reference: Partial<MonitorEvent> = {}) {
		run.events.push({ at: new Date().toISOString(), stage, status, detail, ...reference });
		persist();
	}
	function active() {
		runSignal.throwIfAborted();
		database(cwd, datasetId, (db) => {
			if (
				!db
					.prepare("SELECT 1 FROM research_monitor_plans WHERE dataset_id=? AND enabled=1 AND revision=?")
					.get(datasetId, revision)
			)
				throw new ResearchError(409, "Monitoring paused or settings changed; results preserved");
		});
	}
	let cursor: string | undefined;
	try {
		active();
		const framework = getResearchFramework(cwd, datasetId);
		const basis = framework.versions.find((v) => v.id === framework.currentVersionId);
		if (!basis) throw new ResearchError(409, "No published framework");
		run.basisVersionId = basis.id;
		for (const query of config.queries) {
			active();
			event(query.category, "fetching", query.query);
			try {
				const result = await fetchSnapshot(cwd, query, runSignal);
				event(
					query.category,
					result.status,
					"已保存查询响应；主体相关性和证据有效性由复盘核对，空结果不代表无事件。",
					{ docId: result.docId, evidenceId: result.evidenceId },
				);
			} catch (error) {
				event(query.category, "failed", error instanceof Error ? error.message : "Source request failed");
			}
		}
		active();
		const inputs = database(cwd, datasetId, (db) => {
			const ids = db
				.prepare(`SELECT doc_id FROM documents WHERE dataset_id=? AND deleted_at IS NULL AND is_current=1
				AND status IN ('completed','completed_with_warnings') AND (file_type IN ('pdf','xlsx','xlsm') OR parser_name='wind_snapshot') ORDER BY doc_id`)
				.all(datasetId)
				.map((row) => String(row.doc_id));
			return captureResearchInputs(
				db,
				datasetId,
				[...new Set([...basis.inputs.map((i) => i.docId), ...ids])].sort(),
			);
		});
		const memos: NonNullable<ResearchJobInput["memos"]> = config.includeMemos
			? listPeMemoHistory(cwd, { datasetId })
					.series.flatMap((series) => {
						if (!series.current_memo_version_id) return [];
						const memo = getPeMemoVersion(cwd, series.current_memo_version_id, datasetId);
						return [
							{
								versionId: memo.memo_version_id,
								title: memo.series_title,
								content: memo.sections.map((s) => `${s.title}\n${s.content}`).join("\n\n"),
							},
						];
					})
					.sort((a, b) => a.versionId.localeCompare(b.versionId))
			: [];
		if (JSON.stringify(memos).length > 60_000)
			throw new ResearchError(409, "Memo context exceeds 60000 characters; narrow the saved research context");
		cursor = JSON.stringify({ inputs, memos: memos.map((m) => m.versionId), basis: basis.id });
		run.input = { objective: config.objective, inputs, memos, asOf: new Date().toISOString() };
		event(
			"inputs",
			"checked",
			`固定本轮 ${inputs.length} 份资料版本、${memos.length} 份 Memo。仅检测已完成入库的资料；未保存对话不会自动成为依据。`,
		);
		if (cursor === claim.cursor) {
			run.status = run.events.some((e) => e.status === "failed") ? "source_error" : "no_change";
		} else {
			event("research", "running", "Pi SDK 在独立会话读取固定证据，比较当前框架；Memo 仅作为观点背景。");
			const content = await engine.generate(
				run.input,
				basis.content,
				AbortSignal.any([runSignal, AbortSignal.timeout(300_000)]),
				(detail) => event("evidence", "checked", detail),
			);
			active();
			run.changes = frameworkChanges(basis.content, content);
			if (JSON.stringify(content) === JSON.stringify(basis.content)) {
				event("research", "unchanged", "复盘未提出框架变更。");
				run.status = run.events.some((e) => e.status === "failed") ? "source_error" : "no_change";
			} else {
				const draft = createResearchDraft(
					cwd,
					datasetId,
					content,
					inputs.map((i) => i.docId),
					basis.id,
					inputs,
				);
				run.draftId = draft.id;
				event("research", "draft", "变更草稿已保存，证据定位已校验。");
				if (config.mode === "auto") {
					const version = publishResearchDraft(cwd, datasetId, {
						draftId: draft.id,
						revision: draft.revision,
						expectedVersionId: basis.id,
						requestId: `monitor_${run.id}`,
						monitorRunId: run.id,
					});
					run.versionId = version.id;
					run.status = "published";
					cursor = JSON.stringify({ inputs, memos: memos.map((m) => m.versionId), basis: version.id });
					event("publication", "published", `自动发布 v${version.version}，保留旧版本和变更依据。`);
				} else {
					run.status = "review_required";
					event("publication", "review_required", "人工确认模式：等待审阅草稿。");
				}
			}
		}
	} catch (error) {
		run.status = "failed";
		run.error = error instanceof Error ? error.message : "Monitoring failed";
		cursor = undefined;
	} finally {
		clearInterval(heartbeat);
		run.finishedAt = new Date().toISOString();
		database(cwd, datasetId, (db) =>
			researchTransaction(db, () => {
				const saved = db
					.prepare(
						"UPDATE research_monitor_runs SET status=?,result_json=? WHERE run_id=? AND status='running' AND lease_until>?",
					)
					.run(run.status, JSON.stringify(run), run.id, Date.now());
				if (saved.changes && cursor !== undefined)
					db.prepare("UPDATE research_monitor_plans SET cursor_json=? WHERE dataset_id=? AND revision=?").run(
						cursor,
						datasetId,
						claim.revision,
					);
			}),
		);
		const directory = join(cwd, "generated", "monitoring");
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, `${run.id}.md`),
			`# 自动跟踪运行记录\n\n${run.startedAt} → ${run.finishedAt}\n\n状态：${run.status}\n\n## 执行记录\n\n${run.events.map((e) => `- ${e.at} · ${e.stage} · ${e.status}：${e.detail}`).join("\n")}\n\n## 变更与输入清单\n\n\`\`\`json\n${JSON.stringify(run, null, 2)}\n\`\`\`\n`,
			{ mode: 0o600 },
		);
	}
	return true;
}

export function frameworkChanges(
	before: FrameworkContent,
	after: FrameworkContent,
): NonNullable<MonitorRun["changes"]> {
	const ids = new Set([...before.items, ...after.items].map((item) => item.id));
	const changes = [...ids].flatMap((id) => {
		const a = before.items.find((item) => item.id === id);
		const b = after.items.find((item) => item.id === id);
		return JSON.stringify(a) === JSON.stringify(b)
			? []
			: [{ id, before: a?.claim ?? null, after: b?.claim ?? null, reason: b?.rationale ?? "条目移除，详见新框架" }];
	});
	for (const key of ["title", "objective", "horizon", "coverageGaps"] as const) {
		if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
			changes.push({
				id: key,
				before: JSON.stringify(before[key]),
				after: JSON.stringify(after[key]),
				reason: "框架说明或资料缺口发生变化，详见前后版本。",
			});
	}
	return changes;
}
