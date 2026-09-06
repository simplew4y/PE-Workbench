import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve("services/pe-ingest");
const python = path.join(root, ".venv", "bin", "python");

test("ports the original structured filename identities and transitive company grouping", { skip: !existsSync(python) }, () => {
  const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(root)})
from identify_uploads import asdict, cluster, filename_identity
names = [
  "阳光电源-20260615.pdf",
  "300274 v44.xlsx",
  "阳光电源300274近况交流会260701_原文.pdf",
  "1783838815979_NVIDIA+Corporation_NVDA.OQ_2025_Jul_15.xlsm",
]
items = [{"itemId": str(i), "identity": asdict(filename_identity(name))} for i, name in enumerate(names)]
print(json.dumps({"identities": [item["identity"] for item in items], "groups": [[entry["itemId"] for entry in group] for group in cluster(items)]}, ensure_ascii=False))
`;
  const result = JSON.parse(execFileSync(python, ["-c", program], { encoding: "utf8" }));
  assert.equal(result.identities[3].company_name, "NVIDIA Corporation");
  assert.equal(result.identities[3].company_ticker, "NVDA.OQ");
  assert.deepEqual(result.groups, [["0", "1", "2"], ["3"]]);
});
