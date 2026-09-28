import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { excelPython } from "../excel-processing.ts";
import { discoverPeDrivers, type PeDriverCandidate, resolvePeDriverLabel } from "./driver-discover.ts";
import { tracePeFormula } from "./formula-trace.ts";

const DEFAULT_SHOCK_PERCENT = 5;
const DEFAULT_MAX_DRIVERS = 10;
const MAX_DRIVERS = 20;
const processRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../python");

export const PE_DRIVER_SENSITIVITY_PROMPT_SNIPPET =
	"Recalculate one selected valuation output after isolated upstream input shocks; rank only measured valuation effects and preserve an auditable propagation path";

interface WorkbookObservation {
	key: string;
	sheet: string;
	cell: string;
}

interface WorkbookScenario {
	scenario_id: string;
	input_filename: string;
	result_filename: string;
	overrides: Array<{ sheet: string; cell: string; value: number }>;
}

interface WorkbookPlan {
	observations: WorkbookObservation[];
	scenarios: WorkbookScenario[];
}

interface WorkbookSnapshot {
	scenario_id: string;
	values: Record<string, string | number | boolean | null>;
}

interface WorkbookEngineResult {
	engine_name: "libreoffice";
	engine_version: string;
	snapshots: WorkbookSnapshot[];
}

export interface PeDriverSensitivityOptions {
	docId: string;
	outputSheet: string;
	outputCellRef: string;
	datasetId?: string;
	driverIds?: string[];
	shockPercent?: number;
	maxDrivers?: number;
}

export interface PeSensitivityPropagationNode {
	sheet_name: string;
	cell_ref: string;
	label: string;
	is_formula: boolean;
	baseline_value: number;
	down_value: number;
	up_value: number;
	down_change_percent?: number;
	up_change_percent?: number;
}

export interface PeDriverSensitivityResultItem {
	rank: number;
	driver_id: string;
	role: PeDriverCandidate["role"];
	label: string;
	sheet_name: string;
	cell_ref: string;
	baseline_input: number;
	down_input: number;
	up_input: number;
	baseline_output: number;
	down_output: number;
	up_output: number;
	down_output_change: number;
	up_output_change: number;
	down_output_change_percent?: number;
	up_output_change_percent?: number;
	down_elasticity?: number;
	up_elasticity?: number;
	max_abs_output_change: number;
	max_abs_output_change_percent?: number;
	active_driver: boolean;
	propagation: PeSensitivityPropagationNode[];
	markdown_citation: string;
}

