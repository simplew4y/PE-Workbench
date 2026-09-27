import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { excelPython } from "@earendil-works/pe-boot";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw new Error("Node >=22.19.0 is required");
const directory = mkdtempSync(join(tmpdir(), "pe-research-doctor-"));
try {
  const database = new DatabaseSync(join(directory, "check.sqlite3"));
  try {
    database.exec("PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE pages USING fts5(text); INSERT INTO pages VALUES('research');");
    if (database.prepare("SELECT count(*) AS n FROM pages WHERE pages MATCH 'research'").get().n !== 1) throw new Error("SQLite FTS5 failed");
  } finally { database.close(); }
  const parser = spawnSync(excelPython(), ["-c", "import openpyxl; assert openpyxl.__version__ == '3.1.5'; print(openpyxl.__version__)"], { encoding: "utf8", timeout: 10_000 });
  if (parser.error || parser.status !== 0) throw new Error("Excel parser unavailable; run the existing pe-boot Python setup");
  console.log(JSON.stringify({
    node: process.versions.node,
    sqlite: "WAL + FTS5 verified in temporary database",
    excel: `openpyxl ${parser.stdout.trim()}`,
    researchModelConfigured: Boolean(process.env.PE_RESEARCH_PROVIDER && process.env.PE_RESEARCH_MODEL),
    backgroundTools: "Prepared PDF/Excel/Wind snapshots; saved Memo context; no shell or lazy parsing",
    externalMonitoring: "Available through project Continuous Tracking; enable state and heartbeat are shown per project",
    parserIsolation: "Not verified; research worker does not invoke parsers",
  }, null, 2));
} finally { rmSync(directory, { recursive: true, force: true }); }
