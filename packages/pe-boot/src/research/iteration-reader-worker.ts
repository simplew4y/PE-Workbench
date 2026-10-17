import { parentPort, workerData } from "node:worker_threads";
// Initialize the research entrypoint before the model adapter, matching the
// public SDK entrypoint's order through the existing research module cycle.
import "./iteration.ts";
import { validateAutomaticSetup } from "./automatic-setup.ts";
import { readCurrentIterationWorkbook } from "./iteration-model-update.ts";
import type { IterationReadRequest, SetupValidationRequest } from "./iteration-reader.ts";
import { ResearchError } from "./model.ts";
import { readResearchInput } from "./pi-engine.ts";

const request = workerData as (IterationReadRequest & { action: "read" }) | SetupValidationRequest;
try {
	if (request.action === "validate") {
		parentPort?.postMessage({
			result: validateAutomaticSetup(request.cwd, request.datasetId, request.run, request.basis, request.submitted),
		});
	} else {
		let result = readResearchInput(request.cwd, request.datasetId, request.input, request.params) as Record<
			string,
			unknown
		>;
		if (request.currentWorkbook && (result.file_type === "xlsx" || result.file_type === "xlsm"))
			result = readCurrentIterationWorkbook(request.cwd, request.datasetId, request.params.docId, {
				...request.params,
				action: request.params.action ?? (request.params.range || request.params.ranges ? "read" : "inspect"),
			});
		parentPort?.postMessage({ result });
	}
} catch (error) {
	parentPort?.postMessage({
		error: error instanceof Error ? error.message : String(error),
		status: error instanceof ResearchError ? error.status : undefined,
	});
}
