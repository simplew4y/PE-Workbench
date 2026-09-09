import { isAbsolute, resolve } from "node:path";

export interface PeGatewayConfig {
  backendUrl: string;
  databasePath: string;
  sessionSecret: Buffer;
  sessionTtlSeconds: number;
  backendTimeoutMs: number;
  cookie: {
    name: string;
    path: string;
    secure: boolean;
  };
  worker: {
    storage: "bind" | "volume";
    image: string;
    dataRoot: string;
    idleSeconds: number;
    capabilityTtlSeconds: number;
    startTimeoutMs: number;
    cpuLimit: number;
    memoryMb: number;
    pidsLimit: number;
    uid: number;
    gid: number;
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = positiveNumber(value, fallback, name);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function dockerImage(value: string | undefined): string {
  const image = value?.trim() || "pe-workbench-worker:local";
  if (image.length > 255 || image.startsWith("-") || /\s/u.test(image)) {
    throw new Error("PE_WORKER_IMAGE is invalid");
  }
  return image;
}

function workerStorage(value: string | undefined): "bind" | "volume" {
  const storage = value?.trim().toLowerCase() || "bind";
  if (storage !== "bind" && storage !== "volume") {
    throw new Error("PE_WORKER_STORAGE must be bind or volume");
  }
  return storage;
}

function parseSecret(value: string): Buffer {
  const secret = /^[0-9a-f]{64}$/iu.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (secret.length < 32) {
    throw new Error("PE_SESSION_SECRET must contain at least 32 bytes encoded as hex or base64");
  }
  return secret;
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

export function loadPeGatewayConfig(env: NodeJS.ProcessEnv = process.env): PeGatewayConfig {
  const backend = new URL(required(env, "PE_BACKEND_URL"));
  if (!["http:", "https:"].includes(backend.protocol) || backend.username || backend.password) {
    throw new Error("PE_BACKEND_URL must be an absolute HTTP(S) URL without embedded credentials");
  }

  const configuredDatabasePath = required(env, "PE_GATEWAY_DATABASE_PATH");
  if (!isAbsolute(configuredDatabasePath)) throw new Error("PE_GATEWAY_DATABASE_PATH must be absolute");
  const databasePath = resolve(configuredDatabasePath);

  const configuredWorkerDataRoot = env.PE_WORKER_DATA_ROOT?.trim() || "/srv/pe-workbench/users";
  if (!isAbsolute(configuredWorkerDataRoot)) throw new Error("PE_WORKER_DATA_ROOT must be absolute");
  if (configuredWorkerDataRoot.includes(",")) throw new Error("PE_WORKER_DATA_ROOT cannot contain commas");
  const workerDataRoot = resolve(configuredWorkerDataRoot);

  const cookieName = env.PE_SESSION_COOKIE_NAME?.trim() || "pe_workbench_session";
  if (!/^[A-Za-z0-9_-]+$/u.test(cookieName)) throw new Error("PE_SESSION_COOKIE_NAME is invalid");
  const cookiePath = env.PE_SESSION_COOKIE_PATH?.trim() || "/pe_workbench";
  if (!cookiePath.startsWith("/")) throw new Error("PE_SESSION_COOKIE_PATH must start with /");

  return {
    backendUrl: backend.toString().replace(/\/$/u, ""),
    databasePath,
    sessionSecret: parseSecret(required(env, "PE_SESSION_SECRET")),
    sessionTtlSeconds: Math.floor(
      positiveNumber(env.PE_SESSION_TTL_HOURS, 168, "PE_SESSION_TTL_HOURS") * 3600,
    ),
    backendTimeoutMs: Math.floor(
      positiveNumber(env.PE_BACKEND_TIMEOUT_SECONDS, 10, "PE_BACKEND_TIMEOUT_SECONDS") * 1000,
    ),
    cookie: {
      name: cookieName,
      path: cookiePath,
      secure: parseBoolean(env.PE_SESSION_COOKIE_SECURE, true, "PE_SESSION_COOKIE_SECURE"),
    },
    worker: {
      storage: workerStorage(env.PE_WORKER_STORAGE),
      image: dockerImage(env.PE_WORKER_IMAGE),
      dataRoot: workerDataRoot,
      idleSeconds: positiveInteger(env.PE_WORKER_IDLE_MINUTES, 30, "PE_WORKER_IDLE_MINUTES") * 60,
      capabilityTtlSeconds: positiveInteger(
        env.PE_WORKER_CAPABILITY_TTL_HOURS,
        168,
        "PE_WORKER_CAPABILITY_TTL_HOURS",
      ) * 3600,
      startTimeoutMs: positiveInteger(
        env.PE_WORKER_START_TIMEOUT_SECONDS,
        120,
        "PE_WORKER_START_TIMEOUT_SECONDS",
      ) * 1000,
      cpuLimit: positiveNumber(env.PE_WORKER_CPU_LIMIT, 2, "PE_WORKER_CPU_LIMIT"),
      memoryMb: positiveInteger(env.PE_WORKER_MEMORY_MB, 4096, "PE_WORKER_MEMORY_MB"),
      pidsLimit: positiveInteger(env.PE_WORKER_PIDS_LIMIT, 256, "PE_WORKER_PIDS_LIMIT"),
      uid: positiveInteger(env.PE_WORKER_UID, 1000, "PE_WORKER_UID"),
      gid: positiveInteger(env.PE_WORKER_GID, 1000, "PE_WORKER_GID"),
    },
  };
}
