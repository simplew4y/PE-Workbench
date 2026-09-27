import {
  PeSourceError,
  resolvePeEvidenceSource as resolveCoreEvidenceSource,
} from "@earendil-works/pe-boot";
import type { PeSourcePayload } from "./pe-source";

export { PeSourceError };

export interface ResolvedPeSource {
  payload: PeSourcePayload;
  filePath?: string;
}

export async function resolvePeEvidenceSource(
  cwd: string,
  evidenceId: string,
  signal?: AbortSignal,
): Promise<ResolvedPeSource> {
  const result = await resolveCoreEvidenceSource(cwd, evidenceId, signal);
  return { payload: result.payload, filePath: result.filePath };
}
