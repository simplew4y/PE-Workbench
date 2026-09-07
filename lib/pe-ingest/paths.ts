import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

interface PeProjectReference {
  datasetId: string;
  root: string;
}

export interface PeProjectPaths {
  projectPath: string;
  workspaceRoot: string;
  registryPath: string;
  datasetId: string;
  rawPath: string;
  metaPath: string;
  collectionPath: string;
  textPath: string;
  documentsPath: string;
  stagingPath: string;
  jobDirectory: string;
}

export interface PeRawFile {
  absolutePath: string;
  rawPath: string;
  sha256: string;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function isPathInside(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function assertSafeSegment(segment: string): void {
  if (!segment || segment === "." || segment === ".." || path.basename(segment) !== segment) {
    throw new Error(`Unsafe workspace path segment: ${segment || "(empty)"}`);
  }
}

export function normalizePePdfFilename(value: string): string {
  const filename = value.normalize("NFKC").trim();
  const parsed = path.parse(filename);
  if (
    !filename
    || filename === "."
    || filename === ".."
    || path.basename(filename) !== filename
    || /[<>:"/\\|?*\u0000-\u001F]/u.test(filename)
    || /[. ]$/u.test(filename)
    || !parsed.name
    || WINDOWS_RESERVED_NAME.test(filename)
  ) {
    throw new Error(`Invalid portable PDF filename: ${value || "(empty)"}`);
  }
  if (path.extname(filename).toLocaleLowerCase() !== ".pdf") {
    throw new Error(`Unsupported research file: ${filename}`);
  }
  return filename;
}

export function pePdfFilenameKey(filename: string): string {
  return normalizePePdfFilename(filename).toLocaleLowerCase("und");
}

export function pePdfDocumentName(filename: string): string {
  return path.parse(normalizePePdfFilename(filename)).name;
}

export function registeredPePdfArtifactPaths(docId: string, generation: string): {
  artifactDirectory: string;
  documentMarkdownPath: string;
  layoutJsonPath: string;
} {
  if (!/^[A-Za-z0-9_-]+$/u.test(docId) || !/^[a-f0-9]{16}$/u.test(generation)) {
    throw new Error("Invalid registered PDF artifact identity");
  }
  const artifactDirectory = `meta/pdf-catalog/${docId}/${generation}`;
  return {
    artifactDirectory,
    documentMarkdownPath: `${artifactDirectory}/document.md`,
    layoutJsonPath: `${artifactDirectory}/layout.json`,
  };
}

export function hasPeRawFilename(paths: PeProjectPaths, filename: string): boolean {
  const filenameKey = pePdfFilenameKey(filename);
  return readdirSync(paths.rawPath).some((entry) => {
    try {
      return pePdfFilenameKey(entry) === filenameKey;
    } catch {
      return false;
    }
  });
}

export function ensureDirectoryWithin(root: string, ...segments: string[]): string {
  const realRoot = realpathSync(root);
  let current = realRoot;
  for (const segment of segments) {
    assertSafeSegment(segment);
    const candidate = path.join(current, segment);
    if (!existsSync(candidate)) mkdirSync(candidate);
    const resolved = realpathSync(candidate);
    if (!isPathInside(realRoot, resolved)) {
      throw new Error(`Workspace path escapes the project root: ${candidate}`);
    }
    if (!statSync(resolved).isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${candidate}`);
    }
    current = resolved;
  }
  return current;
}

function requireDirectoryWithin(root: string, name: string): string {
  assertSafeSegment(name);
  const candidate = path.join(root, name);
  const resolved = realpathSync(candidate);
  if (!isPathInside(root, resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`PE project ${name} path is invalid`);
  }
  return resolved;
}

export function resolvePeProjectPaths(
  project: PeProjectReference,
  registryPath: string,
): PeProjectPaths {
  const projectPath = realpathSync(project.root);
  if (!statSync(projectPath).isDirectory()) throw new Error("PE project path is not a directory");

  const workspaceRoot = realpathSync(path.dirname(projectPath));
  if (!isPathInside(workspaceRoot, projectPath)) {
    throw new Error("Registered project path is outside the PE projects directory");
  }
  const peWorkbenchRoot = realpathSync(path.dirname(workspaceRoot));
  const resolvedRegistry = realpathSync(registryPath);
  if (resolvedRegistry !== path.join(peWorkbenchRoot, "datasets.sqlite3")) {
    throw new Error("PE project registry does not match the registered project root");
  }
  const registry = new DatabaseSync(resolvedRegistry, { readOnly: true });
  try {
    const row = registry.prepare(
      "SELECT dataset_root FROM datasets WHERE dataset_id = ?",
    ).get(project.datasetId) as { dataset_root: string } | undefined;
    if (!row || realpathSync(row.dataset_root) !== projectPath) {
      throw new Error("Registered dataset does not match its project directory");
    }
  } finally {
    registry.close();
  }

  const rawPath = requireDirectoryWithin(projectPath, "raw");
  const metaPath = requireDirectoryWithin(projectPath, "meta");
  requireDirectoryWithin(projectPath, "generated");
  const collectionPath = realpathSync(path.join(metaPath, "collection.sqlite3"));
  if (!isPathInside(projectPath, collectionPath) || !statSync(collectionPath).isFile()) {
    throw new Error("PE project collection database is invalid");
  }
  // Main's earlier empty projects created only raw/meta/generated. Add the
  // derived-output directories without changing their registered workspace.
  const textPath = ensureDirectoryWithin(metaPath, "text");
  const documentsPath = ensureDirectoryWithin(metaPath, "documents");

  return {
    projectPath,
    workspaceRoot,
    registryPath: resolvedRegistry,
    datasetId: project.datasetId,
    rawPath,
    metaPath,
    collectionPath,
    textPath,
    documentsPath,
    stagingPath: path.join(metaPath, ".ingest-staging"),
    jobDirectory: path.join(metaPath, "ingest-ui-jobs"),
  };
}

export function resolvePeProjectPathsFromJobFile(jobFile: string, datasetId: string): PeProjectPaths {
  const resolvedJobFile = realpathSync(jobFile);
  if (!statSync(resolvedJobFile).isFile()) throw new Error("Ingest job file is not a file");
  const jobDirectory = realpathSync(path.dirname(resolvedJobFile));
  if (path.basename(jobDirectory) !== "ingest-ui-jobs") throw new Error("Invalid ingest job directory");
  const metaPath = realpathSync(path.dirname(jobDirectory));
  if (path.basename(metaPath) !== "meta") throw new Error("Invalid ingest metadata directory");
  const projectPath = realpathSync(path.dirname(metaPath));
  const registryPath = path.join(path.dirname(path.dirname(projectPath)), "datasets.sqlite3");
  return resolvePeProjectPaths({ datasetId, root: projectPath }, registryPath);
}

export function stablePeId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

export function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function toProjectRelativePath(paths: PeProjectPaths, absolutePath: string): string {
  const relativePath = path.relative(paths.projectPath, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Path is outside the PE project workspace");
  }
  return relativePath.split(path.sep).join("/");
}

export function resolveProjectFile(paths: PeProjectPaths, relativePath: string): string {
  const segments = relativePath.split("/");
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid project-relative file path");
  }
  const candidate = path.resolve(paths.projectPath, ...segments);
  const resolved = realpathSync(candidate);
  if (!isPathInside(paths.projectPath, resolved) || !statSync(resolved).isFile()) {
    throw new Error("Project file escapes the PE workspace");
  }
  return resolved;
}

export function writePeRawFile(paths: PeProjectPaths, filename: string, content: Buffer): PeRawFile {
  const rawPath = ensureDirectoryWithin(paths.projectPath, "raw");
  const digest = sha256(content);
  const normalizedFilename = normalizePePdfFilename(filename);
  const candidate = path.join(rawPath, normalizedFilename);
  if (!isPathInside(rawPath, path.resolve(candidate))) {
    throw new Error("Raw file path escapes the PE workspace");
  }
  if (hasPeRawFilename(paths, normalizedFilename)) {
    throw new Error(`PDF filename already exists in this project: ${normalizedFilename}`);
  }
  const temporary = path.join(rawPath, `.${normalizedFilename}.${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { flag: "wx" });
  try {
    linkSync(temporary, candidate);
  } finally {
    rmSync(temporary, { force: true });
  }
  return {
    absolutePath: candidate,
    rawPath: toProjectRelativePath(paths, candidate),
    sha256: digest,
  };
}
