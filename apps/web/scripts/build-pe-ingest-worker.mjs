import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDirectory = path.join(projectRoot, "dist", "pe-ingest");
const typescriptCli = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");

rmSync(outputDirectory, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [typescriptCli, "--project", path.join(projectRoot, "tsconfig.pe-ingest.json")],
  { cwd: projectRoot, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  path.join(outputDirectory, "package.json"),
  `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`,
  "utf8",
);
