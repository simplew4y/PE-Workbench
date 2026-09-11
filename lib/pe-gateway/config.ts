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

  const cookieName = env.PE_SESSION_COOKIE_NAME?.trim() || "pe_workbench_session";
  if (!/^[A-Za-z0-9_-]+$/u.test(cookieName)) throw new Error("PE_SESSION_COOKIE_NAME is invalid");
  const cookiePath = env.PE_SESSION_COOKIE_PATH?.trim() || "/";
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
      secure: parseBoolean(env.PE_SESSION_COOKIE_SECURE, false, "PE_SESSION_COOKIE_SECURE"),
    },
  };
}
