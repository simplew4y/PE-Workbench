import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GatewayTokenCipher } from "./token-cipher.ts";

export type ModelSource = "platform" | "custom";

export interface GatewaySessionInput {
  userId: string;
  dataNamespace: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  sessionExpiresAt: number;
}

export interface GatewaySession extends GatewaySessionInput {
  createdAt: number;
  updatedAt: number;
}

interface SessionRow {
  session_id_hash: string;
  user_id: string;
  data_namespace: string;
  email: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  access_expires_at: number;
  session_expires_at: number;
  created_at: number;
  updated_at: number;
}

interface CapabilityRow {
  user_id: string;
  data_namespace: string;
  expires_at: number;
}

export interface GatewayWorkerInstance {
  userId: string;
  dataNamespace: string;
  containerName: string;
  lastAccessAt: number;
  updatedAt: number;
}

interface WorkerInstanceRow {
  user_id: string;
  data_namespace: string;
  container_name: string;
  last_access_at: number;
  updated_at: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function assertUuid(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new Error(`${name} must be a canonical UUID`);
  return normalized;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export class PeGatewaySessionStore {
  private readonly database: DatabaseSync;
  private readonly cipher: GatewayTokenCipher;

  constructor(databasePath: string, cipher: GatewayTokenCipher) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath, { timeout: 10_000 });
    chmodSync(databasePath, 0o600);
    this.cipher = cipher;
    this.database.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
    this.migrate();
  }

