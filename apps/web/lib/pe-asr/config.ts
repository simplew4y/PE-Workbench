import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import {
  PE_ASR_DEFAULT_CHUNK_SECONDS,
  PE_ASR_MAX_CHUNK_SECONDS,
  PE_ASR_MIN_CHUNK_SECONDS,
  PE_ASR_NOT_CONFIGURED_MESSAGE,
} from "./constants";

export {
  PE_ASR_DEFAULT_CHUNK_SECONDS,
  PE_ASR_MAX_CHUNK_SECONDS,
  PE_ASR_MIN_CHUNK_SECONDS,
  PE_ASR_NOT_CONFIGURED_MESSAGE,
} from "./constants";

export interface PeAsrConfig {
  serverUrl: string;
  maxChunkSeconds: number;
  language: string;
}

export interface PeAsrConfigView extends PeAsrConfig {
  configured: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getAsrConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, "asr.json");
}

export function normalizeAsrServerUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

export function isConfiguredAsrServerUrl(value: string): boolean {
  const url = normalizeAsrServerUrl(value);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeChunkSeconds(value: unknown, fallback = PE_ASR_DEFAULT_CHUNK_SECONDS): number {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  if (!Number.isInteger(raw) || raw < PE_ASR_MIN_CHUNK_SECONDS || raw > PE_ASR_MAX_CHUNK_SECONDS) {
    throw new Error(`maxChunkSeconds must be an integer from ${PE_ASR_MIN_CHUNK_SECONDS} to ${PE_ASR_MAX_CHUNK_SECONDS}`);
  }
  return raw;
}

export function defaultPeAsrConfig(): PeAsrConfig {
  return {
    serverUrl: "",
    maxChunkSeconds: PE_ASR_DEFAULT_CHUNK_SECONDS,
    language: "",
  };
}

export function parsePeAsrConfig(value: unknown): PeAsrConfig {
  const fallback = defaultPeAsrConfig();
  if (!isRecord(value)) return fallback;
  const serverUrl = typeof value.serverUrl === "string" ? normalizeAsrServerUrl(value.serverUrl) : "";
  if (serverUrl && !isConfiguredAsrServerUrl(serverUrl)) {
    throw new Error("ASR server URL must be an http or https address");
  }
  return {
    serverUrl,
    maxChunkSeconds: value.maxChunkSeconds === undefined
      ? fallback.maxChunkSeconds
      : normalizeChunkSeconds(value.maxChunkSeconds),
    language: typeof value.language === "string" ? value.language.trim() : "",
  };
}

export function asrConfigView(config: PeAsrConfig): PeAsrConfigView {
  return { ...config, configured: isConfiguredAsrServerUrl(config.serverUrl) };
}

export function readPeAsrConfig(configPath = getAsrConfigPath()): PeAsrConfig {
  if (!existsSync(configPath)) return defaultPeAsrConfig();
  try {
    return parsePeAsrConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) return defaultPeAsrConfig();
    throw error;
  }
}

export function writePeAsrConfig(config: PeAsrConfig, configPath = getAsrConfigPath()): PeAsrConfig {
  const normalized = parsePeAsrConfig(config);
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function requireConfiguredPeAsr(config: PeAsrConfig = readPeAsrConfig()): PeAsrConfig {
  if (!isConfiguredAsrServerUrl(config.serverUrl)) {
    throw new Error(PE_ASR_NOT_CONFIGURED_MESSAGE);
  }
  return config;
}
