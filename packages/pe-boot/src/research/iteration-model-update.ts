import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { validatePeExcelUpload } from "../excel-processing.ts";
import { currentModelVersionId, modelVersionRow, withModelUpdateDatabase } from "../model-update-storage.ts";
import { sourceId } from "../source.ts";
import type { SqlRow } from "../tools/database.ts";
import {
	applyPeModelUpdate,
	type PeModelUpdateChange,
	type PeModelUpdateManifest,
	reviewPeModelVersion,
} from "../tools/model-update.ts";
import { readWorkbookFile, type WorkbookRequest } from "../workbook-reader.ts";
import { captureResearchInputs, currentResearchVersion, getResearchFramework } from "./framework.ts";
import { getFrameworkIteration, validateIterationAnalysis } from "./iteration.ts";
import { type FrameworkIteration, validateIterationImpacts, validateIterationObservations } from "./iteration-model.ts";
import { isFrameworkDocument, ResearchError } from "./model.ts";
import { researchTransaction, withResearchDatabase } from "./storage.ts";

const text = Type.String({ minLength: 1, maxLength: 500, pattern: "\\S" });
const cell = Type.String({ pattern: "^[A-Z]{1,3}[1-9][0-9]{0,6}$" });
const value = Type.Union([Type.Number(), Type.String({ maxLength: 8000 }), Type.Boolean(), Type.Null()]);
const location = { key: text, sheet: text, cell };
const mappingSchema = Type.Object(
	{
		id: text,
		subject: text,
		metric: text,
		sourceField: Type.Optional(text),
		period: text,
		periodKind: Type.Union([Type.Literal("single"), Type.Literal("cumulative"), Type.Literal("point_in_time")]),
		asOf: Type.Union([text, Type.Null()]),
		unit: text,
		scope: text,
		currency: Type.Union([text, Type.Null()]),
		role: Type.Union([Type.Literal("actual"), Type.Literal("assumption")]),
		sheet: text,
		cell,
		expectedValue: value,
		judgmentIds: Type.Optional(Type.Array(text, { maxItems: 100 })),
		sensitivity: Type.Optional(text),
	},
	{ additionalProperties: false },
);
export const IterationModelConfigInputSchema = Type.Object(
	{
		expectedRevision: Type.Integer({ minimum: 0 }),
		docId: text,
		baseVersionId: Type.Union([text, Type.Null()]),
		valuationDate: Type.Optional(Type.String({ pattern: "^20\\d{2}-\\d{2}-\\d{2}$" })),
		mappings: Type.Array(mappingSchema, { minItems: 1, maxItems: 200 }),
		outputs: Type.Optional(Type.Array(Type.Object(location, { additionalProperties: false }), { maxItems: 50 })),
		checks: Type.Optional(
			Type.Array(
				Type.Object(
					{ ...location, expectedValue: value, tolerance: Type.Optional(Type.Number({ minimum: 0 })) },
					{ additionalProperties: false },
				),
				{ maxItems: 50 },
			),
		),
	},
	{ additionalProperties: false },
);
const configValidator = Compile(IterationModelConfigInputSchema);
export type IterationModelMapping = Static<typeof mappingSchema>;
export type SaveIterationModelConfigInput = Static<typeof IterationModelConfigInputSchema>;
export interface IterationModelConfig extends Omit<SaveIterationModelConfigInput, "expectedRevision"> {
	revision: number;
	datasetId: string;
	documentSha256: string;
	baselineSha256: string;
	updatedAt: string;
}
export interface IterationModelSkip {
	observationId: string | null;
	mappingId: string | null;
	reason: string;
}
export interface IterationModelProposal extends PeModelUpdateChange {
	mappingId: string;
	observationId: string;
}
export interface IterationModelPromotionReceipt {
	datasetId: string;
	runId: string;
	docId: string;
	oldModelVersionId: string | null;
	newModelVersionId: string;
	configRevisionBefore: number;
	configRevisionAfter: number;
	promotedAt: string;
	actor: string;
}
export interface IterationModelUpdateResult {
	runId: string;
	datasetId: string;
	status: "not_configured" | "running" | "no_change" | "candidate" | "unavailable" | "cancelled";
	configRevision: number | null;
	docId: string | null;
	baseVersionId: string | null;
	modelVersionId: string | null;
	proposal: IterationModelProposal[];
	manualProposals: IterationModelProposal[];
	skips: IterationModelSkip[];
	manifest: PeModelUpdateManifest | null;
	promotionReceipt: IterationModelPromotionReceipt | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}
export interface IterationModelUpdateDependencies {
	apply?: typeof applyPeModelUpdate;
}
export interface IterationModelBaseline {
	runId: string;
	config: IterationModelConfig | null;
	error: string | null;
}