  private migrate(): void {
    const row = this.database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    if (row.user_version > 3) {
      throw new Error(`Gateway database schema version ${row.user_version} is newer than this application supports`);
    }
    if (row.user_version === 3) return;

    if (row.user_version === 1) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          ALTER TABLE gateway_model_preferences ADD COLUMN selected_platform_model TEXT;
          PRAGMA user_version=2;
        `);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }

    const current = this.database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    if (current.user_version === 2) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS gateway_worker_instances (
            data_namespace TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            container_name TEXT NOT NULL UNIQUE,
            last_access_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_gateway_worker_instances_idle
            ON gateway_worker_instances(last_access_at);
          PRAGMA user_version=3;
        `);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
      return;
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS gateway_sessions (
        session_id_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        data_namespace TEXT NOT NULL,
        email TEXT NOT NULL,
        access_token_ciphertext TEXT NOT NULL,
        refresh_token_ciphertext TEXT NOT NULL,
        access_expires_at INTEGER NOT NULL,
        session_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_sessions_user
        ON gateway_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_gateway_sessions_expiry
        ON gateway_sessions(session_expires_at);

      CREATE TABLE IF NOT EXISTS gateway_model_preferences (
        user_id TEXT PRIMARY KEY,
        model_source TEXT NOT NULL CHECK (model_source IN ('platform', 'custom')),
        selected_platform_model TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gateway_worker_capabilities (
        capability_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        data_namespace TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_worker_capabilities_expiry
        ON gateway_worker_capabilities(expires_at);
      CREATE TABLE IF NOT EXISTS gateway_worker_instances (
        data_namespace TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        container_name TEXT NOT NULL UNIQUE,
        last_access_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_worker_instances_idle
        ON gateway_worker_instances(last_access_at);
      PRAGMA user_version=3;
    `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createSession(input: GatewaySessionInput, now = Math.floor(Date.now() / 1000)): string {
    const sessionId = randomToken("pes_");
    const sessionHash = hashSecret(sessionId);
    const userId = assertUuid(input.userId, "userId");
    const dataNamespace = assertUuid(input.dataNamespace, "dataNamespace");
    const email = input.email.trim().toLowerCase();
    if (!email || !input.accessToken || !input.refreshToken) throw new Error("Session credentials are incomplete");
    if (input.accessExpiresAt <= now || input.sessionExpiresAt <= now) {
      throw new Error("Session expiry must be in the future");
    }
    this.database.prepare(`
      INSERT INTO gateway_sessions (
        session_id_hash, user_id, data_namespace, email,
        access_token_ciphertext, refresh_token_ciphertext,
        access_expires_at, session_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionHash,
      userId,
      dataNamespace,
      email,
      this.cipher.encrypt(input.accessToken, `session:${sessionHash}:access`),
      this.cipher.encrypt(input.refreshToken, `session:${sessionHash}:refresh`),
      input.accessExpiresAt,
      input.sessionExpiresAt,
      now,
      now,
    );
    return sessionId;
  }

  getSession(sessionId: string, now = Math.floor(Date.now() / 1000)): GatewaySession | null {
    if (!sessionId) return null;
    const sessionHash = hashSecret(sessionId);
    const row = this.database
      .prepare("SELECT * FROM gateway_sessions WHERE session_id_hash = ?")
      .get(sessionHash) as unknown as SessionRow | undefined;
    if (!row) return null;
    if (row.session_expires_at <= now) {
      this.database.prepare("DELETE FROM gateway_sessions WHERE session_id_hash = ?").run(sessionHash);
      return null;
    }
    return {
      userId: row.user_id,
      dataNamespace: row.data_namespace,
      email: row.email,
      accessToken: this.cipher.decrypt(row.access_token_ciphertext, `session:${sessionHash}:access`),
      refreshToken: this.cipher.decrypt(row.refresh_token_ciphertext, `session:${sessionHash}:refresh`),
      accessExpiresAt: row.access_expires_at,
      sessionExpiresAt: row.session_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  updateTokens(
    sessionId: string,
    accessToken: string,
    refreshToken: string,
    accessExpiresAt: number,
    now = Math.floor(Date.now() / 1000),
  ): boolean {
    if (!sessionId || !accessToken || !refreshToken || accessExpiresAt <= now) return false;
    const sessionHash = hashSecret(sessionId);
    const result = this.database.prepare(`
      UPDATE gateway_sessions
      SET access_token_ciphertext = ?, refresh_token_ciphertext = ?, access_expires_at = ?, updated_at = ?
      WHERE session_id_hash = ? AND session_expires_at > ?
    `).run(
      this.cipher.encrypt(accessToken, `session:${sessionHash}:access`),
      this.cipher.encrypt(refreshToken, `session:${sessionHash}:refresh`),
      accessExpiresAt,
      now,
      sessionHash,
      now,
    );
    return result.changes === 1;
  }

  deleteSession(sessionId: string): boolean {
    if (!sessionId) return false;
    return this.database
      .prepare("DELETE FROM gateway_sessions WHERE session_id_hash = ?")
      .run(hashSecret(sessionId)).changes === 1;
  }

  setModelSource(userId: string, source: ModelSource, now = Math.floor(Date.now() / 1000)): void {
    const normalizedUserId = assertUuid(userId, "userId");
    if (source !== "platform" && source !== "custom") throw new Error("Invalid model source");
    this.database.prepare(`
      INSERT INTO gateway_model_preferences (user_id, model_source, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET model_source = excluded.model_source, updated_at = excluded.updated_at
    `).run(normalizedUserId, source, now);
  }

  getModelSource(userId: string): ModelSource | null {
    const row = this.database
      .prepare("SELECT model_source FROM gateway_model_preferences WHERE user_id = ?")
      .get(assertUuid(userId, "userId")) as unknown as { model_source: ModelSource } | undefined;
    return row?.model_source ?? null;
  }

  setPlatformModel(userId: string, modelId: string, now = Math.floor(Date.now() / 1000)): void {
    const normalizedUserId = assertUuid(userId, "userId");
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId || normalizedModelId.length > 200) throw new Error("Invalid platform model id");
    this.database.prepare(`
      INSERT INTO gateway_model_preferences
        (user_id, model_source, selected_platform_model, updated_at)
      VALUES (?, 'platform', ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        selected_platform_model = excluded.selected_platform_model,
        updated_at = excluded.updated_at
    `).run(normalizedUserId, normalizedModelId, now);
  }

  getPlatformModel(userId: string): string | null {
    const row = this.database
      .prepare("SELECT selected_platform_model FROM gateway_model_preferences WHERE user_id = ?")
      .get(assertUuid(userId, "userId")) as unknown as { selected_platform_model: string | null } | undefined;
    return row?.selected_platform_model ?? null;
  }

  createWorkerCapability(
    userId: string,
    dataNamespace: string,
    expiresAt: number,
    now = Math.floor(Date.now() / 1000),
  ): string {
    if (expiresAt <= now) throw new Error("Worker capability expiry must be in the future");
    const capability = randomToken("pew_");
    this.database.prepare(`
      INSERT INTO gateway_worker_capabilities
        (capability_hash, user_id, data_namespace, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      hashSecret(capability),
      assertUuid(userId, "userId"),
      assertUuid(dataNamespace, "dataNamespace"),
      expiresAt,
      now,
    );
    return capability;
  }

  resolveWorkerCapability(
    capability: string,
    now = Math.floor(Date.now() / 1000),
  ): { userId: string; dataNamespace: string } | null {
    if (!capability) return null;
    const capabilityHash = hashSecret(capability);
    const row = this.database.prepare(`
      SELECT user_id, data_namespace, expires_at
      FROM gateway_worker_capabilities
      WHERE capability_hash = ?
    `).get(capabilityHash) as unknown as CapabilityRow | undefined;
    if (!row) return null;
    if (row.expires_at <= now) {
      this.database.prepare("DELETE FROM gateway_worker_capabilities WHERE capability_hash = ?").run(capabilityHash);
      return null;
    }
    return { userId: row.user_id, dataNamespace: row.data_namespace };
  }

  revokeWorkerCapabilities(userId: string): number {
    return Number(this.database
      .prepare("DELETE FROM gateway_worker_capabilities WHERE user_id = ?")
      .run(assertUuid(userId, "userId")).changes);
  }

  touchWorkerInstance(
    userId: string,
    dataNamespace: string,
    containerName: string,
    now = Math.floor(Date.now() / 1000),
  ): GatewayWorkerInstance {
    const normalizedUserId = assertUuid(userId, "userId");
    const normalizedNamespace = assertUuid(dataNamespace, "dataNamespace");
    if (!/^pe-worker-[0-9a-f]{32}$/u.test(containerName)) {
      throw new Error("containerName is invalid");
    }
    const existing = this.getWorkerInstance(normalizedNamespace);
    if (
      existing
      && (existing.userId !== normalizedUserId || existing.containerName !== containerName)
    ) {
      throw new Error("Worker namespace is already owned by another identity");
    }
    this.database.prepare(`
      INSERT INTO gateway_worker_instances
        (data_namespace, user_id, container_name, last_access_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(data_namespace) DO UPDATE SET
        last_access_at = excluded.last_access_at,
        updated_at = excluded.updated_at
    `).run(normalizedNamespace, normalizedUserId, containerName, now, now);
    return this.getWorkerInstance(normalizedNamespace)!;
  }

  getWorkerInstance(dataNamespace: string): GatewayWorkerInstance | null {
    const row = this.database.prepare(`
      SELECT user_id, data_namespace, container_name, last_access_at, updated_at
      FROM gateway_worker_instances
      WHERE data_namespace = ?
    `).get(assertUuid(dataNamespace, "dataNamespace")) as unknown as WorkerInstanceRow | undefined;
    return row ? {
      userId: row.user_id,
      dataNamespace: row.data_namespace,
      containerName: row.container_name,
      lastAccessAt: row.last_access_at,
      updatedAt: row.updated_at,
    } : null;
  }

  listIdleWorkerInstances(
    lastAccessBeforeOrAt: number,
  ): GatewayWorkerInstance[] {
    const rows = this.database.prepare(`
      SELECT user_id, data_namespace, container_name, last_access_at, updated_at
      FROM gateway_worker_instances
      WHERE last_access_at <= ?
      ORDER BY last_access_at ASC
    `).all(lastAccessBeforeOrAt) as unknown as WorkerInstanceRow[];
    return rows.map((row) => ({
      userId: row.user_id,
      dataNamespace: row.data_namespace,
      containerName: row.container_name,
      lastAccessAt: row.last_access_at,
      updatedAt: row.updated_at,
    }));
  }

  deleteWorkerInstance(dataNamespace: string): boolean {
    return this.database.prepare("DELETE FROM gateway_worker_instances WHERE data_namespace = ?")
      .run(assertUuid(dataNamespace, "dataNamespace")).changes === 1;
  }

  deleteExpired(now = Math.floor(Date.now() / 1000)): { sessions: number; capabilities: number } {
    const sessions = this.database
      .prepare("DELETE FROM gateway_sessions WHERE session_expires_at <= ?")
      .run(now).changes;
    const capabilities = this.database
      .prepare("DELETE FROM gateway_worker_capabilities WHERE expires_at <= ?")
      .run(now).changes;
    return { sessions: Number(sessions), capabilities: Number(capabilities) };
  }

  close(): void {
    this.database.close();
  }
}
