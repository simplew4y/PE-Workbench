import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getPeProject } from "./pe-project-store";

/**
 * Read-only access to the consensus/divergence cards the ingest worker writes
 * into a project's collection.sqlite3. The cards are derived data: every number
 * on them was computed by services/pe-ingest/pipeline/consensus_cards.py from
 * atomic_claims, and every card carries the claim and evidence IDs it came from
 * so the UI can link back to the source. Current PDF claims use page:<page_id>;
 * legacy chunk:<id> evidence remains readable during migration.
 */

export type PeCardType = "consensus" | "divergence" | "single_view";

export interface PeCardSide {
  issuer_key: string;
  issuer_name: string;
  value_display: string;
  reason: string;
  claim_id: string;
  deviation_from_median_pct?: number;
}

export interface PeCardSource {
  claim_id: string;
  doc_id: string;
  issuer_key: string;
  issuer_name: string;
  issuer_kind: string;
  stance: string;
  claim_text: string;
  reason: string;
  value_display: string;
  scope_note: string;
  as_of_date: string;
  confidence: number;
  quality_status: string;
  evidence_ids: string[];
  quotes: { evidence_id: string; quote: string }[];
}

export interface PeConsensusCard {
  card_id: string;
  item_key: string;
  question: string;
  period_canonical: string | null;
  measure: string | null;
  card_type: PeCardType;
  title: string | null;
  issuer_count: number;
  coverage_total: number;
  priority: number;
  stats: Record<string, unknown> | null;
  bull: PeCardSide[];
  bear: PeCardSide[];
  stance_counts: Record<string, number> | null;
  recent_changes: Record<string, unknown> | null;
  company_view: PeCardSide | null;
  narrative: Record<string, string> | null;
  sources: PeCardSource[];
  narrative_method: string | null;
  as_of_date: string;
  builder_version: string;
  built_at: string;
}

export interface PeConsensusCardsResult {
  datasetId: string;
  companyName: string;
  asOfDate: string | null;
  builtAt: string | null;
  checklistItems: number;
  issuers: { issuer_key: string; issuer_name: string; issuer_kind: string; doc_count: number }[];
  cards: PeConsensusCard[];
}

export interface PeConsensusQuery {
  cardTypes?: PeCardType[];
  itemKey?: string;
  limit?: number;
}

type SqlRow = Record<string, unknown>;

const CARD_TYPES: ReadonlySet<string> = new Set(["consensus", "divergence", "single_view"]);

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function text(row: SqlRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function number(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function cardFromRow(row: SqlRow): PeConsensusCard {
  const cardType = text(row, "card_type");
  return {
    card_id: text(row, "card_id"),
    item_key: text(row, "item_key"),
    question: text(row, "question"),
    period_canonical: text(row, "period_canonical") || null,
    measure: text(row, "measure") || null,
    card_type: (CARD_TYPES.has(cardType) ? cardType : "single_view") as PeCardType,
    title: text(row, "title") || null,
    issuer_count: number(row, "issuer_count"),
    coverage_total: number(row, "coverage_total"),
    priority: number(row, "priority"),
    stats: parseJson<Record<string, unknown> | null>(row.stats_json, null),
    bull: parseJson<PeCardSide[]>(row.bull_json, []),
    bear: parseJson<PeCardSide[]>(row.bear_json, []),
    stance_counts: parseJson<Record<string, number> | null>(row.stance_counts_json, null),
    recent_changes: parseJson<Record<string, unknown> | null>(row.recent_changes_json, null),
    company_view: parseJson<PeCardSide | null>(row.company_view_json, null),
    narrative: parseJson<Record<string, string> | null>(row.narrative_json, null),
    sources: parseJson<PeCardSource[]>(row.sources_json, []),
    narrative_method: text(row, "narrative_method") || null,
    as_of_date: text(row, "as_of_date"),
    builder_version: text(row, "builder_version"),
    built_at: text(row, "built_at"),
  };
}

function tableExists(database: DatabaseSync, name: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as SqlRow | undefined;
  return row !== undefined;
}

export function parseCardTypes(raw: string | null): PeCardType[] | undefined {
  if (!raw) return undefined;
  const types = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is PeCardType => CARD_TYPES.has(value));
  return types.length > 0 ? types : undefined;
}

export function loadPeConsensusCards(datasetId: string, query: PeConsensusQuery = {}): PeConsensusCardsResult {
  const project = getPeProject(datasetId);
  const database = new DatabaseSync(join(project.root, "meta", "collection.sqlite3"), {
    readOnly: true,
    timeout: 10_000,
  });
  try {
    database.exec("PRAGMA busy_timeout=10000");
    const result: PeConsensusCardsResult = {
      datasetId: project.datasetId,
      companyName: project.companyName,
      asOfDate: null,
      builtAt: null,
      checklistItems: 0,
      issuers: [],
      cards: [],
    };
    if (!tableExists(database, "consensus_cards")) return result;

    const clauses = ["dataset_id = ?"];
    const params: (string | number)[] = [project.datasetId];
    if (query.cardTypes && query.cardTypes.length > 0) {
      clauses.push(`card_type IN (${query.cardTypes.map(() => "?").join(",")})`);
      params.push(...query.cardTypes);
    }
    if (query.itemKey) {
      clauses.push("item_key = ?");
      params.push(query.itemKey);
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = database
      .prepare(
        `SELECT * FROM consensus_cards WHERE ${clauses.join(" AND ")} ORDER BY priority DESC, item_key, period_canonical LIMIT ?`,
      )
      .all(...params, limit) as SqlRow[];
    result.cards = rows.map(cardFromRow);
    if (rows.length > 0) {
      result.asOfDate = text(rows[0], "as_of_date") || null;
      result.builtAt = text(rows[0], "built_at") || null;
    }

    if (tableExists(database, "analysis_checklist_items")) {
      const row = database
        .prepare("SELECT COUNT(*) AS n FROM analysis_checklist_items WHERE dataset_id = ? AND status = 'active'")
        .get(project.datasetId) as SqlRow | undefined;
      result.checklistItems = row ? number(row, "n") : 0;
    }
    if (tableExists(database, "issuers")) {
      const issuerRows = database
        .prepare(
          "SELECT issuer_key, issuer_name, issuer_kind, doc_count FROM issuers WHERE dataset_id = ? ORDER BY doc_count DESC, issuer_name",
        )
        .all(project.datasetId) as SqlRow[];
      result.issuers = issuerRows.map((row) => ({
        issuer_key: text(row, "issuer_key"),
        issuer_name: text(row, "issuer_name"),
        issuer_kind: text(row, "issuer_kind"),
        doc_count: number(row, "doc_count"),
      }));
    }
    return result;
  } finally {
    database.close();
  }
}
