import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { excelPython } from "@earendil-works/pe-boot";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);
const jiti = createJiti(import.meta.url);
const { prepareSessionDocuments } = await jiti.import("./session-document-processor.ts");
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("chat PDF and Excel attachments share the PE environment without a service-local venv", async (t) => {
  const previousCwd = process.cwd();
  const overrides = { PE_EXCEL_PYTHON: process.env.PE_EXCEL_PYTHON, PE_DOCUMENT_PYTHON: process.env.PE_DOCUMENT_PYTHON };
  delete process.env.PE_EXCEL_PYTHON;
  delete process.env.PE_DOCUMENT_PYTHON;
  const python = excelPython();
  const directory = await mkdtemp(join(tmpdir(), "pe-shared-python-"));
  t.after(async () => {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const service = join(directory, "services/session-attachments");
  await mkdir(service, { recursive: true });
  for (const name of ["extract_session_attachment.py", "format_adapters.py"]) {
    await copyFile(join(webRoot, "services/session-attachments", name), join(service, name));
  }
  assert.equal(existsSync(join(service, ".venv")), false);
  await execFileAsync(python, ["-c", [
    "import sys, pathlib, pymupdf",
    "from openpyxl import Workbook",
    "root = pathlib.Path(sys.argv[1])",
    "pdf = pymupdf.open()",
    "pdf.new_page().insert_text((72, 72), 'Shared PDF attachment 75')",
    "pdf.save(root / 'report.pdf')",
    "pdf.close()",
    "book = Workbook()",
    "book.active.title = 'Model'",
    "book.active.append(['Target price', 75, '=B1*2'])",
    "book.save(root / 'model.xlsx')",
    "book.close()",
  ].join("\n"), directory]);
  const documents = await Promise.all(["report.pdf", "model.xlsx"].map(async (name) => {
    const bytes = await readFile(join(directory, name));
    return { name, data: bytes.toString("base64"), size: bytes.length,
      mimeType: name.endsWith("pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  }));
  process.chdir(directory);
  await t.test("default environment extracts both formats and preserves formula evidence", async () => {
    const context = await prepareSessionDocuments(join(directory, "project"), "default", documents);
    assert.match(context, /Shared PDF attachment 75/);
    assert.match(context, /Sheet: Model/);
    assert.match(context, /Target price\t75\t=B1\*2/);
  });
  await t.test("document override uses the same interpreter", async () => {
    process.env.PE_DOCUMENT_PYTHON = python;
    const context = await prepareSessionDocuments(join(directory, "project"), "document-override", documents);
    assert.match(context, /Shared PDF attachment 75/);
  });
  await t.test("Excel override has the same priority as setup", async () => {
    process.env.PE_DOCUMENT_PYTHON = join(directory, "missing-python");
    process.env.PE_EXCEL_PYTHON = python;
    const context = await prepareSessionDocuments(join(directory, "project"), "excel-override", documents);
    assert.match(context, /Target price\t75\t=B1\*2/);
  });
  await t.test("missing configured interpreter fails rather than silently using another environment", async () => {
    process.env.PE_EXCEL_PYTHON = join(directory, "missing-python");
    await assert.rejects(prepareSessionDocuments(join(directory, "project"), "missing", documents), /ENOENT/);
  });
});
