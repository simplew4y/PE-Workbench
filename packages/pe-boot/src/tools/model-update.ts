import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { excelPython } from "../excel-processing.ts";
import {
	currentModelVersionId,
	insertModelVersion,
	listModelVersionRows,
	modelVersionRow,
	promoteModelVersion,
	reviewModelVersion,
	type StoredModelVersionRow,
	withModelUpdateDatabase,
} from "../model-update-storage.ts";
import {
	type AssumptionReviewItem,
	type AssumptionReviewResult,
	type ModelVersionState,
	reviewAssumptionUpdates,
} from "./assumption-review.ts";
import { resolvePeDatasetLocation } from "./database.ts";

type CellValue = string | number | boolean | null;

export interface PeModelUpdateChange {
	sheet: string;
	cell: string;
	expectedValue: CellValue;
	newValue: CellValue;
	kind: "actual" | "assumption";
	metricId?: string;
	evidenceIds: string[];
	reason: string;
}

export interface PeModelUpdateObservation {
	key: string;
	sheet: string;
	cell: string;
}

export interface PeModelUpdateCheck extends PeModelUpdateObservation {
	expectedValue: CellValue;
	tolerance?: number;
}

export interface ApplyPeModelUpdateOptions {
	requestId?: string;
	expectedSourceSha256?: string;
	docId: string;
	datasetId?: string;
	baseVersionId?: string;
	changes: PeModelUpdateChange[];
	outputs?: PeModelUpdateObservation[];
	checks?: PeModelUpdateCheck[];
	reviewItems?: AssumptionReviewItem[];
	hardValidationErrors?: string[];
	promoteIfEligible?: boolean;
}

interface WorkbookApplyResult {
	applied_changes: Array<{
		sheet: string;
		cell: string;
		before: CellValue;
		after: CellValue;
		kind: string;
		metric_id: string | null;
		evidence_ids: string[];
		reason: string;
	}>;
	formula_fingerprint: string;
	formula_cell_count: number;
	source_error_cells: string[];
	sheet_names: string[];
}

interface WorkbookInspectionResult {
	outputs: Record<string, CellValue>;
	checks: Array<{
		key: string;
		sheet: string;
		cell: string;
		actual: CellValue;
		expected: CellValue;
		tolerance: number;
		passed: boolean;
	}>;
	source_error_cells: string[];
	updated_error_cells: string[];
	new_error_cells: string[];
	source_formula_fingerprint: string;
	source_formula_cell_count: number;
	formula_fingerprint: string;
	formula_cell_count: number;
	formula_changed_cells: string[];
	sheet_names: string[];
}

export interface PeModelUpdateManifest {
	request?: { id: string; sha256: string };
	schema_version: "1.0";
	version_id: string;
	dataset_id: string;
	doc_id: string;
	parent_version_id: string | null;
	created_at: string;
	state: ModelVersionState;
	approval_eligible: boolean;
	can_advance_baseline: boolean;
	promoted: boolean;
	file: { path: string; sha256: string };
	source: { path: string; sha256: string; unchanged: boolean };
	changes: WorkbookApplyResult["applied_changes"];
	assumption_review: AssumptionReviewResult;
	validation: {
		recalculated: boolean;
		engine?: { name: "libreoffice"; version: string };
		hard_errors: string[];
		new_error_cells: string[];
		checks: WorkbookInspectionResult["checks"];
	};
	outputs: Record<string, CellValue>;
	formula_cell_count: number;
}