const schema = `
CREATE TABLE IF NOT EXISTS iteration_model_configs(dataset_id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS iteration_model_baselines(dataset_id TEXT NOT NULL, run_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(dataset_id,run_id));
CREATE TRIGGER IF NOT EXISTS iteration_model_baselines_no_update BEFORE UPDATE ON iteration_model_baselines BEGIN SELECT RAISE(ABORT,'Model baseline snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS iteration_model_baselines_no_delete BEFORE DELETE ON iteration_model_baselines BEGIN SELECT RAISE(ABORT,'Model baseline snapshots are immutable'); END;
CREATE TABLE IF NOT EXISTS iteration_model_results(dataset_id TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL, lease_until INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(dataset_id,run_id));
CREATE TABLE IF NOT EXISTS iteration_model_promotions(dataset_id TEXT NOT NULL, run_id TEXT NOT NULL, receipt_json TEXT NOT NULL, PRIMARY KEY(dataset_id,run_id), FOREIGN KEY(dataset_id,run_id) REFERENCES iteration_model_results(dataset_id,run_id));
CREATE TRIGGER IF NOT EXISTS iteration_model_promotions_no_update BEFORE UPDATE ON iteration_model_promotions BEGIN SELECT RAISE(ABORT,'Model promotion receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS iteration_model_promotions_no_delete BEFORE DELETE ON iteration_model_promotions BEGIN SELECT RAISE(ABORT,'Model promotion receipts are immutable'); END;
`;

function argumentsValid(cwd: string, datasetId: string, ...runIds: string[]): void {
	for (const entry of [cwd, datasetId, ...runIds])
		if (typeof entry !== "string" || !entry.trim() || entry.length > 4096 || entry.includes("\0"))
			throw new ResearchError(400, "Invalid model update identity");
}

function database<Result>(cwd: string, datasetId: string, action: (connection: DatabaseSync) => Result): Result {
	argumentsValid(cwd, datasetId);
	return withModelUpdateDatabase(cwd, datasetId, (connection) => {
		connection.exec(schema);
		return action(connection);
	});
}

