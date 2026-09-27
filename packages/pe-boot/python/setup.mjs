import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const localPython = join(directory, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const configuredPython = process.env.PE_EXCEL_PYTHON?.trim() || process.env.PE_DOCUMENT_PYTHON?.trim();
const systemPython = process.platform === "win32" ? "python" : "python3";
function run(command, args) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.argv.includes("--test")) {
	run(configuredPython || (existsSync(localPython) ? localPython : systemPython), ["-m", "unittest", "discover", "-s", directory, "-p", "test_*.py"]);
} else {
	if (!configuredPython && !existsSync(localPython)) run(systemPython, ["-m", "venv", join(directory, ".venv")]);
	run(configuredPython || localPython, ["-m", "pip", "install", "--disable-pip-version-check", "-r", join(directory, "requirements.txt")]);
	run(configuredPython || localPython, ["-c", "import openpyxl; assert openpyxl.__version__ == '3.1.5'; print('Excel parser ready: openpyxl ' + openpyxl.__version__)"]);
}
