import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  activatePeProject,
  createPeProject,
  deletePeProject,
  getPeProject,
  listPeProjects,
  peProjectStorePaths,
} = await jiti.import("./pe-project-store.ts");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pe-workbench-project-store-"));
  const options = {
    agentDir: join(root, "agent"),
    projectsRoot: join(root, "workspaces"),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, options };
}

test("creates a registered project with the fixed workspace structure", (t) => {
  const { options } = fixture(t);
  const project = createPeProject({
    name: "宁德时代研究",
    companyName: "宁德时代新能源科技股份有限公司",
    companyTicker: "300750",
  }, options);

  assert.equal(project.name, "宁德时代研究");
  assert.equal(project.companyTicker, "300750");
  assert.equal(project.root, join(realpathSync(options.projectsRoot), "宁德时代研究"));
  for (const directory of ["raw", "meta", "generated"]) {
    assert.equal(existsSync(join(project.root, directory)), true);
  }
  assert.equal(existsSync(join(project.root, "meta", "text")), true);
  assert.equal(existsSync(join(project.root, "meta", "documents")), true);
  assert.match(
    readFileSync(join(project.root, "meta", "project.md"), "utf8"),
    /# 宁德时代研究[\s\S]*公司：宁德时代新能源科技股份有限公司[\s\S]*meta\/text/u,
  );
  assert.equal(existsSync(join(project.root, "meta", "collection.sqlite3")), true);

  const collection = new DatabaseSync(join(project.root, "meta", "collection.sqlite3"), { readOnly: true });
  try {
    const metadata = collection.prepare(
      "SELECT dataset_id, name FROM project_metadata WHERE id = 1",
    ).get();
    assert.deepEqual(
      { dataset_id: metadata.dataset_id, name: metadata.name },
      { dataset_id: project.datasetId, name: "宁德时代研究" },
    );
    const tables = collection.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => row.name);
    for (const table of [
      "schema_metadata",
      "documents",
      "pdf_pages",
      "pdf_page_blocks",
      "ingest_jobs",
      "pdf_pages_fts",
    ]) {
      assert.equal(tables.includes(table), true, `missing ${table}`);
    }
    assert.equal(tables.includes("chunks"), false);
  } finally {
    collection.close();
  }

  const catalog = listPeProjects(options);
  assert.equal(catalog.activeDatasetId, project.datasetId);
  assert.deepEqual(catalog.projects.map((item) => item.datasetId), [project.datasetId]);
  assert.deepEqual(getPeProject(project.datasetId, options), catalog.projects[0]);
  const registryPath = peProjectStorePaths(options).registryPath;
  assert.equal(existsSync(registryPath), true);
  const registry = new DatabaseSync(registryPath, { readOnly: true });
  try {
    const columns = registry.prepare("PRAGMA table_info(datasets)").all().map((row) => row.name);
    assert.deepEqual(columns, [
      "dataset_id",
      "name",
      "name_key",
      "status",
      "source_dir",
      "dataset_root",
      "company_name",
      "company_ticker",
      "file_count",
      "created_at",
      "updated_at",
      "metadata_json",
    ]);
    const state = registry.prepare(
      "SELECT id, active_dataset_id FROM dataset_state WHERE id = 1",
    ).get();
    assert.deepEqual(
      { id: state.id, active_dataset_id: state.active_dataset_id },
      { id: 1, active_dataset_id: project.datasetId },
    );
  } finally {
    registry.close();
  }
});

test("persists the active project independently from session history", (t) => {
  const { options } = fixture(t);
  const first = createPeProject({ name: "项目一" }, options);
  const second = createPeProject({ name: "项目二" }, options);

  assert.equal(listPeProjects(options).activeDatasetId, second.datasetId);
  activatePeProject(first.datasetId, options);
  assert.equal(listPeProjects(options).activeDatasetId, first.datasetId);
});

test("requires unique portable project names", (t) => {
  const { options } = fixture(t);
  createPeProject({ name: "Project Alpha" }, options);
  assert.throws(
    () => createPeProject({ name: "project alpha" }, options),
    /already exists/u,
  );
  assert.throws(
    () => createPeProject({ name: "../escape" }, options),
    /cannot be used/u,
  );
  assert.throws(
    () => createPeProject({ name: "CON" }, options),
    /cannot be used/u,
  );
});

