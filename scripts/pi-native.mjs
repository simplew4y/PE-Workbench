import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// npm changes cwd to the package root. Preserve the caller's project directory.
const child = spawn(process.execPath, [
	join(root, "node_modules/tsx/dist/cli.mjs"),
	"--tsconfig", join(root, "tsconfig.json"),
	join(root, "packages/coding-agent/src/cli.ts"), ...process.argv.slice(2),
], { cwd: process.env.INIT_CWD ?? process.cwd(), stdio: "inherit", env: process.env });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
