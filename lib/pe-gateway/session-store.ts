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
    // Additive cache: public model descriptors only, never account/model tokens.
    this.database.exec(`CREATE TABLE IF NOT EXISTS gateway_platform_catalog (
      user_id TEXT PRIMARY KEY, catalog_json TEXT NOT NULL
    )`);
  }

  private migrate(): void {
    const row = this.database.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    if (row.user_version > 4) {
      throw new Error(`Gateway database schema version ${row.user_version} is newer than this application supports`);
    }
    if (row.user_version === 4) return;

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
          DROP TABLE IF EXISTS gateway_worker_capabilities;
          DROP TABLE IF EXISTS gateway_worker_instances;
          PRAGMA user_version=4;
        `);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
      return;
    }

    if (current.user_version === 3) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          DROP TABLE IF EXISTS gateway_worker_capabilities;
          DROP TABLE IF EXISTS gateway_worker_instances;
          PRAGMA user_version=4;
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

      PRAGMA user_version=4;
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

  setPlatformCatalog(userId: string, catalog: unknown): void {
    this.database.prepare(`INSERT INTO gateway_platform_catalog (user_id, catalog_json) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET catalog_json = excluded.catalog_json`)
      .run(assertUuid(userId, "userId"), JSON.stringify(catalog));
  }

  getPlatformCatalog(userId: string): unknown {
    const row = this.database.prepare("SELECT catalog_json FROM gateway_platform_catalog WHERE user_id = ?")
      .get(assertUuid(userId, "userId")) as { catalog_json: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.catalog_json); } catch { return null; }
  }

  deleteExpired(now = Math.floor(Date.now() / 1000)): { sessions: number } {
    const sessions = this.database
      .prepare("DELETE FROM gateway_sessions WHERE session_expires_at <= ?")
      .run(now).changes;
    return { sessions: Number(sessions) };
  }

  close(): void {
    this.database.close();
  }
}