test("deletes the registered project and selects a remaining project", (t) => {
  const { options } = fixture(t);
  const remaining = createPeProject({ name: "保留项目" }, options);
  const deleted = createPeProject({ name: "待删除项目" }, options);
  writeFileSync(join(deleted.root, "raw", "document.pdf"), "test");

  const catalog = deletePeProject(deleted.datasetId, options);

  assert.equal(existsSync(deleted.root), false);
  assert.equal(existsSync(remaining.root), true);
  assert.equal(catalog.activeDatasetId, remaining.datasetId);
  assert.deepEqual(catalog.projects.map((project) => project.datasetId), [remaining.datasetId]);
  assert.throws(() => getPeProject(deleted.datasetId, options), /Project not found/);
});

test("refuses to delete a registered project path outside the projects directory", (t) => {
  const { root, options } = fixture(t);
  const project = createPeProject({ name: "路径保护" }, options);
  const outside = join(root, "must-not-delete");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep");
  const registry = new DatabaseSync(peProjectStorePaths(options).registryPath);
  try {
    registry.prepare("UPDATE datasets SET dataset_root = ? WHERE dataset_id = ?")
      .run(outside, project.datasetId);
  } finally {
    registry.close();
  }

  assert.throws(
    () => deletePeProject(project.datasetId, options),
    /outside the PE projects directory/,
  );
  assert.equal(existsSync(join(outside, "keep.txt")), true);
  assert.equal(existsSync(project.root), true);
});

test("uses the fixed pe-workbench projects directory by default", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pe-workbench-project-parent-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { agentDir: join(root, "agent") };

  const created = createPeProject({ name: "新项目" }, options);

  assert.equal(dirname(created.root), join(root, "agent", "pe-workbench", "projects"));
  assert.equal(created.root, join(root, "agent", "pe-workbench", "projects", "新项目"));
  assert.equal(existsSync(peProjectStorePaths(options).registryPath), true);
});

test("keeps projects usable after relocating the store behind its existing path", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pe-relocated-store-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { agentDir: join(root, "agent") };
  const first = createPeProject({ name: "Before migration" }, options);
  writeFileSync(join(first.root, "raw", "original.txt"), "preserved");
  const store = dirname(peProjectStorePaths(options).registryPath);
  const relocated = join(root, "data-disk");
  renameSync(store, relocated);
  symlinkSync(relocated, store, process.platform === "win32" ? "junction" : "dir");

  assert.equal(activatePeProject(first.datasetId, options).datasetId, first.datasetId);
  assert.equal(readFileSync(join(getPeProject(first.datasetId, options).root, "raw", "original.txt"), "utf8"), "preserved");
  const second = createPeProject({ name: "After migration" }, options);
  assert.equal(dirname(second.root), join(relocated, "projects"));
  assert.equal(deletePeProject(first.datasetId, options).activeDatasetId, second.datasetId);
  assert.equal(existsSync(first.root), false);
  assert.equal(existsSync(second.root), true);
});

test("preserves registry failures when SQLite has already rolled back", (t) => {
  const { options } = fixture(t);
  const project = createPeProject({ name: "Storage failure" }, options);
  const database = new DatabaseSync(peProjectStorePaths(options).registryPath);
  try {
    database.exec(`CREATE TRIGGER reject_registry BEFORE INSERT ON dataset_state
      BEGIN SELECT RAISE(ROLLBACK, 'registry storage rejected'); END`);
    assert.throws(() => listPeProjects(options), /registry storage rejected/u);
    database.exec("DROP TRIGGER reject_registry; BEGIN IMMEDIATE; ROLLBACK");
    assert.equal(listPeProjects(options).activeDatasetId, project.datasetId);
  } finally {
    database.close();
  }
});

test("deletes a project under the canonical configured root while refusing a redirected project", (t) => {
  const { root, options } = fixture(t);
  const actualRoot = join(root, "actual-workspaces");
  mkdirSync(actualRoot);
  symlinkSync(actualRoot, options.projectsRoot, process.platform === "win32" ? "junction" : "dir");
  const project = createPeProject({ name: "Canonical" }, options);
  deletePeProject(project.datasetId, options);
  assert.equal(existsSync(project.root), false);

  const redirected = createPeProject({ name: "Redirected" }, options);
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep");
  rmSync(redirected.root, { recursive: true });
  symlinkSync(outside, redirected.root, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => deletePeProject(redirected.datasetId, options), /Refusing to delete/u);
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
});
