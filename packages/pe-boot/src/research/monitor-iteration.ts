import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { captureResearchInputs, getResearchFramework } from "./framework.ts";
import {
	cancelFrameworkIteration,
	createFrameworkIteration,
	getFrameworkIteration,
	listFrameworkIterations,
	runFrameworkIteration,
} from "./iteration.ts";
import type { FrameworkIteration, IterationEngine, IterationImpacts } from "./iteration-model.ts";
import {
	executeIterationModelUpdate,
	freezeIterationModelBaseline,
	getIterationModelUpdateResult,
	promoteIterationModelUpdate,
} from "./iteration-model-update.ts";
import { ResearchError } from "./model.ts";
import { cancelResearchMonitorRun, getResearchMonitor, type MonitorConfig, type MonitorRun } from "./monitor.ts";
import { researchTransaction, withResearchDatabase } from "./storage.ts";
import { shanghaiToday, trackingPeriods } from "./tracking-periods.ts";

export type MonitorIterationEngineFactory = (run: FrameworkIteration) => Promise<IterationEngine>;

interface IterationMonitorRun extends MonitorRun {
	pipeline: "iteration";
	iterationRequest: Parameters<typeof createFrameworkIteration>[2];
	iterationDocIds: string[];
	inputCursor: string;
	manual?: boolean;
}

const completed = new Set(["published", "no_change", "rejected", "cancelled"]);

export function resetStoppedMonitorIterations(cwd: string, datasetId: string): boolean {
	getResearchMonitor(cwd, datasetId);
	listFrameworkIterations(cwd, datasetId);
	const rows = withResearchDatabase(cwd, datasetId, (db) =>
		db
			.prepare(
				"SELECT run_id,status,lease_until,result_json FROM research_monitor_runs WHERE dataset_id=? AND status NOT IN ('published','no_change','rejected','cancelled')",
			)
			.all(datasetId),
	);
	if (rows.some((row) => row.status === "running" && Number(row.lease_until) > Date.now())) return false;
	for (const row of rows) {
		const run = JSON.parse(String(row.result_json)) as MonitorRun;
		if (run?.iterationId) {
			const iteration = getFrameworkIteration(cwd, datasetId, run.iterationId);
			if (!completed.has(iteration.status)) cancelFrameworkIteration(cwd, datasetId, iteration.id);
		}
		cancelResearchMonitorRun(cwd, datasetId, String(row.run_id));
	}
	return true;
}

function consumeInputs(db: DatabaseSync, datasetId: string, runId: string, cursor: string): void {
	const plan = db
		.prepare(`SELECT plan.cursor_json FROM research_monitor_plans plan
	JOIN research_monitor_runs run ON run.dataset_id=plan.dataset_id
	WHERE plan.dataset_id=? AND run.run_id=? AND json_extract(plan.config_json,'$.pipeline')='iteration'
	AND run.plan_revision>=COALESCE((SELECT revision FROM research_monitor_cursor_resets WHERE dataset_id=plan.dataset_id),0)`)
		.get(datasetId, runId);
	if (!plan) return;
	const previous: unknown = plan.cursor_json ? JSON.parse(String(plan.cursor_json)) : [];
	const incoming: unknown = JSON.parse(cursor);
	if (!Array.isArray(previous) || !Array.isArray(incoming))
		throw new ResearchError(409, "Invalid iteration consumption cursor");
	const inputs = new Map([...previous, ...incoming].map((input) => [JSON.stringify(input), input]));
	db.prepare("UPDATE research_monitor_plans SET cursor_json=? WHERE dataset_id=?").run(
		JSON.stringify([...inputs.values()]),
		datasetId,
	);
}

