import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { allowFileRoot } from "./file-access";
import { initializePeCollectionDatabase, rollbackPeTransaction } from "./pe-ingest/schema";
import { disallowFileRoot } from "./allowed-roots";
import { getPeAgentDir, isPeMultiUserMode, isPeUserPathAllowed } from "./pe-multi-user-paths";
import { projectIdentityKey } from "./project-identity";
import type {
  CreatePeProjectInput,
  PeProjectCatalog,
  PeProjectSummary,
} from "./pe-project-types";

interface PeProjectStoreOptions {
  agentDir?: string;
  projectsRoot?: string;
}

interface SqlRow {
  dataset_id: string;
  name: string;
  status: string;
  dataset_root: string;
  company_name: string | null;
  company_ticker: string | null;
  file_count: number;
  created_at: string;
  updated_at: string;
}

const REGISTRY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS datasets (
    dataset_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    source_dir TEXT,
    dataset_root TEXT NOT NULL UNIQUE,
    company_name TEXT,
    company_ticker TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT
  );

  CREATE TABLE IF NOT EXISTS dataset_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    active_dataset_id TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(active_dataset_id) REFERENCES datasets(dataset_id) ON DELETE SET NULL
  );
`;

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function normalizeProjectName(value: string): string {
  const name = value.normalize("NFKC").trim();
  if (!name) throw new Error("Project name is required");
  if (name.length > 100 || Buffer.byteLength(name, "utf8") > 200) {
    throw new Error("Project name is too long");
  }
  if (
    name === "."
    || name === ".."
    || name.startsWith(".")
    || /[<>:"/\\|?*\u0000-\u001F]/u.test(name)
    || /[. ]$/u.test(name)
    || WINDOWS_RESERVED_NAME.test(name)
  ) {
    throw new Error("Project name contains characters that cannot be used in a workspace directory");
  }
  return name;
}

function projectNameKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("und");
}

function renderProjectOverview(
  name: string,
  companyName: string,
  companyTicker: string,
): string {
  const identity = [
    companyName ? `- 公司：${companyName}` : "",
    companyTicker ? `- 股票代码：${companyTicker}` : "",
  ].filter(Boolean);
  return [
    `# ${name}`,
    "",
    ...identity,
    ...(identity.length > 0 ? [""] : []),
    "## 工作区目录",
    "",
    "- `raw/`：用户上传的原始资料。",
    "- `meta/text/`：从当前资料提取的、供研究与检索使用的 Markdown 文本。",
    "- `meta/documents/`：PDF 页面图片和布局数据。",
    "- `meta/excel/`：按 Excel 文档版本保存的解析结果与可读文本。",
    "- `generated/`：Memo、Research Note 等研究产物。",
    "",
  ].join("\n");
}

function storePaths(options: PeProjectStoreOptions = {}): {
  registryPath: string;
  projectsRoot: string;
  storeRoot: string;
} {
  const agentDir = resolve(options.agentDir ?? (
    isPeMultiUserMode() ? getPeAgentDir() : getAgentDir()
  ));
  const storeRoot = join(agentDir, "pe-workbench");
  return {
    registryPath: join(storeRoot, "datasets.sqlite3"),
    projectsRoot: resolve(options.projectsRoot ?? join(storeRoot, "projects")),
    storeRoot,
  };
}

