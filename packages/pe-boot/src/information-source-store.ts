import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Compile } from "typebox/compile";
import { registerPeDocuments } from "./documents.ts";
import {
	assertInformationSourceConfig,
	INFORMATION_SOURCE_ADAPTERS,
	type InformationCollection,
	type InformationQuery,
	InformationQuerySchema,
	type InformationSourceAttempt,
	type InformationSourceQueryRecord,
	type InformationView,
	informationCurrencyCode,
	informationHash,
	renderWindFinancials,
} from "./information-source-model.ts";
import type { FrameworkIteration } from "./research/iteration-model.ts";
import { ResearchError } from "./research/model.ts";
import { researchTransaction, withResearchDatabase } from "./research/storage.ts";
import { sourceId } from "./source.ts";
import { documentFilePath, type SqlRow } from "./tools/database.ts";
import { queryWind, type WindQuery, windApiKey } from "./trusted-sources.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS framework_iteration_source_queries(run_id TEXT NOT NULL,query_id TEXT NOT NULL,query_json TEXT NOT NULL,PRIMARY KEY(run_id,query_id));
CREATE TABLE IF NOT EXISTS framework_iteration_source_attempts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,query_id TEXT NOT NULL,attempt_no INTEGER NOT NULL,finished_at TEXT,record_json TEXT NOT NULL,UNIQUE(run_id,query_id,attempt_no));
CREATE TABLE IF NOT EXISTS information_source_views(doc_id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL,manifest_json TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS source_queries_no_update BEFORE UPDATE ON framework_iteration_source_queries BEGIN SELECT RAISE(ABORT,'Source queries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_queries_no_delete BEFORE DELETE ON framework_iteration_source_queries BEGIN SELECT RAISE(ABORT,'Source queries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_attempts_finished BEFORE UPDATE ON framework_iteration_source_attempts WHEN OLD.finished_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Finished source attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_attempts_no_delete BEFORE DELETE ON framework_iteration_source_attempts BEGIN SELECT RAISE(ABORT,'Source attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_views_no_update BEFORE UPDATE ON information_source_views BEGIN SELECT RAISE(ABORT,'Source views are immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_views_no_delete BEFORE DELETE ON information_source_views BEGIN SELECT RAISE(ABORT,'Source views are immutable'); END;`;

interface InformationManifest {
	sourceId: "wind-financials";
	companyTicker: string;
	rawPath: string;
	rawChecksum: string;
	viewChecksum: string;
	view: InformationView;
}
const queryValidator = Compile(InformationQuerySchema);
const sourceAdapters: Record<
	InformationQuery["sourceId"],
	{
		fetch: typeof queryWind;
		render: typeof renderWindFinancials;
		category: "financials";
		endpoint: string;
		tool: string;
		configured: () => boolean;
	}
> = {
	"wind-financials": {
		fetch: queryWind,
		render: renderWindFinancials,
		category: "financials",
		endpoint: "https://mcp.wind.com.cn/vserver_stock_data/mcp/",
		tool: "get_stock_fundamentals",
		configured: () => Boolean(windApiKey()),
	},
};
const transientSourceError =
	/ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|network|fetch failed|timed out|aborted due to timeout|WIND_HTTP_(?:502|503|504)/iu;
function sourceAccessError(message: string): boolean {
	if (/WIND_(?:HTTP_(?:401|402|403|429)|KEY_MISSING)/u.test(message)) return true;
	if (/WIND_HTTP_\d+/u.test(message)) return false;
	return /unauthorized|forbidden|quota|insufficient balance|authentication failed|invalid (?:api )?(?:key|token)|余额不足|额度|认证失败|鉴权失败/iu.test(
		message,
	);
}
export function availableInformationSources() {
	return INFORMATION_SOURCE_ADAPTERS.map((source) => {
		try {
			const available = sourceAdapters[source.id].configured();
			return { ...source, available, reason: available ? null : `服务端尚未配置 ${source.name} 凭证。` };
		} catch {
			return { ...source, available: false, reason: `无法读取服务端 ${source.name} 配置，请检查来源配置。` };
		}
	});
}
function database<T>(cwd: string, datasetId: string, action: (db: DatabaseSync) => T): T {
	return withResearchDatabase(cwd, datasetId, (db) => {
		db.exec(SCHEMA);
		return action(db);
	});
}
function active(db: DatabaseSync, run: FrameworkIteration): void {
	if (
		!db
			.prepare(
				"SELECT 1 FROM framework_iterations r JOIN research_frameworks f ON f.dataset_id=r.dataset_id WHERE r.id=? AND r.dataset_id=? AND r.status='running' AND r.lease_token=? AND r.lease_until>? AND f.current_version_id=?",
			)
			.get(run.id, run.datasetId, run.leaseToken, Date.now(), run.basisVersionId)
	)
		throw new ResearchError(409, "采集任务已取消、租约已过期或基线已变化。");
	if (!run.sourceConfig) throw new ResearchError(409, "缺少固定的信息源配置。");
	assertInformationSourceConfig(run.sourceConfig);
}
function archivePath(cwd: string, path: string): string {
	const root = realpathSync(cwd);
	const target = resolve(root, path);
	const rel = relative(root, target);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new ResearchError(403, "来源归档路径超出项目。");
	if (
		realpathSync(dirname(target)) !== dirname(target) ||
		lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()
	)
		throw new ResearchError(403, "来源归档不能使用符号链接。");
	return target;
}
function loadQueries(db: DatabaseSync, runId: string): InformationSourceQueryRecord[] {
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='framework_iteration_source_queries'").get()) return [];
	return db
		.prepare("SELECT query_json FROM framework_iteration_source_queries WHERE run_id=? ORDER BY rowid")
		.all(runId)
		.map((row) => {
			const record = JSON.parse(String(row.query_json)) as InformationSourceQueryRecord;
			record.attempts = db
				.prepare(
					"SELECT record_json FROM framework_iteration_source_attempts WHERE run_id=? AND query_id=? ORDER BY attempt_no",
				)
				.all(runId, record.id)
				.map((attempt) => JSON.parse(String(attempt.record_json)) as InformationSourceAttempt);
			return record;
		});
}
export function listInformationSourceQueries(
	cwd: string,
	datasetId: string,
	runId: string,
): InformationSourceQueryRecord[] {
	return database(cwd, datasetId, (db) => {
		if (!db.prepare("SELECT 1 FROM framework_iterations WHERE id=? AND dataset_id=?").get(runId, datasetId))
			throw new ResearchError(404, "来源运行不存在。");
		return loadQueries(db, runId);
	});
}
export function readInformationView(
	db: DatabaseSync,
	datasetId: string,
	docId: string,
): { document: SqlRow; text: string; manifest: InformationManifest; filePath: string } | undefined {
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='information_source_views'").get()) return undefined;
	const row = db
		.prepare(
			"SELECT d.*,v.manifest_json FROM documents d JOIN information_source_views v ON v.doc_id=d.doc_id AND v.dataset_id=d.dataset_id WHERE d.dataset_id=? AND d.doc_id=? AND d.deleted_at IS NULL AND d.parser_name='information_source_view'",
		)
		.get(datasetId, docId) as SqlRow | undefined;
	if (!row) return undefined;
	const main = db
		.prepare("PRAGMA database_list")
		.all()
		.find((value) => value.name === "main");
	if (!main?.file) throw new ResearchError(409, "来源视图必须使用项目数据库。");
	const root = dirname(dirname(String(main.file)));
	const filePath = documentFilePath(root, row);
	const text = readFileSync(filePath, "utf8");
	const manifest = JSON.parse(String(row.manifest_json)) as InformationManifest;
	if (
		informationHash(text) !== manifest.viewChecksum ||
		informationHash(text) !== row.checksum ||
		informationHash(readFileSync(archivePath(root, manifest.rawPath), "utf8")) !== manifest.rawChecksum
	)
		throw new ResearchError(409, "原始来源响应或证据视图已改变，请恢复原文件或新建运行。");
	return { document: row, text, manifest, filePath };
}

/** Return only this run's saved views, with exact per-field evidence locations. */
export function listIterationSourceData(cwd: string, datasetId: string, runId: string) {
	const queries = listInformationSourceQueries(cwd, datasetId, runId);
	return database(cwd, datasetId, (db) =>
		queries.flatMap((query) => {
			const attempt = query.attempts.find((value) => value.status === "saved" && value.viewDocId);
			if (!attempt?.viewDocId) return [];
			const docId = attempt.viewDocId;
			const view = readInformationView(db, datasetId, docId);
			if (!view) throw new ResearchError(409, "已采集的来源视图不可用。");
			return view.manifest.view.facts.map((fact) => ({
				...fact,
				quote: view.text.split("\n")[fact.line - 1],
				queryId: query.id,
				docId,
				fetchedAt: attempt.finishedAt,
				evidenceId: sourceId({ docId, location: { kind: "text", lineStart: fact.line, lineEnd: fact.line } }),
			}));
		}),
	);
}
export type IterationSourceData = ReturnType<typeof listIterationSourceData>[number];
export function readInformationViewRange(
	db: DatabaseSync,
	datasetId: string,
	docId: string,
	start = 1,
	end?: number,
	maxBytes = 16384,
) {
	const view = readInformationView(db, datasetId, docId);
	if (!view) throw new ResearchError(404, "来源证据视图不存在。");
	const lines = view.text.trimEnd().split("\n");
	const requestedEnd = end ?? Math.min(lines.length, start + 99);
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(requestedEnd) ||
		start < 1 ||
		requestedEnd < start ||
		requestedEnd > lines.length ||
		requestedEnd - start >= 2000
	)
		throw new ResearchError(400, "来源证据行范围无效。");
	const output: string[] = [];
	let bytes = 0;
	for (let line = start; line <= requestedEnd; line++) {
		const size = Buffer.byteLength(lines[line - 1]) + 1;
		if (bytes + size > maxBytes) break;
		output.push(lines[line - 1]);
		bytes += size;
	}
	if (!output.length) throw new ResearchError(413, "单行来源文本超过读取上限，请缩小来源查询。");
	const actualEnd = start + output.length - 1;
	return {
		file_type: "txt",
		original_filename: view.document.original_filename,
		text: output.join("\n"),
		totalLines: lines.length,
		lineStart: start,
		lineEnd: actualEnd,
		nextLineStart: actualEnd < lines.length ? actualEnd + 1 : null,
		truncated: actualEnd < requestedEnd,
		evidenceId: sourceId({ docId, location: { kind: "text", lineStart: start, lineEnd: actualEnd } }),
		sourceId: view.manifest.sourceId,
		companyTicker: view.manifest.companyTicker,
		viewVersion: view.manifest.view.version,
		locations: view.manifest.view.facts.filter((fact) => fact.line >= start && fact.line <= actualEnd),
		warnings: view.manifest.view.gaps,
		instruction:
			"这是供应商返回数据的确定性视图。报告期、单位和角色以各字段为准，查询参数不是事实证据；按nextLineStart继续读取。",
	};
}
export function sourceCollectionResult(
	cwd: string,
	datasetId: string,
	runId: string,
	summary: string,
	gaps: string[] = [],
): InformationCollection {
	const queries = listInformationSourceQueries(cwd, datasetId, runId);
	const saved = queries.flatMap((query) =>
		query.attempts.filter((attempt) => attempt.status === "saved" && attempt.viewDocId),
	);
	const warnings = [
		...new Set([
			...gaps,
			...queries.flatMap((query) => {
				const last = query.attempts.at(-1);
				return [
					...(last?.gaps ?? []),
					...(last && last.status === "saved"
						? []
						: [`${query.query.purpose}：${last?.error ?? "未获得有效财务数据"}`]),
				];
			}),
		]),
	];
	return {
		docIds: [...new Set(saved.map((attempt) => attempt.viewDocId!))],
		warnings,
		coverage: !saved.length ? "empty" : warnings.length ? "partial" : "complete",
		summary,
	};
}

/** A logical query reserves its quota before contacting the provider. Successful receipts are reusable. */
export async function fetchIterationInformation(
	cwd: string,
	datasetId: string,
	run: FrameworkIteration,
	input: unknown,
	signal: AbortSignal,
	fetcher?: (input: WindQuery, signal?: AbortSignal) => Promise<unknown>,
) {
	if (!queryValidator.Check(input)) throw new ResearchError(400, "信息源查询参数无效。");
	const query: InformationQuery = {
		...input,
		metrics: [...new Set(input.metrics.map((metric) => metric.trim()))].sort(),
		periods: [...new Set(input.periods.map((period) => period.trim()))].sort(),
		...(input.definitionChecks ? { definitionChecks: [...new Set(input.definitionChecks)].sort() } : {}),
	};
	if (query.metrics.some((metric) => !metric) || query.periods.some((period) => !period))
		throw new ResearchError(400, "指标和报告期不能为空或仅含空格。");
	const config = run.sourceConfig;
	if (!config) throw new ResearchError(409, "缺少信息源配置。");
	const adapter = sourceAdapters[query.sourceId];
	const executionStartedAt = database(cwd, datasetId, (db) =>
		String(
			db
				.prepare("SELECT started_at FROM framework_iteration_attempts WHERE run_id=? AND token=?")
				.get(run.id, run.leaseToken)?.started_at ?? "",
		),
	);
	const record = database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			active(db, run);
			const previous = loadQueries(db, run.id);
			const requestIdentity = JSON.stringify([
				query.sourceId,
				query.metrics,
				query.periods,
				query.currency ?? null,
				query.definitionChecks ?? [],
			]);
			const sameRequest = previous.find(
				(record) =>
					JSON.stringify([
						record.query.sourceId,
						record.query.metrics,
						record.query.periods,
						record.query.currency ?? null,
						record.query.definitionChecks ?? [],
					]) === requestIdentity,
			);
			if (sameRequest) return sameRequest;
			const actualPeriods = [...(previous.length ? query.periods : config.defaultPeriods)];
			if (!config.trackingWindow) actualPeriods.sort();
			const definitions: Record<string, string> = {
				period: "每个指标的报告期和单季/累计统计口径",
				currency: "每个指标的记账币种和计量单位",
				scope: "每个指标的合并/母公司/分部/调整后报表口径",
				role: "每个指标的实际/预测数据类型",
				definition: "每个指标的字段定义，净利润区分集团整体与归母，营业利润区分会计营业利润与EBIT",
			};
			const checks =
				query.definitionChecks ?? (config.queryPolicy ? ["period", "currency", "scope", "role", "definition"] : []);
			const definitionRequest = checks.length
				? `若有，附${checks.map((check) => definitions[check]).join("、")}；缺失说明项留空，保留已取得的财务数值，不补写未知定义。`
				: "";
			const actualQuery = `查询${config.companyName}（${config.companyTicker}）${actualPeriods.join("、")}的${query.metrics.join("、")}。${query.currency ? `金额使用${query.currency}。` : ""}保留证券代码、报告期、原始单位、币种、业务名称和报表类型。若有，返回发布日期、实际或预测标识、单季或累计口径、原始来源链接。${config.trackingWindow ? `仅返回截至${config.trackingWindow.asOf}已披露的数据，当前季度尚未结束或未披露时返回空。` : ""}没有数据返回空，不推算数值。${definitionRequest}`;
			if (actualQuery.length > 2000)
				throw new ResearchError(400, "查询内容超过 Wind 上限，请缩小指标和报告期范围。");
			const id = informationHash(JSON.stringify([query.sourceId, actualQuery]));
			const existing = previous.find((value) => value.id === id);
			if (existing) return existing;
			if (previous.length >= config.maxQueries)
				throw new ResearchError(409, "本轮已达到4个不同业务查询上限；请使用已取得的证据完成采集。");
			if (
				previous.some((value) =>
					value.attempts.some(
						(attempt) =>
							attempt.executionStartedAt === executionStartedAt && sourceAccessError(attempt.error ?? ""),
					),
				)
			)
				throw new ResearchError(409, "Wind授权或额度异常，本次执行不再发起外部调用；重新授权后可手动恢复。");
			const value: InformationSourceQueryRecord = {
				id,
				runId: run.id,
				query,
				actualQuery,
				actualPeriods,
				createdAt: new Date().toISOString(),
				attempts: [],
			};
			db.prepare("INSERT INTO framework_iteration_source_queries VALUES(?,?,?)").run(
				run.id,
				id,
				JSON.stringify(value),
			);
			return value;
		}),
	);
	const { id, actualQuery } = record;
	const prior = record.attempts.find((attempt) => attempt.status === "saved");
	if (prior?.viewDocId) {
		const docId = prior.viewDocId;
		return database(cwd, datasetId, (db) => ({
			reused: true,
			queryId: id,
			...readInformationViewRange(db, datasetId, docId),
			docId,
		}));
	}
	const last = record.attempts.at(-1);
	if (last?.status === "empty" && last.executionStartedAt === executionStartedAt)
		return { queryId: id, status: "empty", gaps: last.gaps };
	if (
		last?.status === "failed" &&
		last.executionStartedAt === executionStartedAt &&
		!transientSourceError.test(last.error ?? "")
	)
		return { queryId: id, status: "failed", error: last.error };
	for (;;) {
		signal.throwIfAborted();
		const attempt = database(cwd, datasetId, (db) =>
			researchTransaction(db, () => {
				active(db, run);
				const queries = loadQueries(db, run.id);
				if (
					queries.some((query) =>
						query.attempts.some(
							(value) => value.executionStartedAt === executionStartedAt && sourceAccessError(value.error ?? ""),
						),
					)
				)
					throw new ResearchError(409, "Wind授权或额度异常，本次执行不再发起外部调用；重新授权后可手动恢复。");
				const current = queries.find((value) => value.id === id)!;
				const unfinished = current.attempts.at(-1);
				if (unfinished?.status === "running" && unfinished.executionStartedAt === executionStartedAt)
					throw new ResearchError(409, "相同来源查询正在执行中，请勿重复发起。");
				if (unfinished?.status === "running") {
					unfinished.status = "interrupted";
					unfinished.error = "请求中断；供应商可能已执行，无法确认是否计费。";
					unfinished.finishedAt = new Date().toISOString();
					db.prepare(
						"UPDATE framework_iteration_source_attempts SET finished_at=?,record_json=? WHERE id=? AND finished_at IS NULL",
					).run(unfinished.finishedAt, JSON.stringify(unfinished), unfinished.id);
				}
				if (current.attempts.length >= 3)
					throw new ResearchError(409, "该查询已达到最多两次网络重试上限，恢复不会重置计数。");
				const value: InformationSourceAttempt = {
					id: randomUUID(),
					number: current.attempts.length + 1,
					startedAt: new Date().toISOString(),
					finishedAt: null,
					status: "running",
					error: null,
					executionStartedAt,
				};
				db.prepare("INSERT INTO framework_iteration_source_attempts VALUES(?,?,?,?,NULL,?)").run(
					value.id,
					run.id,
					id,
					value.number,
					JSON.stringify(value),
				);
				return value;
			}),
		);
		try {
			const response = await (fetcher ?? adapter.fetch)({ category: adapter.category, query: actualQuery }, signal);
			signal.throwIfAborted();
			database(cwd, datasetId, (db) => active(db, run));
			const folder = join(cwd, "meta", "information-sources", run.id, id);
			mkdirSync(folder, { recursive: true });
			const rawPath = relative(cwd, join(folder, `${attempt.id}.json`));
			const raw = JSON.stringify(
				{
					provider: "wind",
					category: adapter.category,
					endpoint: adapter.endpoint,
					tool: adapter.tool,
					query: actualQuery,
					fetchedAt: new Date().toISOString(),
					response,
				},
				null,
				2,
			);
			writeFileSync(archivePath(cwd, rawPath), raw, { flag: "wx", mode: 0o600 });
			const rendered = adapter.render(response, config.companyTicker);
			attempt.rawPath = rawPath;
			attempt.rawChecksum = informationHash(raw);
			attempt.gaps = rendered.gaps;
			attempt.metrics = rendered.facts.map((fact) => fact.metric);
			if (
				query.currency &&
				rendered.facts.some(
					(fact) =>
						typeof fact.value === "number" &&
						fact.currency &&
						informationCurrencyCode(fact.currency) !== query.currency,
				)
			)
				attempt.gaps.push(
					`查询请求${query.currency}计量，但部分返回字段使用其他币种；以返回字段为准，不认定供应商误标，不擅自换汇。`,
				);
			for (const metric of query.metrics)
				if (!rendered.facts.some((fact) => fact.metric.toLowerCase().includes(metric.toLowerCase())))
					attempt.gaps.push(`查询所需指标“${metric}”未在返回列名中确认，不能声明该项已覆盖。`);
			if (rendered.usable) {
				const checksum = informationHash(rendered.text);
				const {
					documents: [document],
				} = registerPeDocuments(cwd, datasetId, [
					{ name: `Source-Wind-${config.companyTicker}-${checksum}.txt`, bytes: Buffer.from(rendered.text) },
				]);
				const manifest: InformationManifest = {
					sourceId: "wind-financials",
					companyTicker: config.companyTicker,
					rawPath,
					rawChecksum: attempt.rawChecksum,
					viewChecksum: checksum,
					view: rendered,
				};
				database(cwd, datasetId, (db) =>
					researchTransaction(db, () => {
						active(db, run);
						db.prepare("INSERT OR IGNORE INTO information_source_views VALUES(?,?,?)").run(
							document.doc_id,
							datasetId,
							JSON.stringify(manifest),
						);
						db.prepare(
							"UPDATE documents SET status='completed',parser_name='information_source_view',parser_version=?,readable_text_path=raw_path WHERE doc_id=? AND dataset_id=? AND status='queued'",
						).run(config.viewVersion, document.doc_id, datasetId);
					}),
				);
				attempt.viewDocId = String(document.doc_id);
				attempt.viewChecksum = checksum;
				attempt.status = "saved";
				attempt.evidenceId = database(
					cwd,
					datasetId,
					(db) => readInformationViewRange(db, datasetId, String(document.doc_id)).evidenceId,
				);
			} else attempt.status = "empty";
		} catch (error) {
			attempt.status = "failed";
			attempt.error = error instanceof Error ? error.message : "来源查询失败。";
		}
		attempt.finishedAt = new Date().toISOString();
		attempt.elapsedMs = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);
		database(cwd, datasetId, (db) =>
			db
				.prepare(
					"UPDATE framework_iteration_source_attempts SET finished_at=?,record_json=? WHERE id=? AND finished_at IS NULL",
				)
				.run(attempt.finishedAt, JSON.stringify(attempt), attempt.id),
		);
		signal.throwIfAborted();
		database(cwd, datasetId, (db) => active(db, run));
		if (attempt.viewDocId)
			return database(cwd, datasetId, (db) => ({
				queryId: id,
				docId: attempt.viewDocId,
				status: "saved",
				...readInformationViewRange(db, datasetId, attempt.viewDocId!),
			}));
		if (attempt.number < 3 && transientSourceError.test(attempt.error ?? "")) {
			await delay(1000 * attempt.number, undefined, { signal });
			continue;
		}
		return { queryId: id, status: attempt.status, error: attempt.error, gaps: attempt.gaps };
	}
}
export function readIterationSourceArchive(
	cwd: string,
	datasetId: string,
	runId: string,
	queryId: string,
	kind: "raw" | "text",
): string {
	const query = listInformationSourceQueries(cwd, datasetId, runId).find((value) => value.id === queryId);
	const attempt = [...(query?.attempts ?? [])].reverse().find((value) => value.rawPath);
	if (!attempt?.rawPath) throw new ResearchError(404, "该查询没有已归档响应。");
	if (kind === "raw") {
		const text = readFileSync(archivePath(cwd, attempt.rawPath), "utf8");
		if (informationHash(text) !== attempt.rawChecksum) throw new ResearchError(409, "来源归档已改变。");
		return text;
	}
	if (!attempt.viewDocId) throw new ResearchError(404, "该查询没有有效证据视图。");
	return database(cwd, datasetId, (db) => readInformationView(db, datasetId, attempt.viewDocId!)!.text);
}