export async function runResearchMonitorIteration(
	cwd: string,
	datasetId: string,
	signal: AbortSignal,
	engineForRun?: MonitorIterationEngineFactory,
): Promise<boolean> {
	signal.throwIfAborted();
	getResearchMonitor(cwd, datasetId);
	listFrameworkIterations(cwd, datasetId);
	withResearchDatabase(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			for (const row of db
				.prepare(
					"SELECT result_json FROM research_monitor_runs WHERE dataset_id=? AND status='running' AND lease_until<=? AND json_extract(result_json,'$.pipeline') IS NULL",
				)
				.all(datasetId, Date.now())) {
				const previous = JSON.parse(String(row.result_json)) as MonitorRun;
				const receipt = db
					.prepare("SELECT version_id FROM research_versions WHERE dataset_id=? AND request_id=?")
					.get(datasetId, `monitor_${previous.id}`);
				previous.status = receipt ? "published" : "interrupted";
				previous.finishedAt = new Date().toISOString();
				previous.versionId = receipt ? String(receipt.version_id) : undefined;
				previous.error = receipt ? undefined : "旧监控执行中断；记录保留，新计划使用结构化迭代。";
				db.prepare("UPDATE research_monitor_runs SET status=?,result_json=? WHERE run_id=?").run(
					previous.status,
					JSON.stringify(previous),
					previous.id,
				);
			}
		}),
	);
	const pending = withResearchDatabase(cwd, datasetId, (db) =>
		db
			.prepare(
				"SELECT result_json,lease_until FROM research_monitor_runs WHERE dataset_id=? AND json_extract(result_json,'$.pipeline')='iteration' AND status NOT IN ('published','no_change','rejected','cancelled')",
			)
			.all(datasetId),
	);
	for (const row of pending) {
		const previous = JSON.parse(String(row.result_json)) as IterationMonitorRun;
		if (previous.status === "running" && Number(row.lease_until) > Date.now()) continue;
		const linked = withResearchDatabase(cwd, datasetId, (db) =>
			db
				.prepare("SELECT id FROM framework_iterations WHERE dataset_id=? AND request_id=?")
				.get(datasetId, previous.id),
		);
		if (linked) {
			const iteration = getFrameworkIteration(cwd, datasetId, String(linked.id));
			previous.iterationId = iteration.id;
			previous.status = iteration.status;
			previous.draftId = iteration.draftId ?? undefined;
			previous.versionId = iteration.versionId ?? undefined;
			previous.error = iteration.error ?? undefined;
		} else if (previous.status === "running") {
			previous.status = "blocked";
			previous.error = "调度执行中断；请检查后重新保存计划，未自动重试模型调用。";
		}
		previous.finishedAt ??= new Date().toISOString();
		withResearchDatabase(cwd, datasetId, (db) =>
			researchTransaction(db, () => {
				const saved = db
					.prepare(
						"UPDATE research_monitor_runs SET status=?,result_json=? WHERE run_id=? AND (status<>'running' OR lease_until<=?)",
					)
					.run(previous.status, JSON.stringify(previous), previous.id, Date.now());
				if (saved.changes && completed.has(previous.status))
					consumeInputs(db, datasetId, previous.id, previous.inputCursor);
			}),
		);
	}
	const planState = getResearchMonitor(cwd, datasetId);
	if (
		planState.config?.automaticSetup &&
		(planState.manualRequested || (planState.config.enabled && (planState.nextRunAt ?? Infinity) <= Date.now()))
	)
		resetStoppedMonitorIterations(cwd, datasetId);
	const framework = getResearchFramework(cwd, datasetId);
	const basis = framework.versions.find((version) => version.id === framework.currentVersionId);
	const claim = withResearchDatabase(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			const now = Date.now();
			db.prepare("UPDATE research_monitor_plans SET heartbeat_at=? WHERE dataset_id=?").run(now, datasetId);
			const plan = db
				.prepare(
					"SELECT * FROM research_monitor_plans p WHERE dataset_id=? AND ((enabled=1 AND next_run_at<=?) OR EXISTS(SELECT 1 FROM research_monitor_manual_requests m WHERE m.dataset_id=p.dataset_id AND m.plan_revision=p.revision))",
				)
				.get(datasetId, now);
			if (!plan) return null;
			const config = JSON.parse(String(plan.config_json)) as MonitorConfig;
			if (config.pipeline !== "iteration") return null;
			if (
				db
					.prepare(
						"SELECT 1 FROM research_monitor_runs WHERE dataset_id=? AND (status='running' OR (json_extract(result_json,'$.pipeline')='iteration' AND status NOT IN ('published','no_change','rejected','cancelled') AND (plan_revision=? OR json_extract(result_json,'$.iterationId') IS NOT NULL)))",
					)
					.get(datasetId, plan.revision)
			)
				return null;
			if (
				db
					.prepare(
						"SELECT 1 FROM framework_iterations WHERE dataset_id=? AND status IN ('queued','running','blocked','failed','review_required')",
					)
					.get(datasetId)
			)
				return null;
			if (!basis) throw new ResearchError(409, "Publish an initial framework before monitoring");
			const ids = db
				.prepare(
					"SELECT doc_id FROM documents WHERE dataset_id=? AND deleted_at IS NULL AND is_current=1 AND status IN ('completed','completed_with_warnings') AND (file_type IN ('pdf','xlsx','xlsm') OR parser_name='official_filing_snapshot') ORDER BY doc_id",
				)
				.all(datasetId)
				.map((row) => String(row.doc_id));
			const inputs = captureResearchInputs(db, datasetId, ids);
			const previousInputs = plan.cursor_json ? (JSON.parse(String(plan.cursor_json)) as unknown) : [];
			const seen = new Set(
				(Array.isArray(previousInputs) ? previousInputs : []).map((input) => JSON.stringify(input)),
			);
			for (const input of basis.inputs) seen.add(JSON.stringify(input));
			const newDocIds = inputs.filter((input) => !seen.has(JSON.stringify(input))).map((input) => input.docId);
			const id = randomUUID();
			let sourceConfig =
				config.updatePolicy === "direct" ? config.sourceConfig : newDocIds.length ? undefined : config.sourceConfig;
			if (sourceConfig?.trackingWindow) {
				const trackingWindow = { ...sourceConfig.trackingWindow, asOf: shanghaiToday(new Date(now)) };
				sourceConfig = {
					...sourceConfig,
					trackingWindow,
					defaultPeriods: trackingPeriods(
						trackingWindow.valuationDate ?? trackingWindow.startDate ?? "",
						trackingWindow.asOf,
					),
				};
			}
			const manual = !!db
				.prepare("SELECT 1 FROM research_monitor_manual_requests WHERE dataset_id=? AND plan_revision=?")
				.get(datasetId, plan.revision);
			const run: IterationMonitorRun = {
				id,
				pipeline: "iteration",
				manual,
				startedAt: new Date(now).toISOString(),
				finishedAt: null,
				status: "running",
				events: [],
				basisVersionId: basis.id,
				input: { objective: config.objective, inputs, asOf: new Date(now).toISOString() },
				inputCursor: JSON.stringify(inputs),
				iterationDocIds: newDocIds,
				iterationRequest: {
					requestId: id,
					basisVersionId: basis.id,
					modelId: config.modelId!,
					uploadIdentity: JSON.stringify(inputs),
					changeReview: config.updatePolicy !== "direct" || config.mode !== "auto",
					...(config.updatePolicy === "direct" && config.mode === "auto"
						? {
								monitorRunId: id,
								contextDocIds: ids,
								...(config.automaticSetup ? { automaticSetup: true, company: config.company } : {}),
							}
						: {}),
					sourceMode: sourceConfig ? "sources" : "documents",
					...(sourceConfig ? { sourceConfig } : {}),
				},
			};
			db.prepare("INSERT INTO research_monitor_runs VALUES(?,?,?,'running',?,?,?)").run(
				id,
				datasetId,
				plan.revision,
				now + 1_500_000,
				JSON.stringify(run),
				run.startedAt,
			);
			db.prepare("UPDATE research_monitor_plans SET next_run_at=? WHERE dataset_id=?").run(
				now + config.intervalHours * 3_600_000,
				datasetId,
			);
			db.prepare("DELETE FROM research_monitor_manual_requests WHERE dataset_id=?").run(datasetId);
			return { run, revision: Number(plan.revision), config };
		}),
	);
	if (!claim) return false;
	if (!basis) throw new ResearchError(409, "请先保存投资框架。");
	const { run, revision, config } = claim;
	const stopped = new AbortController();
	const runSignal = AbortSignal.any([signal, stopped.signal]);
	function active() {
		runSignal.throwIfAborted();
		withResearchDatabase(cwd, datasetId, (db) => {
			if (
				!db
					.prepare("SELECT 1 FROM research_monitor_plans WHERE dataset_id=? AND (enabled=1 OR ?=1) AND revision=?")
					.get(datasetId, Number(run.manual === true), revision)
			)
				throw new ResearchError(409, "Monitoring paused or settings changed; results preserved");
			if (
				!db
					.prepare("SELECT 1 FROM research_monitor_runs WHERE run_id=? AND status='running' AND lease_until>?")
					.get(run.id, Date.now())
			)
				throw new ResearchError(409, "Monitoring lease expired");
		});
	}
	const heartbeat = setInterval(() => {
		try {
			active();
			withResearchDatabase(cwd, datasetId, (db) => {
				db.prepare("UPDATE research_monitor_plans SET heartbeat_at=? WHERE dataset_id=? AND revision=?").run(
					Date.now(),
					datasetId,
					revision,
				);
			});
		} catch (error) {
			stopped.abort(error);
		}
	}, 10_000);
	try {
		active();
		if (!run.iterationDocIds.length && !run.iterationRequest.sourceConfig && !run.iterationRequest.automaticSetup) {
			run.status = "no_change";
		} else {
			const iteration = createFrameworkIteration(cwd, datasetId, run.iterationRequest);
			run.iterationId = iteration.id;
			try {
				if (!iteration.automaticSetup) freezeIterationModelBaseline(cwd, datasetId, iteration.id);
			} catch (error) {
				run.events.push({
					at: new Date().toISOString(),
					stage: "model",
					status: "unavailable",
					detail: error instanceof Error ? error.message : "模型基线冻结失败；框架迭代继续。",
				});
			}
			withResearchDatabase(cwd, datasetId, (db) =>
				db
					.prepare("UPDATE research_monitor_runs SET result_json=? WHERE run_id=? AND status='running'")
					.run(JSON.stringify(run), run.id),
			);
			let engine: Promise<IterationEngine> | undefined;
			async function resolveEngine() {
				active();
				if (config.runtime !== "server" || !engineForRun)
					throw new ResearchError(
						409,
						"后台追踪尚未配置项目授权的服务端模型运行时；请使用手动迭代，不会借用本机或其他用户账户。",
					);
				engine ??= engineForRun!(iteration);
				return engine;
			}
			const guardedEngine: IterationEngine = {
				async prepare(...args) {
					const delegate = await resolveEngine();
					active();
					if (!delegate.prepare) throw new ResearchError(409, "Automatic model reader is unavailable");
					const value = await delegate.prepare(...args);
					active();
					return value;
				},
				async collect(...args) {
					const delegate = await resolveEngine();
					active();
					if (!delegate.collect) throw new ResearchError(409, "Information source collector is unavailable");
					const value = await delegate.collect(...args);
					active();
					return value;
				},
				async extract(...args) {
					const delegate = await resolveEngine();
					active();
					const value = await delegate.extract(...args);
					active();
					return value;
				},
				async impact(...args) {
					const delegate = await resolveEngine();
					active();
					const value = await delegate.impact(...args);
					active();
					return value;
				},
				async revise(...args) {
					const delegate = await resolveEngine();
					active();
					const value = await delegate.revise(...args);
					active();
					return value;
				},
			};
			const result = await runFrameworkIteration(
				cwd,
				datasetId,
				iteration.id,
				guardedEngine,
				async () => {
					active();
					withResearchDatabase(cwd, datasetId, (db) => {
						const frozen = captureResearchInputs(
							db,
							datasetId,
							run.input!.inputs.map((input) => input.docId),
						);
						if (JSON.stringify(frozen) !== run.inputCursor)
							throw new ResearchError(409, "Monitoring inputs changed; start a new iteration");
					});
					return { docIds: run.iterationDocIds, warnings: [] };
				},
				runSignal,
			);
			run.status = result.status;
			run.draftId = result.draftId ?? undefined;
			run.versionId = result.versionId ?? undefined;
			run.error = result.error ?? undefined;
			const preparation = result.artifacts.find((artifact) => artifact.stage === "prepare")?.value as
				| { summary: string }
				| undefined;
			if (preparation)
				run.events.push({
					at: new Date().toISOString(),
					stage: "prepare",
					status: "saved",
					detail: preparation.summary,
				});
			const impacts = result.artifacts.find((artifact) => artifact.stage === "impact")?.value as
				| IterationImpacts
				| undefined;
			if (impacts)
				run.events.push({
					at: new Date().toISOString(),
					stage: "analysis",
					status: result.status,
					detail: impacts.summary,
				});
			const revised = result.artifacts.find((artifact) => artifact.stage === "revise")?.value;
			if (revised && typeof revised === "object" && "sections" in revised) {
				const content = revised as typeof basis.content;
				if ("sections" in content)
					run.changes = content.sections.evidenceAndChanges.changes
						.filter(
							(change) =>
								!basis.content ||
								!("sections" in basis.content) ||
								!basis.content.sections.evidenceAndChanges.changes.some(
									(old) => JSON.stringify(old) === JSON.stringify(change),
								),
						)
						.map((change, index) => ({
							id: `${index}`,
							before: change.before,
							after: change.after,
							reason: change.reason,
						}));
			}
			if (["review_required", "published", "no_change"].includes(result.status)) {
				try {
					active();
					const model = await executeIterationModelUpdate(cwd, datasetId, result.id, runSignal);
					if (
						config.updatePolicy === "direct" &&
						config.mode === "auto" &&
						model.status === "candidate" &&
						["published", "no_change"].includes(result.status)
					) {
						active();
						promoteIterationModelUpdate(cwd, datasetId, result.id, model.configRevision!, "自动更新");
					}
					const adopted = getIterationModelUpdateResult(cwd, datasetId, result.id)?.promotionReceipt;
					run.events.push({
						at: new Date().toISOString(),
						stage: "model",
						status: model.status,
						detail:
							model.error ??
							(adopted
								? `模型已更新 ${model.proposal.length} 个输入，旧文件版本已保留。`
								: model.status === "not_configured"
									? "框架已分析；尚未绑定模型输入，模型文件未修改。"
									: model.status === "no_change"
										? "没有足够的新数据需要调整模型，原值保留。"
										: "本轮模型已生成，等待采用。"),
					});
				} catch (error) {
					run.events.push({
						at: new Date().toISOString(),
						stage: "model",
						status: "unavailable",
						detail: error instanceof Error ? error.message : "模型更新失败；框架结果保留。",
					});
				}
			}
		}
	} catch (error) {
		run.status = "blocked";
		run.error = error instanceof Error ? error.message : "Iteration monitoring failed";
	} finally {
		clearInterval(heartbeat);
		run.finishedAt = new Date().toISOString();
		run.events.push({
			at: run.finishedAt,
			stage: "iteration",
			status: run.status,
			detail:
				run.error ??
				(run.status === "published"
					? "投资框架已更新，原格式和历史版本已保留。"
					: run.status === "review_required"
						? "有需要核对的调整，请查看本轮记录。"
						: "本轮没有修改投资框架。"),
		});
		withResearchDatabase(cwd, datasetId, (db) =>
			researchTransaction(db, () => {
				const saved = db
					.prepare(
						"UPDATE research_monitor_runs SET status=?,result_json=? WHERE run_id=? AND status='running' AND lease_until>?",
					)
					.run(run.status, JSON.stringify(run), run.id, Date.now());
				if (saved.changes && completed.has(run.status)) consumeInputs(db, datasetId, run.id, run.inputCursor);
			}),
		);
	}
	return true;
}