const pythonScript = resolve(dirname(fileURLToPath(import.meta.url)), "../../python/model_update_workbook.py");

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function cellValue(value: unknown): value is CellValue {
	return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function parseApplyResult(value: unknown): WorkbookApplyResult {
	if (
		!object(value) ||
		!Array.isArray(value.applied_changes) ||
		typeof value.formula_fingerprint !== "string" ||
		typeof value.formula_cell_count !== "number" ||
		!strings(value.source_error_cells) ||
		!strings(value.sheet_names)
	)
		throw new Error("Invalid workbook update result");
	for (const change of value.applied_changes) {
		if (
			!object(change) ||
			typeof change.sheet !== "string" ||
			typeof change.cell !== "string" ||
			!cellValue(change.before) ||
			!cellValue(change.after) ||
			typeof change.kind !== "string" ||
			!(change.metric_id === null || typeof change.metric_id === "string") ||
			!strings(change.evidence_ids) ||
			typeof change.reason !== "string"
		)
			throw new Error("Invalid applied workbook change");
	}
	return value as unknown as WorkbookApplyResult;
}

function parseInspectionResult(value: unknown): WorkbookInspectionResult {
	if (
		!object(value) ||
		!object(value.outputs) ||
		!Object.values(value.outputs).every(cellValue) ||
		!Array.isArray(value.checks) ||
		!strings(value.source_error_cells) ||
		!strings(value.updated_error_cells) ||
		!strings(value.new_error_cells) ||
		typeof value.source_formula_fingerprint !== "string" ||
		typeof value.source_formula_cell_count !== "number" ||
		typeof value.formula_fingerprint !== "string" ||
		typeof value.formula_cell_count !== "number" ||
		!strings(value.formula_changed_cells) ||
		!strings(value.sheet_names)
	)
		throw new Error("Invalid recalculated workbook inspection");
	for (const check of value.checks) {
		if (
			!object(check) ||
			typeof check.key !== "string" ||
			typeof check.sheet !== "string" ||
			typeof check.cell !== "string" ||
			!cellValue(check.actual) ||
			!cellValue(check.expected) ||
			typeof check.tolerance !== "number" ||
			typeof check.passed !== "boolean"
		)
			throw new Error("Invalid workbook validation check");
	}
	return value as unknown as WorkbookInspectionResult;
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runProcess(
	command: string,
	args: string[],
	options: { signal?: AbortSignal; timeoutMs: number; maxOutput?: number },
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolveProcess, reject) => {
		options.signal?.throwIfAborted();
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let failure: Error | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const maxOutput = options.maxOutput ?? 64_000;
		const stop = (error: Error): void => {
			failure ??= error;
			child.kill("SIGTERM");
			killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
			killTimer.unref();
		};
		const aborted = (): void =>
			stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Model update aborted"));
		options.signal?.addEventListener("abort", aborted, { once: true });
		const timeout = setTimeout(
			() => stop(new Error(`${command} exceeded ${options.timeoutMs} ms`)),
			options.timeoutMs,
		);
		timeout.unref();
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = (stdout + chunk.toString()).slice(-maxOutput);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-maxOutput);
		});
		child.once("error", (error) => {
			failure = error;
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", aborted);
			if (code === 0 && !failure) resolveProcess({ stdout, stderr });
			else reject(failure ?? new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
		});
	});
}

function safeStoredFile(workspaceRoot: string, row: StoredModelVersionRow): string {
	const root = realpathSync(join(workspaceRoot, "generated", "model-updates"));
	const path = realpathSync(resolve(workspaceRoot, row.file_relpath));
	const rel = relative(root, path);
	if (!rel || rel.startsWith("..") || isAbsolute(rel) || !statSync(path).isFile())
		throw new Error("Stored model version resolves outside generated/model-updates");
	if (sha256(path) !== row.file_sha256) throw new Error("Stored model version file changed after publication");
	return path;
}

function manifestFromRow(
	row: StoredModelVersionRow,
	currentVersionId: string | undefined,
): PeModelUpdateManifest & {
	review: { decision: "approved" | "rejected"; note: string; created_at: string } | null;
	effective_state: ModelVersionState | "rejected";
} {
	const value: unknown = JSON.parse(row.manifest_json);
	if (!object(value) || value.version_id !== row.version_id)
		throw new Error("Stored model version manifest is invalid");
	const manifest = value as unknown as PeModelUpdateManifest;
	const effectiveState =
		row.review_decision === "approved" ? "reviewed" : row.review_decision === "rejected" ? "rejected" : row.state;
	return {
		...manifest,
		promoted: currentVersionId === row.version_id,
		review:
			row.review_decision && row.review_note !== null && row.reviewed_at
				? { decision: row.review_decision, note: row.review_note, created_at: row.reviewed_at }
				: null,
		effective_state: effectiveState,
	};
}