function hash(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function workbook(cwd: string, storedPath: string, sha256: string, directory: "raw" | "generated/model-updates") {
	const root = realpathSync(cwd);
	const candidate = resolve(root, storedPath);
	const allowed = join(root, directory);
	const local = relative(allowed, candidate);
	if (
		!local ||
		local.startsWith("..") ||
		isAbsolute(local) ||
		realpathSync(candidate) !== candidate ||
		extname(candidate) !== ".xlsx" ||
		!statSync(candidate).isFile()
	)
		throw new ResearchError(403, "Workbook must be a regular .xlsx file inside its project root without symlinks");
	const bytes = readFileSync(candidate);
	if (!/^[a-f0-9]{64}$/u.test(sha256) || hash(bytes) !== sha256)
		throw new ResearchError(409, "Workbook SHA256 changed");
	validatePeExcelUpload(bytes, "xlsx");
	return {
		bytes,
		filename: basename(candidate),
		sha256,
		contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const,
	};
}

function source(cwd: string, connection: DatabaseSync, datasetId: string, docId: string, baseVersionId: string | null) {
	const document = connection
		.prepare(
			"SELECT * FROM documents WHERE dataset_id=? AND doc_id=? AND is_current=1 AND lifecycle_state='active' AND deleted_at IS NULL",
		)
		.get(datasetId, docId) as SqlRow | undefined;
	if (!document || document.file_type !== "xlsx")
		throw new ResearchError(409, "Register a current .xlsx model document first");
	const documentSha256 = String(document.checksum || document.sha256);
	workbook(cwd, String(document.stored_path || document.raw_path), documentSha256, "raw");
	if ((currentModelVersionId(connection, datasetId, docId) ?? null) !== baseVersionId)
		throw new ResearchError(409, "Model baseline version changed");
	const row = baseVersionId ? modelVersionRow(connection, datasetId, docId, baseVersionId) : undefined;
	if (baseVersionId && (!row || row.state === "unavailable" || row.review_decision === "rejected"))
		throw new ResearchError(409, "Model baseline is unavailable");
	if (row) workbook(cwd, row.file_relpath, row.file_sha256, "generated/model-updates");
	return { documentSha256, baselineSha256: row?.file_sha256 ?? documentSha256 };
}

function loadConfig(connection: DatabaseSync, datasetId: string): IterationModelConfig | null {
	const row = connection.prepare("SELECT config_json FROM iteration_model_configs WHERE dataset_id=?").get(datasetId);
	return row ? (JSON.parse(String(row.config_json)) as IterationModelConfig) : null;
}

export function getIterationModelConfig(cwd: string, datasetId: string): IterationModelConfig | null {
	return database(cwd, datasetId, (connection) => loadConfig(connection, datasetId));
}

export function readCurrentIterationWorkbook(
	cwd: string,
	datasetId: string,
	docId: string,
	request: WorkbookRequest,
): Record<string, unknown> {
	return database(cwd, datasetId, (db) => {
		const baseVersionId = currentModelVersionId(db, datasetId, docId) ?? null;
		const baseline = source(cwd, db, datasetId, docId, baseVersionId);
		const row = baseVersionId ? modelVersionRow(db, datasetId, docId, baseVersionId) : undefined;
		const document = db
			.prepare("SELECT original_filename,stored_path,raw_path FROM documents WHERE dataset_id=? AND doc_id=?")
			.get(datasetId, docId)!;
		const path = String(row?.file_relpath || document.stored_path || document.raw_path);
		const result = readWorkbookFile(join(cwd, path), request, baseline.baselineSha256);
		for (const key of ["cells", "nodes"]) {
			if (Array.isArray(result[key]))
				result[key] = result[key].map((cell: Record<string, unknown>) => ({
					...cell,
					evidence_id: sourceId({
						docId,
						location: { kind: "excel", sheet: String(cell.sheet_name), range: String(cell.cell_ref) },
					}),
				}));
		}
		return {
			...result,
			file_type: "xlsx",
			doc_id: docId,
			original_filename: document.original_filename,
			model_version_id: baseVersionId,
		};
	});
}

export function saveIterationModelConfig(
	cwd: string,
	datasetId: string,
	input: SaveIterationModelConfigInput,
): IterationModelConfig {
	if (!configValidator.Check(input) || !Number.isSafeInteger(input.expectedRevision))
		throw new ResearchError(400, "Invalid model baseline configuration");
	const identities = new Set<string>();
	const cells = new Set<string>();
	for (const mapping of input.mappings) {
		if (identities.has(mapping.id) || cells.has(`${mapping.sheet}\0${mapping.cell}`))
			throw new ResearchError(400, "Duplicate model mapping ID or cell");
		identities.add(mapping.id);
		cells.add(`${mapping.sheet}\0${mapping.cell}`);
		if (
			(typeof mapping.expectedValue === "number" && !Number.isFinite(mapping.expectedValue)) ||
			(typeof mapping.expectedValue === "string" && mapping.expectedValue.startsWith("="))
		)
			throw new ResearchError(400, "Expected model value must be a finite literal, not a formula");
	}
	for (const entry of [...input.mappings, ...(input.outputs ?? []), ...(input.checks ?? [])]) {
		const column = entry.cell.match(/^[A-Z]+/u)![0];
		const columnNumber = [...column].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
		if (
			columnNumber > 16384 ||
			Number(entry.cell.slice(column.length)) > 1048576 ||
			entry.sheet.length > 31 ||
			/[\\/?*[\]:]/u.test(entry.sheet)
		)
			throw new ResearchError(400, "Invalid Excel location");
	}
	return database(cwd, datasetId, (connection) =>
		researchTransaction(connection, () => {
			const prior = loadConfig(connection, datasetId);
			if ((prior?.revision ?? 0) !== input.expectedRevision)
				throw new ResearchError(409, "Model configuration revision changed");
			const { expectedRevision, ...fields } = input;
			const config: IterationModelConfig = {
				...fields,
				...source(cwd, connection, datasetId, input.docId, input.baseVersionId),
				datasetId,
				revision: expectedRevision + 1,
				updatedAt: new Date().toISOString(),
			};
			connection
				.prepare(
					"INSERT INTO iteration_model_configs VALUES(?,?) ON CONFLICT(dataset_id) DO UPDATE SET config_json=excluded.config_json",
				)
				.run(datasetId, JSON.stringify(config));
			return config;
		}),
	);
}

export function freezeIterationModelBaseline(cwd: string, datasetId: string, runId: string): IterationModelBaseline {
	argumentsValid(cwd, datasetId, runId);
	const run = getFrameworkIteration(cwd, datasetId, runId);
	return database(cwd, datasetId, (connection) =>
		researchTransaction(connection, () => {
			const previous = connection
				.prepare("SELECT record_json FROM iteration_model_baselines WHERE dataset_id=? AND run_id=?")
				.get(datasetId, runId);
			if (previous) return JSON.parse(String(previous.record_json)) as IterationModelBaseline;
			const config = loadConfig(connection, datasetId);
			const error =
				config &&
				config.updatedAt > run.createdAt &&
				!(run.automaticSetup && run.preparedModelRevision === config.revision)
					? "Model configuration postdates this iteration; create a new iteration"
					: null;
			const result = { runId, config, error };
			connection
				.prepare("INSERT INTO iteration_model_baselines VALUES(?,?,?)")
				.run(datasetId, runId, JSON.stringify(result));
			return result;
		}),
	);
}

function loadResult(connection: DatabaseSync, datasetId: string, runId: string): IterationModelUpdateResult | null {
	const row = connection
		.prepare("SELECT record_json FROM iteration_model_results WHERE dataset_id=? AND run_id=?")
		.get(datasetId, runId);
	if (!row) return null;
	const receipt = connection
		.prepare("SELECT receipt_json FROM iteration_model_promotions WHERE dataset_id=? AND run_id=?")
		.get(datasetId, runId);
	return {
		...(JSON.parse(String(row.record_json)) as IterationModelUpdateResult),
		promotionReceipt: receipt ? (JSON.parse(String(receipt.receipt_json)) as IterationModelPromotionReceipt) : null,
	};
}

export function getIterationModelUpdateResult(
	cwd: string,
	datasetId: string,
	runId: string,
): IterationModelUpdateResult | null {
	argumentsValid(cwd, datasetId, runId);
	getFrameworkIteration(cwd, datasetId, runId);
	return database(cwd, datasetId, (connection) =>
		researchTransaction(connection, () => reconcileResult(connection, datasetId, runId)),
	);
}

function reconcileResult(
	connection: DatabaseSync,
	datasetId: string,
	runId: string,
): IterationModelUpdateResult | null {
	const result = loadResult(connection, datasetId, runId);
	if (!result || result.status !== "running") return result;
	const lease = connection
		.prepare("SELECT lease_until FROM iteration_model_results WHERE dataset_id=? AND run_id=?")
		.get(datasetId, runId);
	if (Number(lease?.lease_until) > Date.now()) return result;
	result.status = "unavailable";
	result.error = "Model delivery interrupted; an uncertain write is never repeated automatically";
	if (result.docId) {
		const versionId = `request-${hash(`${result.docId}\0iteration_${runId}`)}`;
		const row = modelVersionRow(connection, datasetId, result.docId, versionId);
		if (row) {
			result.modelVersionId = row.version_id;
			result.manifest = JSON.parse(row.manifest_json) as PeModelUpdateManifest;
		}
	}
	return finish(connection, result);
}

function assertFresh(
	cwd: string,
	datasetId: string,
	runId: string,
	config: IterationModelConfig,
	signature?: string,
): FrameworkIteration {
	const run = getFrameworkIteration(cwd, datasetId, runId);
	if (!["review_required", "published", "no_change"].includes(run.status))
		throw new ResearchError(409, `Iteration is not ready for a model delivery: ${run.status}`);
	database(cwd, datasetId, (connection) => {
		if (loadConfig(connection, datasetId)?.revision !== config.revision)
			throw new ResearchError(409, "Frozen model configuration revision is stale");
		const current = source(cwd, connection, datasetId, config.docId, config.baseVersionId);
		if (current.documentSha256 !== config.documentSha256 || current.baselineSha256 !== config.baselineSha256)
			throw new ResearchError(409, "Frozen model baseline changed");
	});
	withResearchDatabase(cwd, datasetId, (connection) => {
		if (
			run.monitorRunId &&
			!connection
				.prepare(`SELECT 1 FROM research_monitor_runs r JOIN research_monitor_plans p ON p.dataset_id=r.dataset_id
		 WHERE r.dataset_id=? AND r.run_id=? AND r.plan_revision=p.revision AND r.status='running' AND r.lease_until>?
		 AND json_extract(p.config_json,'$.updatePolicy')='direct' AND json_extract(p.config_json,'$.mode')='auto'`)
				.get(datasetId, run.monitorRunId, Date.now())
		)
			throw new ResearchError(409, "更新设置已改变，模型原版本保留。");
		const current = currentResearchVersion(connection, datasetId);
		if (current !== (run.status === "published" ? run.versionId : run.basisVersionId))
			throw new ResearchError(409, "Framework baseline changed");
		if (
			JSON.stringify(
				captureResearchInputs(
					connection,
					datasetId,
					run.inputs.map((entry) => entry.docId),
				),
			) !== JSON.stringify(run.inputs)
		)
			throw new ResearchError(409, "Iteration evidence changed");
	});
	if (signature && analysisSignature(run) !== signature) throw new ResearchError(409, "Iteration analysis changed");
	return run;
}

function analysisSignature(run: FrameworkIteration): string {
	return hash(JSON.stringify(run.artifacts.filter((entry) => ["extract", "impact"].includes(entry.stage))));
}

function proposals(
	cwd: string,
	datasetId: string,
	run: FrameworkIteration,
	config: IterationModelConfig,
	result: IterationModelUpdateResult,
): void {
	if (
		run.status === "no_change" &&
		!run.newDocIds.length &&
		!run.artifacts.some((entry) => entry.stage === "extract" || entry.stage === "impact")
	) {
		result.skips.push({ observationId: null, mappingId: null, reason: "nothing_new" });
		return;
	}
	const observations = validateIterationObservations(run.artifacts.find((entry) => entry.stage === "extract")?.value);
	const impacts = validateIterationImpacts(run.artifacts.find((entry) => entry.stage === "impact")?.value);
	const basis = getResearchFramework(cwd, datasetId).versions.find(
		(entry) => entry.id === run.basisVersionId,
	)?.content;
	if (!basis || !isFrameworkDocument(basis)) throw new ResearchError(409, "Missing framework baseline");
	withResearchDatabase(cwd, datasetId, (connection) =>
		validateIterationAnalysis(connection, run, basis, observations, impacts),
	);
	const matches = new Map<string, IterationModelProposal[]>();
	for (const observation of observations.observations) {
		const mappings = config.mappings.filter(
			(mapping) =>
				mapping.subject === observation.subject &&
				mapping.metric === observation.metric &&
				mapping.period === observation.period &&
				mapping.periodKind === observation.context.periodKind &&
				mapping.asOf === observation.context.asOf &&
				mapping.unit === observation.unit &&
				mapping.scope === observation.context.scope &&
				(mapping.sourceField === undefined || mapping.sourceField === observation.sourceField),
		);
		let reason: string | null = null;
		const mapping = mappings[0];
		const linked = impacts.impacts.filter((impact) => impact.observationIds.includes(observation.id));
		if (mappings.length !== 1) reason = mappings.length ? "ambiguous_mapping" : "no_exact_mapping";
		else if (
			observation.gaps.length ||
			observation.context.reviewReasons.length ||
			observation.context.eventKind !== "none"
		)
			reason = "uncertain_observation";
		else if (typeof observation.value !== "number" || !Number.isFinite(observation.value))
			reason = "non_numeric_observation";
		else if (mapping.role === "assumption" && typeof mapping.expectedValue !== "number")
			reason = "non_numeric_baseline";
		else if (!mapping.currency && /元|币|dollar|USD|CNY|RMB|HKD|EUR|GBP|JPY|[$€£¥]/iu.test(mapping.unit))
			reason = "currency_not_confirmed";
		else if (
			!["fact", "forecast", "guidance"].includes(observation.role) ||
			(mapping.role === "actual" && observation.role !== "fact")
		)
			reason = "unknown_or_incompatible_role";
		else if (
			!linked.length ||
			linked.some(
				(impact) =>
					!impact.comparable ||
					["unresolved", "unrelated"].includes(impact.relation) ||
					impact.comparisonBasis?.period !== mapping.period ||
					impact.comparisonBasis?.periodKind !== mapping.periodKind ||
					impact.comparisonBasis?.scope !== mapping.scope ||
					(impact.comparisonBasis?.currency ?? null) !== mapping.currency ||
					!observation.evidenceIds.every((id) => impact.evidenceIds.includes(id)),
			)
		)
			reason = "unresolved_or_incompatible_impact";
		if (reason) {
			result.skips.push({
				observationId: observation.id,
				mappingId: mappings.length === 1 ? mapping.id : null,
				reason,
			});
			continue;
		}
		const proposal: IterationModelProposal = {
			mappingId: mapping.id,
			observationId: observation.id,
			sheet: mapping.sheet,
			cell: mapping.cell,
			expectedValue: mapping.expectedValue,
			newValue: observation.value,
			kind: mapping.role,
			metricId: mapping.id,
			evidenceIds: [...observation.evidenceIds],
			reason: linked.map((impact) => impact.reason).join("\n"),
		};
		matches.set(mapping.id, [...(matches.get(mapping.id) ?? []), proposal]);
	}
	for (const mapping of config.mappings) {
		const candidates = matches.get(mapping.id) ?? [];
		if (!candidates.length) {
			if (!result.skips.some((skip) => skip.mappingId === mapping.id))
				result.skips.push({ mappingId: mapping.id, observationId: null, reason: "no_matching_observation" });
		} else if (candidates.length > 1) {
			for (const candidate of candidates)
				result.skips.push({
					mappingId: mapping.id,
					observationId: candidate.observationId,
					reason: "ambiguous_observations",
				});
		} else if (candidates[0].newValue === mapping.expectedValue) {
			result.skips.push({
				mappingId: mapping.id,
				observationId: candidates[0].observationId,
				reason: "unchanged_value",
			});
		} else if (
			mapping.role === "assumption" &&
			(!run.monitorRunId ||
				!["fact", "forecast", "guidance"].includes(
					observations.observations.find((observation) => observation.id === candidates[0].observationId)!.role,
				))
		) {
			result.manualProposals.push(candidates[0]);
			result.skips.push({
				mappingId: mapping.id,
				observationId: candidates[0].observationId,
				reason: "assumption_requires_human_decision",
			});
		} else result.proposal.push(candidates[0]);
	}
}

function finish(connection: DatabaseSync, result: IterationModelUpdateResult): IterationModelUpdateResult {
	result.updatedAt = new Date().toISOString();
	connection
		.prepare(
			"UPDATE iteration_model_results SET status=?,lease_until=0,record_json=? WHERE dataset_id=? AND run_id=? AND status='running'",
		)
		.run(result.status, JSON.stringify(result), result.datasetId, result.runId);
	const stored = loadResult(connection, result.datasetId, result.runId)!;
	if (stored.status === "unavailable" && !stored.modelVersionId && result.modelVersionId && result.manifest) {
		stored.modelVersionId = result.modelVersionId;
		stored.manifest = result.manifest;
		connection
			.prepare(
				"UPDATE iteration_model_results SET record_json=? WHERE dataset_id=? AND run_id=? AND status='unavailable'",
			)
			.run(JSON.stringify(stored), result.datasetId, result.runId);
	}
	return stored;
}

function acceptManifest(cwd: string, result: IterationModelUpdateResult, manifest: PeModelUpdateManifest): void {
	result.modelVersionId = manifest.version_id;
	result.manifest = manifest;
	if (
		manifest.dataset_id !== result.datasetId ||
		manifest.doc_id !== result.docId ||
		manifest.parent_version_id !== result.baseVersionId ||
		manifest.promoted ||
		!manifest.source.unchanged ||
		!manifest.validation.recalculated ||
		manifest.validation.hard_errors.length ||
		manifest.validation.new_error_cells.length ||
		manifest.validation.checks.some((check) => !check.passed) ||
		manifest.state === "unavailable"
	)
		throw new ResearchError(409, manifest.validation.hard_errors.join("; ") || "Model delivery validation failed");
	workbook(cwd, manifest.file.path, manifest.file.sha256, "generated/model-updates");
	result.status = "candidate";
}

export async function executeIterationModelUpdate(
	cwd: string,
	datasetId: string,
	runId: string,
	signal: AbortSignal,
	dependencies: IterationModelUpdateDependencies = {},
): Promise<IterationModelUpdateResult> {
	argumentsValid(cwd, datasetId, runId);
	if (
		!(signal instanceof AbortSignal) ||
		!dependencies ||
		typeof dependencies !== "object" ||
		Array.isArray(dependencies) ||
		(dependencies.apply !== undefined && typeof dependencies.apply !== "function") ||
		Object.keys(dependencies).some((key) => key !== "apply")
	)
		throw new ResearchError(400, "Invalid model execution dependencies or signal");
	const frozen = freezeIterationModelBaseline(cwd, datasetId, runId);
	const config = frozen.config;
	const at = new Date().toISOString();
	let result: IterationModelUpdateResult = {
		runId,
		datasetId,
		status: "running",
		configRevision: config?.revision ?? null,
		docId: config?.docId ?? null,
		baseVersionId: config?.baseVersionId ?? null,
		modelVersionId: null,
		proposal: [],
		manualProposals: [],
		skips: [],
		manifest: null,
		promotionReceipt: null,
		error: null,
		createdAt: at,
		updatedAt: at,
	};
	const prior = database(cwd, datasetId, (connection) =>
		researchTransaction(connection, () => {
			const existing = reconcileResult(connection, datasetId, runId);
			if (existing) return existing;
			connection
				.prepare("INSERT INTO iteration_model_results VALUES(?,?,?, ?,?)")
				.run(datasetId, runId, "running", Date.now() + 60_000, JSON.stringify(result));
			return null;
		}),
	);
	if (prior) return prior;
	const heartbeat = setInterval(() => {
		try {
			database(cwd, datasetId, (connection) =>
				connection
					.prepare(
						"UPDATE iteration_model_results SET lease_until=? WHERE dataset_id=? AND run_id=? AND status='running'",
					)
					.run(Date.now() + 60_000, datasetId, runId),
			);
		} catch {
			clearInterval(heartbeat);
		}
	}, 10_000);
	heartbeat.unref();
	try {
		signal.throwIfAborted();
		if (getFrameworkIteration(cwd, datasetId, runId).status === "cancelled")
			throw new ResearchError(409, "Iteration cancelled");
		if (frozen.error) throw new ResearchError(409, frozen.error);
		if (!config) result.status = "not_configured";
		else {
			const run = assertFresh(cwd, datasetId, runId, config);
			proposals(cwd, datasetId, run, config, result);
			const signature = analysisSignature(run);
			if (!result.proposal.length) result.status = "no_change";
			else {
				database(cwd, datasetId, (connection) =>
					connection
						.prepare(
							"UPDATE iteration_model_results SET record_json=? WHERE dataset_id=? AND run_id=? AND status='running'",
						)
						.run(JSON.stringify(result), datasetId, runId),
				);
				signal.throwIfAborted();
				const manifest = await (dependencies.apply ?? applyPeModelUpdate)(
					cwd,
					{
						requestId: `iteration_${runId}`,
						expectedSourceSha256: config.baselineSha256,
						docId: config.docId,
						datasetId,
						...(config.baseVersionId ? { baseVersionId: config.baseVersionId } : {}),
						changes: result.proposal.map(
							({ mappingId: _mappingId, observationId: _observationId, ...change }) => change,
						),
						outputs: config.outputs,
						checks: config.checks,
						reviewItems: result.proposal
							.filter((proposal) => proposal.kind === "assumption")
							.map((proposal) => ({
								metricId: proposal.mappingId,
								period: config.mappings.find((mapping) => mapping.id === proposal.mappingId)!.period,
								originalForecast: Number(proposal.expectedValue),
								evidenceIds: proposal.evidenceIds,
								revision: { proposedValue: Number(proposal.newValue), evidenceIds: proposal.evidenceIds },
							})),
						promoteIfEligible: false,
					},
					signal,
				);
				result.modelVersionId = manifest.version_id;
				result.manifest = manifest;
				signal.throwIfAborted();
				assertFresh(cwd, datasetId, runId, config, signature);
				acceptManifest(cwd, result, manifest);
				if (run.monitorRunId && manifest.state === "candidate") {
					if (!manifest.approval_eligible) throw new ResearchError(409, "模型假设仍有未解决的问题，本轮未采用。");
					await reviewPeModelVersion(
						cwd,
						{
							datasetId,
							docId: config.docId,
							versionId: manifest.version_id,
							decision: "approved",
							note: "按项目直接更新设置自动核对：仅采用同期间、同口径、有原文出处的预测或指引；公式及重算检查已通过。",
						},
						signal,
					);
					assertFresh(cwd, datasetId, runId, config, signature);
				}
			}
		}
	} catch (error) {
		result.status =
			signal.aborted || getFrameworkIteration(cwd, datasetId, runId).status === "cancelled"
				? "cancelled"
				: "unavailable";
		result.error = error instanceof Error ? error.message : String(error);
	} finally {
		clearInterval(heartbeat);
	}
	result = database(cwd, datasetId, (connection) => finish(connection, result));
	return result;
}

export function readIterationModelWorkbook(cwd: string, datasetId: string, runId: string) {
	const result = getIterationModelUpdateResult(cwd, datasetId, runId);
	if (!result || result.status !== "candidate" || !result.docId || !result.modelVersionId || !result.manifest)
		throw new ResearchError(409, "This iteration has no available model workbook");
	return database(cwd, datasetId, (connection) => {
		const row = modelVersionRow(connection, datasetId, result.docId!, result.modelVersionId!);
		if (
			!row ||
			row.state === "unavailable" ||
			row.review_decision === "rejected" ||
			row.file_sha256 !== result.manifest!.file.sha256 ||
			row.file_relpath !== result.manifest!.file.path
		)
			throw new ResearchError(409, "Model workbook version is missing, rejected or unavailable");
		return workbook(cwd, row.file_relpath, row.file_sha256, "generated/model-updates");
	});
}

export function promoteIterationModelUpdate(
	cwd: string,
	datasetId: string,
	runId: string,
	expectedConfigRevision: number,
	actor: string,
): IterationModelConfig {
	argumentsValid(cwd, datasetId, runId);
	if (typeof actor !== "string" || !actor.trim() || actor.length > 500 || actor.includes("\0"))
		throw new ResearchError(400, "Invalid model promotion actor");
	if (!Number.isSafeInteger(expectedConfigRevision) || expectedConfigRevision < 1)
		throw new ResearchError(400, "Invalid model configuration revision");
	const run = getFrameworkIteration(cwd, datasetId, runId);
	if (!["published", "no_change"].includes(run.status))
		throw new ResearchError(
			409,
			"Finish framework review before explicitly advancing the independent model baseline",
		);
	return database(cwd, datasetId, (connection) =>
		researchTransaction(connection, () => {
			if (
				run.monitorRunId &&
				!connection
					.prepare(`SELECT 1 FROM research_monitor_runs r JOIN research_monitor_plans p ON p.dataset_id=r.dataset_id
			 WHERE r.dataset_id=? AND r.run_id=? AND r.plan_revision=p.revision AND r.status='running' AND r.lease_until>?
			 AND json_extract(p.config_json,'$.updatePolicy')='direct' AND json_extract(p.config_json,'$.mode')='auto'`)
					.get(datasetId, run.monitorRunId, Date.now())
			)
				throw new ResearchError(409, "更新设置已改变，不能采用本轮模型。");
			const result = loadResult(connection, datasetId, runId);
			const config = loadConfig(connection, datasetId);
			if (!config || config.revision !== expectedConfigRevision || result?.configRevision !== expectedConfigRevision)
				throw new ResearchError(409, "Model configuration revision changed");
			if (result.promotionReceipt) throw new ResearchError(409, "Model delivery has already been adopted");
			if (
				result.status !== "candidate" ||
				result.docId !== config.docId ||
				!result.modelVersionId ||
				!result.manifest ||
				result.baseVersionId !== config.baseVersionId
			)
				throw new ResearchError(409, "This iteration has no eligible model delivery");
			const currentRun = connection
				.prepare("SELECT status FROM framework_iterations WHERE dataset_id=? AND id=?")
				.get(datasetId, runId);
			if (
				currentRun?.status !== run.status ||
				currentResearchVersion(connection, datasetId) !==
					(run.status === "published" ? run.versionId : run.basisVersionId)
			)
				throw new ResearchError(409, "Framework changed before model promotion");
			const current = source(cwd, connection, datasetId, config.docId, config.baseVersionId);
			if (current.documentSha256 !== config.documentSha256 || current.baselineSha256 !== config.baselineSha256)
				throw new ResearchError(409, "Model baseline changed");
			const row = modelVersionRow(connection, datasetId, config.docId, result.modelVersionId);
			if (
				!row ||
				row.parent_version_id !== config.baseVersionId ||
				row.review_decision === "rejected" ||
				(!["current_research", "reviewed"].includes(row.state) &&
					!(run.monitorRunId && row.state === "candidate" && row.review_decision === "approved"))
			)
				throw new ResearchError(409, "Model version is not eligible for promotion");
			const manifest = JSON.parse(row.manifest_json) as PeModelUpdateManifest;
			if (
				manifest.file.sha256 !== row.file_sha256 ||
				manifest.file.path !== row.file_relpath ||
				manifest.source.sha256 !== config.baselineSha256 ||
				manifest.version_id !== result.modelVersionId
			)
				throw new ResearchError(409, "Model manifest does not match its immutable receipt");
			acceptManifest(cwd, result, manifest);
			if (manifest.changes.length !== result.proposal.length || !manifest.changes.length)
				throw new ResearchError(409, "Applied workbook changes do not match the proposal");
			const mappings = structuredClone(config.mappings);
			for (const change of manifest.changes) {
				const proposal = result.proposal.find(
					(entry) => entry.sheet === change.sheet && entry.cell === change.cell,
				);
				const mapping = proposal && mappings.find((entry) => entry.id === proposal.mappingId);
				if (
					!proposal ||
					!mapping ||
					(mapping.role !== "actual" && !run.monitorRunId) ||
					change.kind !== mapping.role ||
					mapping.expectedValue !== change.before ||
					proposal.newValue !== change.after ||
					typeof change.after !== "number" ||
					!Number.isFinite(change.after)
				)
					throw new ResearchError(409, "Applied workbook cell does not match the frozen mapping");
				mapping.expectedValue = change.after;
			}
			const next: IterationModelConfig = {
				...config,
				baseVersionId: row.version_id,
				baselineSha256: row.file_sha256,
				mappings,
				revision: config.revision + 1,
				updatedAt: new Date().toISOString(),
			};
			connection
				.prepare(
					"INSERT INTO model_update_series(dataset_id,doc_id,current_version_id) VALUES(?,?,?) ON CONFLICT(dataset_id,doc_id) DO UPDATE SET current_version_id=excluded.current_version_id",
				)
				.run(datasetId, config.docId, row.version_id);
			connection
				.prepare("UPDATE iteration_model_configs SET config_json=? WHERE dataset_id=?")
				.run(JSON.stringify(next), datasetId);
			const promotionReceipt: IterationModelPromotionReceipt = {
				datasetId,
				runId,
				docId: config.docId,
				oldModelVersionId: config.baseVersionId,
				newModelVersionId: row.version_id,
				configRevisionBefore: config.revision,
				configRevisionAfter: next.revision,
				promotedAt: next.updatedAt,
				actor,
			};
			connection
				.prepare("INSERT INTO iteration_model_promotions(dataset_id,run_id,receipt_json) VALUES(?,?,?)")
				.run(datasetId, runId, JSON.stringify(promotionReceipt));
			return next;
		}),
	);
}
