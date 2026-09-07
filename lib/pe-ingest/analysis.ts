import { spawn } from "node:child_process";
import { isPeConsensusEnabled } from "@earendil-works/pe-boot";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ANALYZER_OUTPUT_BYTES = 1_000_000;

export interface PeClaimAnalysisInput {
  collectionPath: string;
  datasetId: string;
  companyName?: string;
  ingestedAt?: string;
  docIds?: string[];
}

export type PeClaimAnalysisSummary = Record<string, unknown> & { status: string };

function analyzerPath(): string {
  const target = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../services/pe-ingest/analyze_collection.py",
  );
  if (!existsSync(target)) throw new Error(`PE claim analyzer is missing: ${target}`);
  return target;
}

function pythonCandidates(): string[] {
  const configured = [
    process.env.PE_INGEST_ANALYSIS_PYTHON,
    process.env.PE_DOCUMENT_PYTHON,
    process.env.PE_EXCEL_PYTHON,
  ].find((value) => value?.trim());
  if (configured) return [configured.trim()];
  return process.platform === "win32" ? ["python"] : ["python3", "python"];
}

function runAnalyzer(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: path.dirname(analyzerPath()),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_ANALYZER_OUTPUT_BYTES) {
        child.kill();
        fail(new Error("PE claim analyzer returned too much output"));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_ANALYZER_OUTPUT_BYTES);
    });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PE claim analyzer exited: ${signal ?? code}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export async function runPeClaimAnalysis(input: PeClaimAnalysisInput): Promise<PeClaimAnalysisSummary> {
  // Consensus/divergence is still under development: it stays off unless a deployment opts in,
  // so a production install never spends model calls building cards during ingest.
  if (!isPeConsensusEnabled()) return { status: "skipped_disabled" };
  const args = [
    analyzerPath(),
    "--collection", input.collectionPath,
    "--dataset-id", input.datasetId,
  ];
  if (input.companyName) args.push("--company-name", input.companyName);
  if (input.ingestedAt) args.push("--ingested-at", input.ingestedAt);
  for (const docId of new Set(input.docIds ?? [])) args.push("--doc-id", docId);

  let lastError: unknown;
  for (const executable of pythonCandidates()) {
    try {
      const { stdout } = await runAnalyzer(executable, args);
      const parsed = JSON.parse(stdout) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("PE claim analyzer returned invalid JSON");
      }
      const status = (parsed as Record<string, unknown>).status;
      if (typeof status !== "string" || !status) {
        throw new Error("PE claim analyzer returned no status");
      }
      return parsed as PeClaimAnalysisSummary;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No Python interpreter is available for PE claim analysis");
}