function openRegistry(options: PeProjectStoreOptions = {}): DatabaseSync {
  const { registryPath } = storePaths(options);
  mkdirSync(dirname(registryPath), { recursive: true });
  const database = new DatabaseSync(registryPath, { timeout: 10_000 });
  try {
    database.exec("PRAGMA busy_timeout=10000");
    database.exec("PRAGMA foreign_keys=ON");
    database.exec("PRAGMA journal_mode=WAL");
    database.exec("BEGIN IMMEDIATE");
    database.exec(REGISTRY_SCHEMA);
    const columns = database.prepare("PRAGMA table_info(datasets)").all();
    if (!columns.some((column) => column.name === "name_key")) {
      database.exec("ALTER TABLE datasets ADD COLUMN name_key TEXT");
    }
    const missingKeys = database.prepare(
      "SELECT dataset_id, name FROM datasets WHERE name_key IS NULL",
    ).all() as { dataset_id: string; name: string }[];
    const setNameKey = database.prepare("UPDATE datasets SET name_key = ? WHERE dataset_id = ?");
    for (const row of missingKeys) {
      setNameKey.run(projectNameKey(row.name.trim()), row.dataset_id);
    }
    // Older registries allowed duplicate display names. Preserve those projects;
    // new registrations enforce uniqueness inside their write transaction.
    database.exec("CREATE INDEX IF NOT EXISTS datasets_name_key_idx ON datasets(name_key)");
    database.prepare(
      "INSERT OR IGNORE INTO dataset_state (id, active_dataset_id, updated_at) VALUES (1, NULL, ?)",
    ).run(new Date().toISOString());
    database.exec("COMMIT");
    return database;
  } catch (error) {
    try {
      rollbackPeTransaction(database);
    } finally {
      database.close();
    }
    throw error;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function projectFromRow(row: SqlRow): PeProjectSummary {
  return {
    datasetId: row.dataset_id,
    name: row.name,
    status: row.status,
    root: row.dataset_root,
    projectKey: projectIdentityKey(row.dataset_root),
    companyName: row.company_name ?? "",
    companyTicker: row.company_ticker ?? "",
    fileCount: Number(row.file_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectRows(database: DatabaseSync): SqlRow[] {
  return database.prepare(`
    SELECT dataset_id, name, status, dataset_root, company_name, company_ticker,
           file_count, created_at, updated_at
    FROM datasets
    ORDER BY updated_at DESC, name ASC
  `).all() as unknown as SqlRow[];
}

function validExistingProjectRoot(candidate: string): string | null {
  try {
    const root = realpathSync(candidate);
    if (!statSync(root).isDirectory()) return null;
    for (const directory of ["raw", "meta", "generated"]) {
      if (!statSync(join(root, directory)).isDirectory()) return null;
    }
    if (!statSync(join(root, "meta", "collection.sqlite3")).isFile()) return null;
    return root;
  } catch {
    return null;
  }
}

export function listPeProjects(
  options: PeProjectStoreOptions = {},
): PeProjectCatalog {
  const database = openRegistry(options);
  try {
    let state = database.prepare(
      "SELECT active_dataset_id FROM dataset_state WHERE id = 1",
    ).get() as { active_dataset_id: string | null } | undefined;
    const registeredProjects = projectRows(database).map(projectFromRow);
    const projects = registeredProjects.filter((project) => isPeUserPathAllowed(project.root));
    if (projects.length !== registeredProjects.length) {
      console.warn("Ignored PE projects outside the current user workspace");
    }
    const activeProjectExists = projects.some((project) => project.datasetId === state?.active_dataset_id);
    if (!activeProjectExists) {
      database.prepare(`
        UPDATE dataset_state SET active_dataset_id = ?, updated_at = ? WHERE id = 1
      `).run(projects[0]?.datasetId ?? null, new Date().toISOString());
      state = { active_dataset_id: projects[0]?.datasetId ?? null };
    }
    for (const project of projects) allowFileRoot(project.root);
    return {
      projects,
      activeDatasetId: state?.active_dataset_id ?? null,
    };
  } finally {
    database.close();
  }
}

export function activatePeProject(
  datasetId: string,
  options: PeProjectStoreOptions = {},
): PeProjectSummary {
  const database = openRegistry(options);
  try {
    const row = database.prepare(`
      SELECT dataset_id, name, status, dataset_root, company_name, company_ticker,
             file_count, created_at, updated_at
      FROM datasets WHERE dataset_id = ?
    `).get(datasetId) as unknown as SqlRow | undefined;
    if (!row) throw new Error(`Project not found: ${datasetId}`);
    if (!validExistingProjectRoot(row.dataset_root)) {
      throw new Error(`Project workspace is unavailable: ${row.name}`);
    }
    database.prepare(`
      UPDATE dataset_state SET active_dataset_id = ?, updated_at = ? WHERE id = 1
    `).run(datasetId, new Date().toISOString());
    allowFileRoot(row.dataset_root);
    return projectFromRow(row);
  } finally {
    database.close();
  }
}

export function getPeProject(
  datasetId: string,
  options: PeProjectStoreOptions = {},
): PeProjectSummary {
  const normalizedDatasetId = datasetId.trim();
  if (!normalizedDatasetId) throw new Error("datasetId is required");
  const database = openRegistry(options);
  try {
    const row = database.prepare(`
      SELECT dataset_id, name, status, dataset_root, company_name, company_ticker,
             file_count, created_at, updated_at
      FROM datasets WHERE dataset_id = ?
    `).get(normalizedDatasetId) as unknown as SqlRow | undefined;
    if (!row) throw new Error(`Project not found: ${normalizedDatasetId}`);
    if (!validExistingProjectRoot(row.dataset_root)) {
      throw new Error(`Project workspace is unavailable: ${row.name}`);
    }
    allowFileRoot(row.dataset_root);
    return projectFromRow(row);
  } finally {
    database.close();
  }
}

export function createPeProject(
  input: CreatePeProjectInput,
  options: PeProjectStoreOptions = {},
): PeProjectSummary {
  const name = normalizeProjectName(input.name);
  const nameKey = projectNameKey(name);
  const companyName = input.companyName?.trim() ?? "";
  const companyTicker = input.companyTicker?.trim() ?? "";

  const paths = storePaths(options);
  mkdirSync(paths.projectsRoot, { recursive: true });
  const projectsRoot = realpathSync(paths.projectsRoot);
  const datasetId = `dataset_${randomBytes(10).toString("hex")}`;
  const projectRoot = join(projectsRoot, name);
  const directoryNameExists = readdirSync(projectsRoot).some(
    (entry) => projectNameKey(entry) === nameKey,
  );
  if (!isInside(projectsRoot, projectRoot) || directoryNameExists || existsSync(projectRoot)) {
    throw new Error(`Project name already exists: ${name}`);
  }

  const existingRegistry = openRegistry(options);
  try {
    const existing = existingRegistry.prepare(
      "SELECT dataset_id FROM datasets WHERE name_key = ?",
    ).get(nameKey);
    if (existing) throw new Error(`Project name already exists: ${name}`);
  } finally {
    existingRegistry.close();
  }

  const now = new Date().toISOString();
  let projectCreated = false;
  try {
    mkdirSync(projectRoot);
    projectCreated = true;
    mkdirSync(join(projectRoot, "raw"));
    mkdirSync(join(projectRoot, "meta"));
    mkdirSync(join(projectRoot, "meta", "text"));
    mkdirSync(join(projectRoot, "meta", "documents"));
    mkdirSync(join(projectRoot, "generated"));
    writeFileSync(
      join(projectRoot, "meta", "project.md"),
      renderProjectOverview(name, companyName, companyTicker),
      "utf8",
    );

    initializePeCollectionDatabase(join(projectRoot, "meta", "collection.sqlite3"), {
      datasetId,
      name,
      now,
    });

    const database = openRegistry(options);
    try {
      database.exec("BEGIN IMMEDIATE");
      if (database.prepare("SELECT dataset_id FROM datasets WHERE name_key = ?").get(nameKey)) {
        throw new Error(`Project name already exists: ${name}`);
      }
      database.prepare(`
        INSERT INTO datasets (
          dataset_id, name, name_key, status, source_dir, dataset_root, company_name,
          company_ticker, file_count, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        datasetId,
        name,
        nameKey,
        join(projectRoot, "raw"),
        projectRoot,
        companyName,
        companyTicker,
        now,
        now,
        JSON.stringify({ source: "pe_workbench_web" }),
      );
      database.prepare(`
        UPDATE dataset_state SET active_dataset_id = ?, updated_at = ? WHERE id = 1
      `).run(datasetId, now);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The transaction may not have started.
      }
      throw error;
    } finally {
      database.close();
    }

    allowFileRoot(projectRoot);
    return {
      datasetId,
      name,
      status: "draft",
      root: projectRoot,
      projectKey: projectIdentityKey(projectRoot),
      companyName,
      companyTicker,
      fileCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  } catch (error) {
    if (projectCreated && isInside(projectsRoot, projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

export function deletePeProject(
  datasetId: string,
  options: PeProjectStoreOptions = {},
): PeProjectCatalog {
  const normalizedDatasetId = datasetId.trim();
  if (!/^dataset_[A-Za-z0-9_-]+$/.test(normalizedDatasetId)) {
    throw new Error("Invalid datasetId");
  }

  const paths = storePaths(options);
  const projectsRoot = existsSync(paths.projectsRoot) ? realpathSync(paths.projectsRoot) : resolve(paths.projectsRoot);
  const database = openRegistry(options);
  let row: SqlRow | undefined;
  try {
    row = database.prepare(`
      SELECT dataset_id, name, status, dataset_root, company_name, company_ticker,
             file_count, created_at, updated_at
      FROM datasets WHERE dataset_id = ?
    `).get(normalizedDatasetId) as unknown as SqlRow | undefined;
  } finally {
    database.close();
  }
  if (!row) throw new Error(`Project not found: ${normalizedDatasetId}`);
  // A relocated store can retain its old path through a parent symlink.
  // Resolve only the parent so a redirected individual project is still rejected below.
  const registeredParent = dirname(resolve(row.dataset_root));
  const registeredRoot = join(
    existsSync(registeredParent) ? realpathSync(registeredParent) : registeredParent,
    basename(row.dataset_root),
  );
  const legacyProjectRoot = join(projectsRoot, normalizedDatasetId);
  const expectedProjectRoot = registeredRoot === legacyProjectRoot
    ? legacyProjectRoot
    : join(projectsRoot, normalizeProjectName(row.name));
  if (registeredRoot !== expectedProjectRoot || dirname(expectedProjectRoot) !== projectsRoot) {
    throw new Error("Registered project root is outside the PE projects directory");
  }

  for (const candidate of [expectedProjectRoot]) {
    if (existsSync(candidate) && realpathSync(candidate) !== resolve(candidate)) {
      throw new Error("Refusing to delete a project path that resolves outside its registered directory");
    }
  }

  mkdirSync(paths.storeRoot, { recursive: true });
  const stagingRoot = join(
    paths.storeRoot,
    `.deleting-${normalizedDatasetId}-${randomBytes(6).toString("hex")}`,
  );
  const stagedProjectRoot = join(stagingRoot, "project");
  let projectStaged = false;
  let committed = false;
  try {
    mkdirSync(stagingRoot);
    if (existsSync(expectedProjectRoot)) {
      renameSync(expectedProjectRoot, stagedProjectRoot);
      projectStaged = true;
    }
    const registry = openRegistry(options);
    try {
      registry.exec("BEGIN IMMEDIATE");
      const state = registry.prepare(
        "SELECT active_dataset_id FROM dataset_state WHERE id = 1",
      ).get() as { active_dataset_id: string | null } | undefined;
      const deleted = registry.prepare("DELETE FROM datasets WHERE dataset_id = ?")
        .run(normalizedDatasetId);
      if (Number(deleted.changes) !== 1) {
        throw new Error(`Project not found: ${normalizedDatasetId}`);
      }
      if (state?.active_dataset_id === normalizedDatasetId) {
        const next = registry.prepare(`
          SELECT dataset_id FROM datasets ORDER BY updated_at DESC, name ASC LIMIT 1
        `).get() as { dataset_id: string } | undefined;
        registry.prepare(`
          UPDATE dataset_state SET active_dataset_id = ?, updated_at = ? WHERE id = 1
        `).run(next?.dataset_id ?? null, new Date().toISOString());
      }
      registry.exec("COMMIT");
      committed = true;
    } catch (error) {
      try {
        registry.exec("ROLLBACK");
      } catch {
        // The transaction may not have started.
      }
      throw error;
    } finally {
      registry.close();
    }

    rmSync(stagingRoot, { recursive: true, force: true });
    disallowFileRoot(expectedProjectRoot);
    return listPeProjects(options);
  } catch (error) {
    if (!committed) {
      if (projectStaged && existsSync(stagedProjectRoot) && !existsSync(expectedProjectRoot)) {
        renameSync(stagedProjectRoot, expectedProjectRoot);
      }
      rmSync(stagingRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

export function peProjectStorePaths(options: PeProjectStoreOptions = {}): {
  registryPath: string;
  projectsRoot: string;
} {
  return storePaths(options);
}
