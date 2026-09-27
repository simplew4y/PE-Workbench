import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageDirectories } from "./package-workspaces.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packages = findPackageDirectories(join(root, "packages"))
	.filter((directory) => !directory.includes("/install-lock") && !directory.includes("\\install-lock"));
const expected = new Map(packages.map((directory) => [
	JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name, directory,
]));
const owners = [join(root, "apps/web"), ...packages];
let checked = 0;
for (const owner of owners) {
	const manifest = JSON.parse(readFileSync(join(owner, "package.json"), "utf8"));
	const require = createRequire(join(owner, "package.json"));
	for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
		if (!expected.has(name)) continue;
		// Some Pi packages are import-only; require.resolve(name) rejects their exports.
		const packageRoot = require.resolve.paths(name)?.map((base) => join(base, name))
			.find((path) => existsSync(join(path, "package.json")));
		assert.ok(packageRoot, `Missing workspace dependency: ${name}`);
		const resolved = realpathSync(packageRoot);
		const path = relative(realpathSync(expected.get(name)), resolved);
		assert.ok(!path.startsWith("..") && !isAbsolute(path), `${manifest.name}: ${name} resolves outside workspace: ${resolved}`);
		checked++;
	}
}
console.log(`Verified ${checked} internal dependency resolutions.`);
