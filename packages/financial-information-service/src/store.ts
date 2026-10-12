import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildCandidate } from "./classifier.ts";
import type {
	DownloadedDisclosure,
	FrameworkUpdateCandidate,
	InformationSubscription,
	RunResult,
	SubscriptionInput,
} from "./types.ts";
import { validateSubscriptionInput } from "./validation.ts";

interface Row {
	[key: string]: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriptions(
 id TEXT PRIMARY KEY, config_json TEXT NOT NULL, enabled INTEGER NOT NULL,
 next_run_at INTEGER NOT NULL, last_checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_documents(
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, external_id TEXT NOT NULL, content_hash TEXT NOT NULL,
 metadata_json TEXT NOT NULL, raw_path TEXT NOT NULL, content_type TEXT NOT NULL, file_size INTEGER NOT NULL,
 retrieved_at TEXT NOT NULL, UNIQUE(provider,external_id,content_hash)
);
CREATE TABLE IF NOT EXISTS candidates(
 id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, document_id TEXT NOT NULL, payload_json TEXT NOT NULL,
 status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
 last_error TEXT, created_at TEXT NOT NULL, delivered_at TEXT, UNIQUE(subscription_id,document_id)
);
CREATE TABLE IF NOT EXISTS runs(
 id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT NOT NULL,
 started_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS candidates_delivery ON candidates(status,next_attempt_at,created_at);
CREATE INDEX IF NOT EXISTS subscriptions_due ON subscriptions(enabled,next_run_at);
`;

function subscriptionFromRow(row: Row): InformationSubscription {
	const config = JSON.parse(String(row.config_json)) as Omit<
		InformationSubscription,
		"id" | "nextRunAt" | "lastCheckedAt" | "createdAt" | "updatedAt"
	>;
	return {
		id: String(row.id),
		...config,
		nextRunAt: Number(row.next_run_at),
		lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export class InformationStore {
	readonly #database: DatabaseSync;
	readonly #dataDirectory: string;

	constructor(databasePath: string, dataDirectory = dirname(databasePath)) {
		mkdirSync(dirname(databasePath), { recursive: true });
		mkdirSync(dataDirectory, { recursive: true });
		this.#dataDirectory = dataDirectory;
		this.#database = new DatabaseSync(databasePath, { timeout: 10_000 });
		this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
		this.#database.exec(SCHEMA);
	}

	close(): void {
		this.#database.close();
	}

	createSubscription(input: SubscriptionInput, id: string = randomUUID()): InformationSubscription {
		const config = validateSubscriptionInput(input);
		const now = new Date().toISOString();
		this.#database
			.prepare("INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?)")
			.run(id, JSON.stringify(config), Number(config.enabled), Date.now(), null, now, now);
		return this.getSubscription(id);
	}

	getSubscription(id: string): InformationSubscription {
		const row = this.#database.prepare("SELECT * FROM subscriptions WHERE id=?").get(id) as Row | undefined;
		if (!row) throw new Error(`Subscription not found: ${id}`);
		return subscriptionFromRow(row);
	}

	listSubscriptions(): InformationSubscription[] {
		return (this.#database.prepare("SELECT * FROM subscriptions ORDER BY created_at").all() as Row[]).map(
			subscriptionFromRow,
		);
	}

	dueSubscriptions(now = Date.now()): InformationSubscription[] {
		return (
			this.#database
				.prepare("SELECT * FROM subscriptions WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 100")
				.all(now) as Row[]
		).map(subscriptionFromRow);
	}

	markSubscriptionChecked(subscription: InformationSubscription, checkedAt: string): void {
		const nextRunAt = Date.now() + subscription.intervalMinutes * 60_000;
		this.#database
			.prepare("UPDATE subscriptions SET last_checked_at=?,next_run_at=?,updated_at=? WHERE id=?")
			.run(checkedAt, nextRunAt, new Date().toISOString(), subscription.id);
	}

	deferSubscription(subscription: InformationSubscription): void {
		const nextRunAt = Date.now() + subscription.intervalMinutes * 60_000;
		this.#database
			.prepare("UPDATE subscriptions SET next_run_at=?,updated_at=? WHERE id=?")
			.run(nextRunAt, new Date().toISOString(), subscription.id);
	}

	startRun(subscriptionId: string): { id: string; startedAt: string } {
		const id = randomUUID();
		const startedAt = new Date().toISOString();
		this.#database.prepare("INSERT INTO runs VALUES(?,?,'running','{}',?,NULL)").run(id, subscriptionId, startedAt);
		return { id, startedAt };
	}

	finishRun(result: RunResult): void {
		this.#database
			.prepare("UPDATE runs SET status='completed',result_json=?,finished_at=? WHERE id=? AND status='running'")
			.run(JSON.stringify(result), result.finishedAt, result.runId);
	}

	failRun(id: string, error: unknown): void {
		const finishedAt = new Date().toISOString();
		this.#database
			.prepare("UPDATE runs SET status='failed',result_json=?,finished_at=? WHERE id=? AND status='running'")
			.run(
				JSON.stringify({ error: error instanceof Error ? error.message : String(error), finishedAt }),
				finishedAt,
				id,
			);
	}

	saveDisclosure(
		subscription: InformationSubscription,
		downloaded: DownloadedDisclosure,
	): { candidate: FrameworkUpdateCandidate; created: boolean } {
		const contentHash = createHash("sha256").update(downloaded.bytes).digest("hex");
		const prior = this.#database
			.prepare("SELECT id FROM source_documents WHERE provider=? AND external_id=? AND content_hash=?")
			.get(downloaded.disclosure.provider, downloaded.disclosure.externalId, contentHash) as Row | undefined;
		const documentId = prior ? String(prior.id) : randomUUID();
		const extension = downloaded.contentType === "application/pdf" ? ".pdf" : ".html";
		const relativePath = join("raw", downloaded.disclosure.provider, `${contentHash}${extension}`);
		const absolutePath = join(this.#dataDirectory, relativePath);
		if (!prior) {
			mkdirSync(dirname(absolutePath), { recursive: true });
			if (!existsSync(absolutePath)) writeFileSync(absolutePath, downloaded.bytes, { mode: 0o600 });
			this.#database
				.prepare("INSERT INTO source_documents VALUES(?,?,?,?,?,?,?,?,?)")
				.run(
					documentId,
					downloaded.disclosure.provider,
					downloaded.disclosure.externalId,
					contentHash,
					JSON.stringify({ ...downloaded.disclosure, retrievedUrl: downloaded.retrievedUrl }),
					relativePath,
					downloaded.contentType,
					downloaded.bytes.byteLength,
					new Date().toISOString(),
				);
		}
		const existing = this.#database
			.prepare("SELECT payload_json FROM candidates WHERE subscription_id=? AND document_id=?")
			.get(subscription.id, documentId) as Row | undefined;
		if (existing)
			return { candidate: JSON.parse(String(existing.payload_json)) as FrameworkUpdateCandidate, created: false };
		const candidateId = randomUUID();
		const createdAt = new Date().toISOString();
		const candidate = buildCandidate(
			candidateId,
			subscription.id,
			subscription.datasetId,
			downloaded.disclosure,
			contentHash,
			downloaded.contentType,
			downloaded.retrievedUrl,
			createdAt,
		);
		this.#database
			.prepare("INSERT INTO candidates VALUES(?,?,?,?,'pending',0,0,NULL,?,NULL)")
			.run(candidateId, subscription.id, documentId, JSON.stringify(candidate), createdAt);
		return { candidate, created: true };
	}

	pendingCandidates(
		now = Date.now(),
		limit = 20,
	): Array<{
		candidate: FrameworkUpdateCandidate;
		bytes: Uint8Array;
		attempts: number;
	}> {
		const rows = this.#database
			.prepare(`SELECT c.payload_json,c.attempts,d.raw_path FROM candidates c
			JOIN source_documents d ON d.id=c.document_id
			WHERE c.status='pending' AND c.next_attempt_at<=? ORDER BY c.created_at LIMIT ?`)
			.all(now, limit) as Row[];
		return rows.map((row) => ({
			candidate: JSON.parse(String(row.payload_json)) as FrameworkUpdateCandidate,
			bytes: readFileSync(join(this.#dataDirectory, String(row.raw_path))),
			attempts: Number(row.attempts),
		}));
	}

	markDelivered(id: string): void {
		this.#database
			.prepare("UPDATE candidates SET status='delivered',delivered_at=?,last_error=NULL WHERE id=?")
			.run(new Date().toISOString(), id);
	}

	markDeliveryFailed(id: string, attempts: number, error: unknown): void {
		const delay = Math.min(60 * 60_000, 2 ** Math.min(attempts, 10) * 30_000);
		this.#database
			.prepare("UPDATE candidates SET attempts=?,next_attempt_at=?,last_error=? WHERE id=?")
			.run(
				attempts + 1,
				Date.now() + delay,
				error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
				id,
			);
	}

	listCandidates(status?: string): FrameworkUpdateCandidate[] {
		const rows = status
			? (this.#database
					.prepare("SELECT payload_json FROM candidates WHERE status=? ORDER BY created_at DESC")
					.all(status) as Row[])
			: (this.#database.prepare("SELECT payload_json FROM candidates ORDER BY created_at DESC").all() as Row[]);
		return rows.map((row) => JSON.parse(String(row.payload_json)) as FrameworkUpdateCandidate);
	}
}
