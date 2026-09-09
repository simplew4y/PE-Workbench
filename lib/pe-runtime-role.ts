import { timingSafeEqual } from "node:crypto";

export type PeRuntimeRole = "gateway" | "worker";

export function getPeRuntimeRole(env: NodeJS.ProcessEnv = process.env): PeRuntimeRole {
  return env.PE_RUNTIME_ROLE?.trim().toLowerCase() === "worker" ? "worker" : "gateway";
}

export function isPeWorkerRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return getPeRuntimeRole(env) === "worker";
}

export function isPeWorkerRequestAuthorized(
  request: Pick<Request, "headers">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isPeWorkerRuntime(env)) return false;
  const expected = env.PE_WORKER_CAPABILITY?.trim() ?? "";
  const supplied = request.headers.get("x-pe-worker-capability")?.trim() ?? "";
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