export interface PeDriverSensitivityResult {
	schema_version: "1.0";
	run_id: string;
	dataset_id: string;
	doc_id: string;
	status: "completed" | "partial" | "not_calculable";
	engine: { name: "libreoffice"; version: string };
	output: { output_id: string; sheet_name: string; cell_ref: string; baseline_value: number };
	shock: { method: "relative_one_at_a_time"; percent: number };
	tested_driver_count: number;
	active_driver_count: number;
	sensitivity_ranking_available: boolean;
	ranked_drivers: PeDriverSensitivityResultItem[];
	excluded_drivers: Array<{ driver_id: string; label: string; reason: string }>;
	original_unchanged: boolean;
	artifacts: { result_json: string; summary_markdown: string };
	warnings: string[];
	answer_contract: string;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function changePercent(value: number, baseline: number): number | undefined {
	return baseline === 0 ? undefined : ((value - baseline) / Math.abs(baseline)) * 100;
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
			stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Sensitivity run aborted"));
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

async function recalculateWithLibreOffice(
	sourcePath: string,
	plan: WorkbookPlan,
	signal?: AbortSignal,
): Promise<WorkbookEngineResult> {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pe-sensitivity-"));
	const inputs = join(temporaryRoot, "inputs");
	const recalculated = join(temporaryRoot, "recalculated");
	const profile = join(temporaryRoot, "libreoffice-profile");
	const planPath = join(temporaryRoot, "plan.json");
	const resultPath = join(temporaryRoot, "results.json");
	mkdirSync(inputs);
	mkdirSync(recalculated);
	mkdirSync(profile);
	writeFileSync(planPath, JSON.stringify(plan), "utf8");
	const pythonScript = join(processRoot, "sensitivity_workbook.py");
	const soffice = process.env.PE_SPREADSHEET_RECALCULATOR?.trim() || "soffice";
	try {
		await runProcess(
			excelPython(),
			[pythonScript, "prepare", "--input", sourcePath, "--plan", planPath, "--output-dir", inputs],
			{ signal, timeoutMs: 120_000 },
		);
		const version = await runProcess(soffice, ["--version"], { signal, timeoutMs: 30_000 });
		const inputPaths = plan.scenarios.map((scenario) => join(inputs, scenario.input_filename));
		await runProcess(
			soffice,
			[
				"--headless",
				"--nologo",
				"--nodefault",
				"--nolockcheck",
				"--nofirststartwizard",
				`-env:UserInstallation=${pathToFileURL(profile).href}`,
				"--convert-to",
				"xlsx",
				"--outdir",
				recalculated,
				...inputPaths,
			],
			{ signal, timeoutMs: 5 * 60_000, maxOutput: 256_000 },
		);
		for (const scenario of plan.scenarios) {
			if (!existsSync(join(recalculated, scenario.result_filename)))
				throw new Error(`LibreOffice did not produce ${scenario.result_filename}`);
		}
		await runProcess(
			excelPython(),
			[pythonScript, "read", "--plan", planPath, "--recalculated-dir", recalculated, "--output", resultPath],
			{ signal, timeoutMs: 120_000 },
		);
		const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as { scenarios?: WorkbookSnapshot[] };
		if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length !== plan.scenarios.length)
			throw new Error("Recalculation engine returned an incomplete scenario set");
		return {
			engine_name: "libreoffice",
			engine_version: version.stdout.trim() || version.stderr.trim() || "unknown",
			snapshots: parsed.scenarios,
		};
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

function buildSummary(result: PeDriverSensitivityResult): string {
	const lines = [
		"# Valuation sensitivity run",
		"",
		`Output: ${result.output.sheet_name}!${result.output.cell_ref}`,
		`Baseline: ${result.output.baseline_value}`,
		`Shock: ±${result.shock.percent}% one variable at a time`,
		`Engine: ${result.engine.version}`,
		"",
		"| Rank | Driver | Cell | Down output change | Up output change | Max absolute change | Active |",
		"| ---: | --- | --- | ---: | ---: | ---: | --- |",
	];
	for (const driver of result.ranked_drivers) {
		const down = driver.down_output_change_percent;
		const up = driver.up_output_change_percent;
		const maximum = driver.max_abs_output_change_percent;
		lines.push(
			`| ${driver.rank} | ${driver.label} | ${driver.sheet_name}!${driver.cell_ref} | ${down === undefined ? "n.a." : `${down.toFixed(2)}%`} | ${up === undefined ? "n.a." : `${up.toFixed(2)}%`} | ${maximum === undefined ? "n.a." : `${maximum.toFixed(2)}%`} | ${driver.active_driver ? "yes" : "no"} |`,
		);
	}
	if (result.excluded_drivers.length > 0) {
		lines.push("", "## Excluded drivers", "");
		for (const excluded of result.excluded_drivers)
			lines.push(`- ${excluded.label} (${excluded.driver_id}): ${excluded.reason}`);
	}
	return `${lines.join("\n")}\n`;
}

export async function runPeDriverSensitivity(
	cwd: string,
	options: PeDriverSensitivityOptions,
	signal?: AbortSignal,
): Promise<PeDriverSensitivityResult> {
	const shockPercent = Math.max(0.01, Math.min(100, Math.abs(options.shockPercent ?? DEFAULT_SHOCK_PERCENT)));
	const maxDrivers = Math.max(1, Math.min(MAX_DRIVERS, Math.trunc(options.maxDrivers ?? DEFAULT_MAX_DRIVERS)));
	const prepared = await preparePeDocument(cwd, { docId: options.docId, datasetId: options.datasetId }, signal);
	if (prepared.document.file_type !== "xlsx" && prepared.document.file_type !== "xlsm")
		throw new Error("Sensitivity recalculation requires an .xlsx or .xlsm workbook");
	const originalHash = sha256(prepared.filePath);
	const discovery = discoverPeDrivers(
		cwd,
		{
			docId: options.docId,
			outputSheet: options.outputSheet,
			outputCellRef: options.outputCellRef,
			datasetId: options.datasetId,
			topK: 100,
		},
		signal,
	);
	const requestedIds = new Set(options.driverIds?.map((value) => value.trim()).filter(Boolean) ?? []);
	const excludedDrivers: PeDriverSensitivityResult["excluded_drivers"] = [];
	const selected: PeDriverCandidate[] = [];
	for (const candidate of discovery.candidates) {
		if (requestedIds.size > 0 && !requestedIds.has(candidate.driver_id)) continue;
		if (candidate.report_tier !== "candidate") {
			if (requestedIds.has(candidate.driver_id))
				excludedDrivers.push({
					driver_id: candidate.driver_id,
					label: candidate.label,
					reason: "not a reportable assumption",
				});
			continue;
		}
		if (typeof candidate.baseline_value !== "number" || !Number.isFinite(candidate.baseline_value)) {
			excludedDrivers.push({
				driver_id: candidate.driver_id,
				label: candidate.label,
				reason: "input is not numeric",
			});
			continue;
		}
		if (candidate.baseline_value === 0) {
			excludedDrivers.push({
				driver_id: candidate.driver_id,
				label: candidate.label,
				reason: "relative shock cannot perturb a zero baseline",
			});
			continue;
		}
		if (selected.length < maxDrivers) selected.push(candidate);
	}
	for (const requestedId of requestedIds) {
		if (!discovery.candidates.some((candidate) => candidate.driver_id === requestedId))
			excludedDrivers.push({
				driver_id: requestedId,
				label: requestedId,
				reason: "driver is not in the output dependency tree",
			});
	}
	if (selected.length === 0) throw new Error("No numeric upstream assumption is available for sensitivity testing");

	const trace = tracePeFormula(
		cwd,
		{
			docId: options.docId,
			sheetName: options.outputSheet,
			cellRef: options.outputCellRef,
			datasetId: options.datasetId,
			maxDepth: 20,
			maxNodes: 500,
		},
		signal,
	);
	const nodeByLocation = new Map(trace.nodes.map((node) => [`${node.sheet_name}\0${node.cell_ref}`, node]));
	const labelCache = new Map<string, string | undefined>();
	const nodeById = new Map(trace.nodes.map((node) => [node.cell_id, node]));
	const downstreamByNodeId = new Map<string, string[]>();
	for (const edge of trace.edges) {
		for (const targetId of edge.target_cell_ids) {
			const downstream = downstreamByNodeId.get(targetId) ?? [];
			downstream.push(edge.source_cell_id);
			downstreamByNodeId.set(targetId, downstream);
		}
	}
	const propagationLocationsByDriver = new Map<string, string[]>();
	const observationByLocation = new Map<string, WorkbookObservation>();
	const addObservation = (sheet: string, cell: string): void => {
		const location = `${sheet}\0${cell}`;
		if (observationByLocation.has(location)) return;
		observationByLocation.set(location, { key: `observation_${observationByLocation.size}`, sheet, cell });
	};
	addObservation(trace.root.sheet_name, trace.root.cell_ref);
	for (const candidate of selected) {
		const candidateNode = nodeByLocation.get(`${candidate.sheet_name}\0${candidate.cell_ref}`);
		if (!candidateNode) continue;
		const visited = new Set<string>();
		const queue = [candidateNode.cell_id];
		for (let index = 0; index < queue.length; index += 1) {
			const nodeId = queue[index];
			if (visited.has(nodeId)) continue;
			visited.add(nodeId);
			queue.push(...(downstreamByNodeId.get(nodeId) ?? []));
		}
		const propagationLocations = [...visited]
			.map((nodeId) => nodeById.get(nodeId))
			.filter((node) => node !== undefined)
			.sort(
				(left, right) =>
					right.depth - left.depth ||
					left.sheet_name.localeCompare(right.sheet_name) ||
					left.row_index - right.row_index ||
					left.col_index - right.col_index,
			)
			.map((node) => `${node.sheet_name}\0${node.cell_ref}`);
		propagationLocationsByDriver.set(candidate.driver_id, propagationLocations);
		for (const location of propagationLocations) {
			const separator = location.indexOf("\0");
			addObservation(location.slice(0, separator), location.slice(separator + 1));
		}
	}
	const extension = extname(prepared.filePath).toLowerCase();
	const scenarios: WorkbookScenario[] = [
		{
			scenario_id: "baseline",
			input_filename: `scenario_000_baseline${extension}`,
			result_filename: "scenario_000_baseline.xlsx",
			overrides: [],
		},
	];
	for (const [index, candidate] of selected.entries()) {
		const baseline = candidate.baseline_value as number;
		for (const direction of [-1, 1] as const) {
			const suffix = direction < 0 ? "down" : "up";
			const stem = `scenario_${String(index + 1).padStart(3, "0")}_${suffix}`;
			scenarios.push({
				scenario_id: `${candidate.driver_id}:${suffix}`,
				input_filename: `${stem}${extension}`,
				result_filename: `${stem}.xlsx`,
				overrides: [
					{
						sheet: candidate.sheet_name,
						cell: candidate.cell_ref,
						value: baseline + direction * Math.abs(baseline) * (shockPercent / 100),
					},
				],
			});
		}
	}
	const engine = await recalculateWithLibreOffice(
		prepared.filePath,
		{ observations: [...observationByLocation.values()], scenarios },
		signal,
	);
	const snapshotById = new Map(engine.snapshots.map((snapshot) => [snapshot.scenario_id, snapshot]));
	const outputObservation = observationByLocation.get(`${trace.root.sheet_name}\0${trace.root.cell_ref}`);
	const baselineSnapshot = snapshotById.get("baseline");
	if (!outputObservation || !baselineSnapshot) throw new Error("Recalculation baseline is missing");
	const baselineOutput = numeric(baselineSnapshot.values[outputObservation.key]);
	if (baselineOutput === undefined)
		throw new Error("Selected valuation output did not recalculate to a numeric value");

	const tested: PeDriverSensitivityResultItem[] = [];
	for (const candidate of selected) {
		const downSnapshot = snapshotById.get(`${candidate.driver_id}:down`);
		const upSnapshot = snapshotById.get(`${candidate.driver_id}:up`);
		const downOutput = downSnapshot ? numeric(downSnapshot.values[outputObservation.key]) : undefined;
		const upOutput = upSnapshot ? numeric(upSnapshot.values[outputObservation.key]) : undefined;
		if (!downSnapshot || !upSnapshot || downOutput === undefined || upOutput === undefined) {
			excludedDrivers.push({
				driver_id: candidate.driver_id,
				label: candidate.label,
				reason: "one or more recalculated output values are unavailable",
			});
			continue;
		}
		const baselineInput = candidate.baseline_value as number;
		const downInput = baselineInput - Math.abs(baselineInput) * (shockPercent / 100);
		const upInput = baselineInput + Math.abs(baselineInput) * (shockPercent / 100);
		const downOutputChange = downOutput - baselineOutput;
		const upOutputChange = upOutput - baselineOutput;
		const downOutputChangePercent = changePercent(downOutput, baselineOutput);
		const upOutputChangePercent = changePercent(upOutput, baselineOutput);
		const propagation: PeSensitivityPropagationNode[] = [];
		for (const location of propagationLocationsByDriver.get(candidate.driver_id) ?? []) {
			const separator = location.indexOf("\0");
			if (separator <= 0) continue;
			const sheetName = location.slice(0, separator);
			const cellRef = location.slice(separator + 1);
			const observation = observationByLocation.get(`${sheetName}\0${cellRef}`);
			if (!observation) continue;
			const baselineValue = numeric(baselineSnapshot.values[observation.key]);
			const downValue = numeric(downSnapshot.values[observation.key]);
			const upValue = numeric(upSnapshot.values[observation.key]);
			if (baselineValue === undefined || downValue === undefined || upValue === undefined) continue;
			const node = nodeByLocation.get(`${sheetName}\0${cellRef}`);
			propagation.push({
				sheet_name: sheetName,
				cell_ref: cellRef,
				label: node
					? (resolvePeDriverLabel(cwd, options.docId, options.datasetId, node, labelCache) ??
						`${sheetName}!${cellRef}`)
					: `${sheetName}!${cellRef}`,
				is_formula: node?.is_formula ?? false,
				baseline_value: baselineValue,
				down_value: downValue,
				up_value: upValue,
				...(changePercent(downValue, baselineValue) !== undefined
					? { down_change_percent: changePercent(downValue, baselineValue) }
					: {}),
				...(changePercent(upValue, baselineValue) !== undefined
					? { up_change_percent: changePercent(upValue, baselineValue) }
					: {}),
			});
		}
		const maximum = Math.max(Math.abs(downOutputChange), Math.abs(upOutputChange));
		const maximumPercent =
			downOutputChangePercent === undefined || upOutputChangePercent === undefined
				? undefined
				: Math.max(Math.abs(downOutputChangePercent), Math.abs(upOutputChangePercent));
		const tolerance = Math.max(1e-9, Math.abs(baselineOutput) * 1e-9);
		tested.push({
			rank: 0,
			driver_id: candidate.driver_id,
			role: candidate.role,
			label: candidate.label,
			sheet_name: candidate.sheet_name,
			cell_ref: candidate.cell_ref,
			baseline_input: baselineInput,
			down_input: downInput,
			up_input: upInput,
			baseline_output: baselineOutput,
			down_output: downOutput,
			up_output: upOutput,
			down_output_change: downOutputChange,
			up_output_change: upOutputChange,
			...(downOutputChangePercent !== undefined ? { down_output_change_percent: downOutputChangePercent } : {}),
			...(upOutputChangePercent !== undefined ? { up_output_change_percent: upOutputChangePercent } : {}),
			...(downOutputChangePercent !== undefined ? { down_elasticity: downOutputChangePercent / -shockPercent } : {}),
			...(upOutputChangePercent !== undefined ? { up_elasticity: upOutputChangePercent / shockPercent } : {}),
			max_abs_output_change: maximum,
			...(maximumPercent !== undefined ? { max_abs_output_change_percent: maximumPercent } : {}),
			active_driver: maximum > tolerance,
			propagation,
			markdown_citation: candidate.markdown_citation,
		});
	}
	const ranked = tested
		.sort(
			(left, right) =>
				(right.max_abs_output_change_percent ?? right.max_abs_output_change) -
					(left.max_abs_output_change_percent ?? left.max_abs_output_change) ||
				left.driver_id.localeCompare(right.driver_id),
		)
		.map((driver, index) => ({ ...driver, rank: index + 1 }));
	const originalUnchanged = sha256(prepared.filePath) === originalHash;
	if (!originalUnchanged) throw new Error("Immutable source workbook changed during sensitivity testing");
	const runId = randomUUID();
	const outputDirectory = join(prepared.workspaceRoot, "generated", "sensitivity", runId);
	mkdirSync(outputDirectory, { recursive: true });
	const resultPath = join(outputDirectory, "result.json");
	const summaryPath = join(outputDirectory, "summary.md");
	const result: PeDriverSensitivityResult = {
		schema_version: "1.0",
		run_id: runId,
		dataset_id: discovery.dataset_id,
		doc_id: options.docId,
		status: ranked.length === 0 ? "not_calculable" : excludedDrivers.length > 0 ? "partial" : "completed",
		engine: { name: engine.engine_name, version: engine.engine_version },
		output: {
			output_id: discovery.output.output_id,
			sheet_name: trace.root.sheet_name,
			cell_ref: trace.root.cell_ref,
			baseline_value: baselineOutput,
		},
		shock: { method: "relative_one_at_a_time", percent: shockPercent },
		tested_driver_count: ranked.length,
		active_driver_count: ranked.filter((driver) => driver.active_driver).length,
		sensitivity_ranking_available: ranked.length > 0,
		ranked_drivers: ranked,
		excluded_drivers: excludedDrivers,
		original_unchanged: originalUnchanged,
		artifacts: {
			result_json: relative(prepared.workspaceRoot, resultPath).replaceAll("\\", "/"),
			summary_markdown: relative(prepared.workspaceRoot, summaryPath).replaceAll("\\", "/"),
		},
		warnings: [
			...(prepared.document.file_type === "xlsm"
				? ["Macros and custom functions are not executed; drivers depending on them may be unavailable"]
				: []),
			...(trace.issues.length > 0
				? [`Formula trace reported: ${[...new Set(trace.issues.map((issue) => issue.code))].join(", ")}`]
				: []),
		],
		answer_contract:
			"Rank only ranked_drivers by measured valuation-output change. Each propagation array records the recalculated path from the perturbed upstream input through formula-derived intermediates to the selected output. Do not generalize one-at-a-time shocks into a joint scenario or claim unsupported causality.",
	};
	writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
	writeFileSync(summaryPath, buildSummary(result), "utf8");
	return result;
}

export const peDriverSensitivityTool = defineTool({
	name: "pe_driver_sensitivity",
	label: "PE Driver Sensitivity",
	description:
		"Shock numeric upstream assumptions one at a time in isolated workbook copies, recalculate the full Excel formula chain with LibreOffice, rank measured valuation changes, and save an audit artifact without modifying the source workbook.",
	promptSnippet: PE_DRIVER_SENSITIVITY_PROMPT_SNIPPET,
	parameters: Type.Object({
		doc_id: Type.String({ description: "Exact active workbook document ID.", minLength: 1 }),
		output_sheet: Type.String({ description: "Worksheet containing the selected valuation output.", minLength: 1 }),
		output_cell_ref: Type.String({ description: "A1 reference of the selected valuation output.", minLength: 2 }),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		driver_ids: Type.Optional(
			Type.Array(Type.String(), {
				description: "Optional driver IDs from pe_driver_discover. Omit to test eligible numeric candidates.",
				maxItems: MAX_DRIVERS,
			}),
		),
		shock_percent: Type.Optional(
			Type.Number({
				description: "Symmetric relative shock in percent. Defaults to 5.",
				minimum: 0.01,
				maximum: 100,
			}),
		),
		max_drivers: Type.Optional(
			Type.Integer({
				description: "Maximum inputs tested. Defaults to 10; maximum 20.",
				minimum: 1,
				maximum: MAX_DRIVERS,
			}),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const result = await runPeDriverSensitivity(
			ctx.cwd,
			{
				docId: params.doc_id,
				outputSheet: params.output_sheet,
				outputCellRef: params.output_cell_ref,
				datasetId: params.dataset_id,
				driverIds: params.driver_ids,
				shockPercent: params.shock_percent,
				maxDrivers: params.max_drivers,
			},
			signal,
		);
		return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
	},
});
