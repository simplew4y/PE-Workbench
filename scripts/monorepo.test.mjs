import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), "utf8");
const manifest = JSON.parse(read("package.json"));

test("Pi command selectors exclude Web but retain nested backends and examples", () => {
	const selectors = JSON.parse(execFileSync(process.execPath, [join(root, "scripts/pi-workspaces.mjs"), "--list"], { encoding: "utf8" }));
	assert.ok(selectors.includes("packages/session-backends"));
	assert.ok(selectors.includes("packages/coding-agent/examples/extensions/gondolin"));
	assert.ok(selectors.every((path) => path.startsWith("packages")));
	assert.ok(manifest.workspaces.includes("apps/web"));
});

test("Web consumes all five local Pi packages and uses one install lock", () => {
	const web = JSON.parse(read("apps/web/package.json"));
	for (const name of ["pe-boot", "pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"]) {
		assert.equal(web.dependencies[`@earendil-works/${name}`], "0.84.2");
	}
	assert.equal(existsSync(join(root, "apps/web/package-lock.json")), false);
	assert.match(web.scripts.dev, /--turbopack/);
	assert.match(web.scripts.build, /--webpack/);
	assert.ok(manifest.scripts.dev.endsWith(" --"), "root npm command must forward --port");
	assert.match(read("pi-test.ps1"), /packages\/pe-boot\/src\/cli.ts/);
});

test("both pinned histories are ancestors without rewriting original commits", () => {
	for (const sha of ["041d3bfeff4ad15448f81f139fb14b6bce8eaed4", "74b38c43594df341359e7fa9fc851bd2127c47ca"]) {
		execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: root });
	}
});

test("runtime resource resolution is hoisting-safe and independent of old checkouts", () => {
	assert.match(read("apps/web/next.config.ts"), /dirname\(dirname\(configDir\)\)/);
	assert.match(read("apps/web/scripts/build-pe-ingest-worker.mjs"), /createRequire\(import.meta.url\).resolve/);
	assert.match(read("scripts/pi-native.mjs"), /process.env.INIT_CWD \?\? process.cwd\(\)/);
	assert.ok(!read("apps/web/package.json").includes("../PE-Workbench-pi"));
});
