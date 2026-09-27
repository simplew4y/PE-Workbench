import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// Select the original Pi workspace set, including nested backends and examples.
const selectors = manifest.workspaces.filter((pattern) => pattern.startsWith("packages/"))
	.map((pattern) => pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern);
if (process.argv[2] === "--list") {
	console.log(JSON.stringify(selectors));
	process.exit(0);
}
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const result = spawnSync(process.execPath, [
	npmCli, ...process.argv.slice(2), ...selectors.map((selector) => `--workspace=${selector}`),
], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