function ensureChangesAreSupported(
	changes: readonly PeModelUpdateChange[],
	reviewItems: readonly AssumptionReviewItem[],
): void {
	if (!changes.length) throw new Error("At least one model update change is required");
	const seen = new Set<string>();
	const reviews = new Map(reviewItems.map((item) => [item.metricId, item]));
	for (const change of changes) {
		const key = `${change.sheet}\0${change.cell.toUpperCase().replaceAll("$", "")}`;
		if (seen.has(key)) throw new Error(`Duplicate model update cell: ${change.sheet}!${change.cell}`);
		seen.add(key);
		if (!change.evidenceIds.length) throw new Error(`${change.sheet}!${change.cell} requires evidence IDs`);
		if (!change.reason.trim()) throw new Error(`${change.sheet}!${change.cell} requires a change reason`);
		if (change.kind !== "assumption") continue;
		if (!change.metricId) throw new Error(`${change.sheet}!${change.cell} assumption change requires metric_id`);
		const review = reviews.get(change.metricId);
		if (!review?.revision)
			throw new Error(`${change.metricId} assumption change requires a reviewed revision proposal`);
		if (typeof change.newValue !== "number" || review.revision.proposedValue !== change.newValue)
			throw new Error(`${change.metricId} change must equal the revision value assessed by pe_assumption_review`);
	}
}

