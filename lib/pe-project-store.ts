import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { allowFileRoot } from "./file-access";
import { disallowFileRoot } from "./allowed-roots";
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

const PROJECT_METADATA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_metadata (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    dataset_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

function storePaths(options: PeProjectStoreOptions = {}): {
  registryPath: string;
  projectsRoot: string;
  storeRoot: string;
} {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
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
  database.exec("PRAGMA busy_timeout=10000");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA journal_mode=WAL");
  database.exec(REGISTRY_SCHEMA);
  database.prepare(
    "INSERT OR IGNORE INTO dataset_state (id, active_dataset_id, updated_at) VALUES (1, NULL, ?)",
  ).run(new Date().toISOString());
  return database;
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
    const projects = projectRows(database).map(projectFromRow);
    if (!state?.active_dataset_id && projects[0]) {
      database.prepare(`
        UPDATE dataset_state SET active_dataset_id = ?, updated_at = ? WHERE id = 1
      `).run(projects[0].datasetId, new Date().toISOString());
      state = { active_dataset_id: projects[0].datasetId };
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
  const name = input.name.trim();
  if (!name) throw new Error("Project name is required");
  if (name.length > 100) throw new Error("Project name must not exceed 100 characters");

  const paths = storePaths(options);
  mkdirSync(paths.projectsRoot, { recursive: true });
  const projectsRoot = realpathSync(paths.projectsRoot);
  const datasetId = `dataset_${randomBytes(10).toString("hex")}`;
  const projectRoot = join(projectsRoot, datasetId);
  if (!isInside(projectsRoot, projectRoot) || existsSync(projectRoot)) {
    throw new Error("Unable to allocate a safe project workspace");
  }

  const now = new Date().toISOString();
  let projectCreated = false;
  try {
    mkdirSync(join(projectRoot, "raw"), { recursive: true });
    mkdirSync(join(projectRoot, "meta"), { recursive: true });
    mkdirSync(join(projectRoot, "generated"), { recursive: true });
    projectCreated = true;

    const collection = new DatabaseSync(join(projectRoot, "meta", "collection.sqlite3"));
    try {
      collection.exec(PROJECT_METADATA_SCHEMA);
      collection.prepare(`
        INSERT INTO project_metadata (id, dataset_id, name, created_at, updated_at)
        VALUES (1, ?, ?, ?, ?)
      `).run(datasetId, name, now, now);
    } finally {
      collection.close();
    }

    const database = openRegistry(options);
    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare(`
        INSERT INTO datasets (
          dataset_id, name, status, source_dir, dataset_root, company_name,
          company_ticker, file_count, created_at, updated_at, metadata_json
        ) VALUES (?, ?, 'draft', ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        datasetId,
        name,
        join(projectRoot, "raw"),
        projectRoot,
        input.companyName?.trim() ?? "",
        input.companyTicker?.trim() ?? "",
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
      companyName: input.companyName?.trim() ?? "",
      companyTicker: input.companyTicker?.trim() ?? "",
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
  const projectsRoot = resolve(paths.projectsRoot);
  const expectedProjectRoot = join(projectsRoot, normalizedDatasetId);
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
  if (resolve(row.dataset_root) !== expectedProjectRoot || dirname(expectedProjectRoot) !== projectsRoot) {
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
