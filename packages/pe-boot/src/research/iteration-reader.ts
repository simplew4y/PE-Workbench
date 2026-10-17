import { Worker } from "node:worker_threads";
import type { AutomaticSetup } from "./automatic-setup.ts";
import type { FrameworkIteration } from "./iteration-model.ts";
import { type FrameworkContent, ResearchError, type ResearchInput } from "./model.ts";
import type { readResearchInput } from "./pi-engine.ts";

export interface IterationReadRequest {
	cwd: string;
	datasetId: string;
	input: { objective: string; inputs: ResearchInput[]; asOf: string };
	params: Parameters<typeof readResearchInput>[3];
	currentWorkbook: boolean;
}

/** Keep expensive synchronous workbook parsing away from the lease heartbeat. */
export async function readIterationInput(
	request: IterationReadRequest,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	return runReader({ action: "read", ...request }, signal);
}

export interface SetupValidationRequest {
	action: "validate";
	cwd: string;
	datasetId: string;
	run: FrameworkIteration;
	basis: FrameworkContent;
	submitted: unknown;
}

export function validateIterationSetup(
	cwd: string,
	datasetId: string,
	run: FrameworkIteration,
	basis: FrameworkContent,
	submitted: unknown,
	signal: AbortSignal,
): Promise<AutomaticSetup> {
	return runReader({ action: "validate", cwd, datasetId, run, basis, submitted }, signal);
}

async function runReader<T>(
	request: (IterationReadRequest & { action: "read" }) | SetupValidationRequest,
	signal: AbortSignal,
): Promise<T> {
	signal.throwIfAborted();
	const worker = new Worker(
		new URL(
			import.meta.url.endsWith(".ts") ? "./iteration-reader-worker.ts" : "./iteration-reader-worker.js",
			import.meta.url,
		),
		{ workerData: request },
	);
	try {
		return await new Promise((resolve, reject) => {
			const abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			const cleanup = () => signal.removeEventListener("abort", abort);
			worker.once("message", (message: { result?: T; error?: string; status?: number }) => {
				cleanup();
				if (message.error)
					reject(message.status ? new ResearchError(message.status, message.error) : new Error(message.error));
				else if (message.result) resolve(message.result);
				else reject(new Error("Invalid iteration reader response"));
			});
			worker.once("error", (error) => {
				cleanup();
				reject(error);
			});
			worker.once("exit", (code) => {
				cleanup();
				reject(new Error(`Iteration reader exited: ${code}`));
			});
			if (signal.aborted) abort();
		});
	} finally {
		await worker.terminate();
	}
}