async function recalculateWorkbook(
	inputPath: string,
	outputDirectory: string,
	profileDirectory: string,
	signal?: AbortSignal,
): Promise<{ path: string; version: string }> {
	const soffice = process.env.PE_SPREADSHEET_RECALCULATOR?.trim() || "soffice";
	const version = await runProcess(soffice, ["--version"], { signal, timeoutMs: 30_000 });
	await runProcess(
		soffice,
		[
			"--headless",
			"--nologo",
			"--nodefault",
			"--nolockcheck",
			"--nofirststartwizard",
			`-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
			"--convert-to",
			"xlsx",
			"--outdir",
			outputDirectory,
			inputPath,
		],
		{ signal, timeoutMs: 5 * 60_000, maxOutput: 256_000 },
	);
	const resultPath = join(outputDirectory, `${basename(inputPath, extname(inputPath))}.xlsx`);
	if (!existsSync(resultPath)) throw new Error("LibreOffice did not produce the recalculated workbook");
	return { path: resultPath, version: version.stdout.trim() || version.stderr.trim() || "unknown" };
}

export async function applyPeModelUpdate(
	cwd: string,
	options: ApplyPeModelUpdateOptions,
	signal?: AbortSignal,
): Promise<PeModelUpdateManifest> {
	if (options.requestId === undefined) return applyModelUpdate(cwd, options, signal);
	if (typeof options.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(options.requestId))
		throw new Error("Invalid model update request ID");
	const { workspaceRoot } = resolvePeDatasetLocation(cwd);
	const lockDirectory = join(
		workspaceRoot,
		"meta",
		`model-update-${createHash("sha256").update(`${options.docId}\0${options.requestId}`).digest("hex")}.lock`,
	);
	if (realpathSync(dirname(lockDirectory)) !== dirname(lockDirectory))
		throw new Error("Model request lock must remain inside the project");
	signal?.throwIfAborted();
	try {
		mkdirSync(lockDirectory);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST")
			throw new Error("Model update request is in progress or interrupted; do not repeat an uncertain write");
		throw error;
	}
	try {
		return await applyModelUpdate(cwd, options, signal);
	} finally {
		rmSync(lockDirectory, { recursive: true, force: true });
	}
}

async function applyModelUpdate(
	cwd: string,
	options: ApplyPeModelUpdateOptions,
	signal?: AbortSignal,
): Promise<PeModelUpdateManifest> {
	if (options.requestId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(options.requestId))
		throw new Error("Invalid model update request ID");
	if (options.expectedSourceSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(options.expectedSourceSha256))
		throw new Error("Invalid model update source SHA256");
	const requestHash = createHash("sha256").update(JSON.stringify(options)).digest("hex");
	const requestedVersionId = options.requestId
		? `request-${createHash("sha256").update(`${options.docId}\0${options.requestId}`).digest("hex")}`
		: undefined;
	if (requestedVersionId) {
		const prior = withModelUpdateDatabase(cwd, options.datasetId, (database, datasetId) => {
			const row = modelVersionRow(database, datasetId, options.docId, requestedVersionId);
			return row
				? { row, manifest: manifestFromRow(row, currentModelVersionId(database, datasetId, options.docId)) }
				: undefined;
		});
		if (prior) {
			const manifest = prior.manifest;
			if (manifest.request?.sha256 !== requestHash)
				throw new Error("Model update request belongs to different input");
			safeStoredFile(realpathSync(cwd), prior.row);
			return manifest;
		}
	}
	const prepared = await preparePeDocument(cwd, { docId: options.docId, datasetId: options.datasetId }, signal);
	if (prepared.document.file_type !== "xlsx")
		throw new Error("Controlled model updates currently support .xlsx workbooks only");
	const reviewItems = options.reviewItems ?? [];
	ensureChangesAreSupported(options.changes, reviewItems);
	const initialReview = reviewAssumptionUpdates(reviewItems, options.hardValidationErrors ?? []);
	const versionContext = withModelUpdateDatabase(cwd, prepared.datasetId, (database, datasetId) => {
		const current = currentModelVersionId(database, datasetId, options.docId);
		const baseVersionId = options.baseVersionId ?? current;
		const baseRow = baseVersionId ? modelVersionRow(database, datasetId, options.docId, baseVersionId) : undefined;
		if (baseVersionId && !baseRow) throw new Error(`Model base version not found: ${baseVersionId}`);
		return { current, baseVersionId, baseRow };
	});
	const sourcePath = versionContext.baseRow
		? safeStoredFile(prepared.workspaceRoot, versionContext.baseRow)
		: prepared.filePath;
	const sourceHash = sha256(sourcePath);
	if (options.expectedSourceSha256 !== undefined && sourceHash !== options.expectedSourceSha256)
		throw new Error("Model baseline changed before workbook update");
	const uploadHashBefore = sha256(prepared.filePath);
	const versionId =
		requestedVersionId ??
		`${new Date()
			.toISOString()
			.replace(/[-:.TZ]/gu, "")
			.slice(0, 14)}-${randomUUID().slice(0, 8)}`;
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pe-model-update-"));
	const preparedDirectory = join(temporaryRoot, "prepared");
	const baselineDirectory = join(temporaryRoot, "baseline-recalculated");
	const recalculatedDirectory = join(temporaryRoot, "recalculated");
	const profileDirectory = join(temporaryRoot, "libreoffice-profile");
	for (const directory of [preparedDirectory, baselineDirectory, recalculatedDirectory, profileDirectory])
		mkdirSync(directory);
	const workingFilename = `${basename(prepared.filePath, ".xlsx")}--${versionId}.xlsx`;
	const preparedPath = join(preparedDirectory, workingFilename);
	const planPath = join(temporaryRoot, "plan.json");
	const applyResultPath = join(temporaryRoot, "apply-result.json");
	const inspectionPath = join(temporaryRoot, "inspection.json");
	writeFileSync(
		planPath,
		`${JSON.stringify(
			{
				changes: options.changes.map((change) => ({
					sheet: change.sheet,
					cell: change.cell,
					expected_value: change.expectedValue,
					new_value: change.newValue,
					kind: change.kind,
					metric_id: change.metricId ?? null,
					evidence_ids: change.evidenceIds,
					reason: change.reason,
				})),
				outputs: (options.outputs ?? []).map((output) => ({
					key: output.key,
					sheet: output.sheet,
					cell: output.cell,
				})),
				checks: (options.checks ?? []).map((check) => ({
					key: check.key,
					sheet: check.sheet,
					cell: check.cell,
					expected_value: check.expectedValue,
					tolerance: check.tolerance ?? 0,
				})),
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	let applyResult: WorkbookApplyResult;
	let inspection: WorkbookInspectionResult = {
		outputs: {},
		checks: [],
		source_error_cells: [],
		updated_error_cells: [],
		new_error_cells: [],
		source_formula_fingerprint: "",
		source_formula_cell_count: 0,
		formula_fingerprint: "",
		formula_cell_count: 0,
		formula_changed_cells: [],
		sheet_names: [],
	};
	let recalculated = false;
	let engineVersion: string | undefined;
	const hardErrors = [...(options.hardValidationErrors ?? [])];
	let selectedFile = preparedPath;
	try {
		await runProcess(
			excelPython(),
			[
				pythonScript,
				"apply",
				"--input",
				sourcePath,
				"--plan",
				planPath,
				"--output",
				preparedPath,
				"--result",
				applyResultPath,
			],
			{ signal, timeoutMs: 120_000 },
		);
		applyResult = parseApplyResult(readJson(applyResultPath));
		try {
			const baseline = await recalculateWorkbook(sourcePath, baselineDirectory, profileDirectory, signal);
			const engine = await recalculateWorkbook(preparedPath, recalculatedDirectory, profileDirectory, signal);
			selectedFile = engine.path;
			engineVersion = engine.version;
			recalculated = true;
			await runProcess(
				excelPython(),
				[
					pythonScript,
					"inspect",
					"--source",
					baseline.path,
					"--updated",
					selectedFile,
					"--plan",
					planPath,
					"--result",
					inspectionPath,
				],
				{ signal, timeoutMs: 120_000 },
			);
			inspection = parseInspectionResult(readJson(inspectionPath));
			if (
				inspection.formula_cell_count !== inspection.source_formula_cell_count ||
				inspection.formula_fingerprint !== inspection.source_formula_fingerprint
			)
				hardErrors.push(
					`Workbook formulas changed during recalculation: ${inspection.formula_changed_cells.slice(0, 10).join(", ")}`,
				);
			for (const error of inspection.new_error_cells) hardErrors.push(`New workbook error: ${error}`);
			for (const check of inspection.checks)
				if (!check.passed) hardErrors.push(`Validation check failed: ${check.key}`);
		} catch (error) {
			hardErrors.push(`Workbook recalculation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const state: ModelVersionState = hardErrors.length ? "unavailable" : initialReview.version_state;
		const canAdvance = (state === "current_research" || state === "reviewed") && hardErrors.length === 0;
		const approvalEligible =
			state === "candidate" &&
			hardErrors.length === 0 &&
			initialReview.assessments.every((assessment) => assessment.action === "propose_local_revision") &&
			reviewItems.every((item) => !item.revision || item.revision.evidenceIds.length > 0);
		signal?.throwIfAborted();
		const finalDirectory = join(prepared.workspaceRoot, "generated", "model-updates", options.docId, versionId);
		mkdirSync(finalDirectory, { recursive: true });
		const finalFile = join(finalDirectory, workingFilename);
		copyFileSync(selectedFile, finalFile);
		const fileRelpath = relative(prepared.workspaceRoot, finalFile).replaceAll("\\", "/");
		const promoted = options.promoteIfEligible === true && canAdvance;
		const manifest: PeModelUpdateManifest = {
			...(options.requestId ? { request: { id: options.requestId, sha256: requestHash } } : {}),
			schema_version: "1.0",
			version_id: versionId,
			dataset_id: prepared.datasetId,
			doc_id: options.docId,
			parent_version_id: versionContext.baseVersionId ?? null,
			created_at: new Date().toISOString(),
			state,
			approval_eligible: approvalEligible,
			can_advance_baseline: canAdvance,
			promoted,
			file: { path: fileRelpath, sha256: sha256(finalFile) },
			source: {
				path: relative(prepared.workspaceRoot, sourcePath).replaceAll("\\", "/"),
				sha256: sourceHash,
				unchanged: sha256(sourcePath) === sourceHash && sha256(prepared.filePath) === uploadHashBefore,
			},
			changes: applyResult.applied_changes,
			assumption_review: initialReview,
			validation: {
				recalculated,
				...(engineVersion ? { engine: { name: "libreoffice" as const, version: engineVersion } } : {}),
				hard_errors: hardErrors,
				new_error_cells: inspection.new_error_cells,
				checks: inspection.checks,
			},
			outputs: inspection.outputs,
			formula_cell_count: inspection.formula_cell_count || applyResult.formula_cell_count,
		};
		writeFileSync(join(finalDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		try {
			withModelUpdateDatabase(cwd, prepared.datasetId, (database, datasetId) => {
				insertModelVersion(
					database,
					{
						version_id: versionId,
						dataset_id: datasetId,
						doc_id: options.docId,
						parent_version_id: versionContext.baseVersionId ?? null,
						state,
						file_relpath: fileRelpath,
						file_sha256: manifest.file.sha256,
						manifest_json: JSON.stringify(manifest),
						created_at: manifest.created_at,
					},
					promoted,
				);
			});
		} catch (error) {
			rmSync(finalDirectory, { recursive: true, force: true });
			throw error;
		}
		return manifest;
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

export async function listPeModelVersions(
	cwd: string,
	options: { docId: string; datasetId?: string },
	signal?: AbortSignal,
): Promise<{ doc_id: string; current_version_id: string | null; versions: ReturnType<typeof manifestFromRow>[] }> {
	const prepared = await preparePeDocument(cwd, { docId: options.docId, datasetId: options.datasetId }, signal);
	return withModelUpdateDatabase(cwd, prepared.datasetId, (database, datasetId) => {
		const current = currentModelVersionId(database, datasetId, options.docId);
		return {
			doc_id: options.docId,
			current_version_id: current ?? null,
			versions: listModelVersionRows(database, datasetId, options.docId).map((row) => manifestFromRow(row, current)),
		};
	});
}

export async function reviewPeModelVersion(
	cwd: string,
	options: {
		docId: string;
		versionId: string;
		decision: "approved" | "rejected";
		note: string;
		promoteIfApproved?: boolean;
		datasetId?: string;
	},
	signal?: AbortSignal,
): Promise<ReturnType<typeof manifestFromRow>> {
	const prepared = await preparePeDocument(cwd, { docId: options.docId, datasetId: options.datasetId }, signal);
	return withModelUpdateDatabase(cwd, prepared.datasetId, (database, datasetId) => {
		const row = modelVersionRow(database, datasetId, options.docId, options.versionId);
		if (!row) throw new Error(`Model version not found: ${options.versionId}`);
		if (row.review_decision) throw new Error("Model version already has an immutable review decision");
		const manifest = manifestFromRow(row, currentModelVersionId(database, datasetId, options.docId));
		if (options.decision === "approved" && (!manifest.approval_eligible || manifest.state !== "candidate"))
			throw new Error("Only an approval-eligible candidate version can be approved");
		reviewModelVersion(database, options.versionId, options.decision, options.note.trim(), new Date().toISOString());
		if (options.decision === "approved" && options.promoteIfApproved)
			promoteModelVersion(database, datasetId, options.docId, options.versionId);
		const reviewed = modelVersionRow(database, datasetId, options.docId, options.versionId);
		if (!reviewed) throw new Error("Reviewed model version disappeared");
		return manifestFromRow(reviewed, currentModelVersionId(database, datasetId, options.docId));
	});
}

export async function promotePeModelVersion(
	cwd: string,
	options: { docId: string; versionId: string; datasetId?: string },
	signal?: AbortSignal,
): Promise<ReturnType<typeof manifestFromRow>> {
	const prepared = await preparePeDocument(cwd, { docId: options.docId, datasetId: options.datasetId }, signal);
	return withModelUpdateDatabase(cwd, prepared.datasetId, (database, datasetId) => {
		const row = modelVersionRow(database, datasetId, options.docId, options.versionId);
		if (!row) throw new Error(`Model version not found: ${options.versionId}`);
		const manifest = manifestFromRow(row, currentModelVersionId(database, datasetId, options.docId));
		if (
			manifest.effective_state === "rejected" ||
			!(["current_research", "reviewed"] as const).includes(
				manifest.effective_state as "current_research" | "reviewed",
			)
		)
			throw new Error("Only a current research or approved/reviewed version can become the baseline");
		safeStoredFile(prepared.workspaceRoot, row);
		promoteModelVersion(database, datasetId, options.docId, options.versionId);
		return manifestFromRow(row, options.versionId);
	});
}

const directionSchema = Type.Union([
	Type.Literal("positive"),
	Type.Literal("flat"),
	Type.Literal("negative"),
	Type.Literal("unknown"),
]);
const reviewItemSchema = Type.Object({
	metric_id: Type.String({ minLength: 1 }),
	period: Type.String({ minLength: 1 }),
	original_forecast: Type.Number(),
	actual: Type.Optional(Type.Number()),
	consensus: Type.Optional(Type.Number()),
	direction: Type.Optional(
		Type.Object({
			forecast: directionSchema,
			actual: Type.Optional(directionSchema),
			industry: Type.Optional(directionSchema),
		}),
	),
	historical_range: Type.Optional(Type.Object({ low: Type.Number(), high: Type.Number() })),
	tolerance: Type.Optional(
		Type.Object({
			max_absolute_variance: Type.Optional(Type.Number({ minimum: 0 })),
			max_relative_variance_percent: Type.Optional(Type.Number({ minimum: 0 })),
			material_valuation_impact_percent: Type.Optional(Type.Number({ minimum: 0 })),
			persistent_miss_count: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
	),
	valuation_impact_percent: Type.Optional(Type.Number()),
	consecutive_miss_count: Type.Optional(Type.Integer({ minimum: 0 })),
	evidence_ids: Type.Array(Type.String({ minLength: 1 })),
	company_specific_evidence: Type.Optional(Type.Boolean()),
	evidence_conflict: Type.Optional(Type.Boolean()),
	revision: Type.Optional(
		Type.Object({
			proposed_value: Type.Number(),
			evidence_ids: Type.Array(Type.String({ minLength: 1 })),
			has_base_bear_bull_scenarios: Type.Optional(Type.Boolean()),
			human_reviewed: Type.Optional(Type.Boolean()),
		}),
	),
});
const observationSchema = Type.Object({
	key: Type.String({ minLength: 1 }),
	sheet: Type.String({ minLength: 1 }),
	cell: Type.String({ minLength: 2 }),
});

function mapReviewItems(
	items: Array<{
		metric_id: string;
		period: string;
		original_forecast: number;
		actual?: number;
		consensus?: number;
		direction?: {
			forecast: "positive" | "flat" | "negative" | "unknown";
			actual?: "positive" | "flat" | "negative" | "unknown";
			industry?: "positive" | "flat" | "negative" | "unknown";
		};
		historical_range?: { low: number; high: number };
		tolerance?: {
			max_absolute_variance?: number;
			max_relative_variance_percent?: number;
			material_valuation_impact_percent?: number;
			persistent_miss_count?: number;
		};
		valuation_impact_percent?: number;
		consecutive_miss_count?: number;
		evidence_ids: string[];
		company_specific_evidence?: boolean;
		evidence_conflict?: boolean;
		revision?: {
			proposed_value: number;
			evidence_ids: string[];
			has_base_bear_bull_scenarios?: boolean;
			human_reviewed?: boolean;
		};
	}>,
): AssumptionReviewItem[] {
	return items.map((item) => ({
		metricId: item.metric_id,
		period: item.period,
		originalForecast: item.original_forecast,
		actual: item.actual,
		consensus: item.consensus,
		direction: item.direction,
		historicalRange: item.historical_range,
		tolerance: item.tolerance
			? {
					maxAbsoluteVariance: item.tolerance.max_absolute_variance,
					maxRelativeVariancePercent: item.tolerance.max_relative_variance_percent,
					materialValuationImpactPercent: item.tolerance.material_valuation_impact_percent,
					persistentMissCount: item.tolerance.persistent_miss_count,
				}
			: undefined,
		valuationImpactPercent: item.valuation_impact_percent,
		consecutiveMissCount: item.consecutive_miss_count,
		evidenceIds: item.evidence_ids,
		companySpecificEvidence: item.company_specific_evidence,
		evidenceConflict: item.evidence_conflict,
		revision: item.revision
			? {
					proposedValue: item.revision.proposed_value,
					evidenceIds: item.revision.evidence_ids,
					hasBaseBearBullScenarios: item.revision.has_base_bear_bull_scenarios,
					humanReviewed: item.revision.human_reviewed,
				}
			: undefined,
	}));
}

export const peModelUpdateTool = defineTool({
	name: "pe_model_update",
	label: "PE Model Update",
	description:
		"Apply evidence-backed actual or assumption changes to an immutable workbook copy, recalculate it, validate selected checks, preserve version history, and approve or promote eligible baselines.",
	parameters: Type.Union([
		Type.Object({
			operation: Type.Literal("apply"),
			doc_id: Type.String({ minLength: 1 }),
			dataset_id: Type.Optional(Type.String()),
			base_version_id: Type.Optional(Type.String()),
			changes: Type.Array(
				Type.Object({
					sheet: Type.String({ minLength: 1 }),
					cell: Type.String({ minLength: 2 }),
					expected_value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
					new_value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
					kind: Type.Union([Type.Literal("actual"), Type.Literal("assumption")]),
					metric_id: Type.Optional(Type.String({ minLength: 1 })),
					evidence_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
					reason: Type.String({ minLength: 1 }),
				}),
				{ minItems: 1, maxItems: 200 },
			),
			outputs: Type.Optional(Type.Array(observationSchema, { maxItems: 50 })),
			checks: Type.Optional(
				Type.Array(
					Type.Intersect([
						observationSchema,
						Type.Object({
							expected_value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
							tolerance: Type.Optional(Type.Number({ minimum: 0 })),
						}),
					]),
					{ maxItems: 50 },
				),
			),
			review_items: Type.Optional(Type.Array(reviewItemSchema, { maxItems: 100 })),
			hard_validation_errors: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			promote_if_eligible: Type.Optional(Type.Boolean()),
		}),
		Type.Object({
			operation: Type.Literal("list"),
			doc_id: Type.String({ minLength: 1 }),
			dataset_id: Type.Optional(Type.String()),
		}),
		Type.Object({
			operation: Type.Literal("review"),
			doc_id: Type.String({ minLength: 1 }),
			dataset_id: Type.Optional(Type.String()),
			version_id: Type.String({ minLength: 1 }),
			decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
			note: Type.String({ minLength: 1 }),
			promote_if_approved: Type.Optional(Type.Boolean()),
		}),
		Type.Object({
			operation: Type.Literal("promote"),
			doc_id: Type.String({ minLength: 1 }),
			dataset_id: Type.Optional(Type.String()),
			version_id: Type.String({ minLength: 1 }),
		}),
	]),
	async execute(_id, params, signal, _onUpdate, ctx) {
		if (params.operation === "list") {
			const result = await listPeModelVersions(
				ctx.cwd,
				{ docId: params.doc_id, datasetId: params.dataset_id },
				signal,
			);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		}
		if (params.operation === "review") {
			const result = await reviewPeModelVersion(
				ctx.cwd,
				{
					docId: params.doc_id,
					datasetId: params.dataset_id,
					versionId: params.version_id,
					decision: params.decision,
					note: params.note,
					promoteIfApproved: params.promote_if_approved,
				},
				signal,
			);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		}
		if (params.operation === "promote") {
			const result = await promotePeModelVersion(
				ctx.cwd,
				{ docId: params.doc_id, datasetId: params.dataset_id, versionId: params.version_id },
				signal,
			);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		}
		const result = await applyPeModelUpdate(
			ctx.cwd,
			{
				docId: params.doc_id,
				datasetId: params.dataset_id,
				baseVersionId: params.base_version_id,
				changes: params.changes.map((change) => ({
					sheet: change.sheet,
					cell: change.cell,
					expectedValue: change.expected_value,
					newValue: change.new_value,
					kind: change.kind,
					metricId: change.metric_id,
					evidenceIds: change.evidence_ids,
					reason: change.reason,
				})),
				outputs: params.outputs,
				checks: params.checks?.map((check) => ({
					key: check.key,
					sheet: check.sheet,
					cell: check.cell,
					expectedValue: check.expected_value,
					tolerance: check.tolerance,
				})),
				reviewItems: mapReviewItems(params.review_items ?? []),
				hardValidationErrors: params.hard_validation_errors,
				promoteIfEligible: params.promote_if_eligible,
			},
			signal,
		);
		return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
	},
});
