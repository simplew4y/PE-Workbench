import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { peStorageErrorResponse } = await jiti.import("./pe-storage-errors.ts");

test("reports disk exhaustion as insufficient storage without exposing server paths", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const fields of [{ code: "ENOSPC" }, { code: "EDQUOT" }, { code: "ERR_SQLITE_ERROR", errcode: 13 }]) {
    const error = Object.assign(new Error("cannot write /private/project/path"), fields);
    const response = peStorageErrorResponse(new Error("Upload failed", { cause: error }));
    assert.equal(response.status, 507);
    assert.match((await response.json()).error, /服务器存储空间不足/u);
  }
});

test("database access errors stay server failures rather than invalid project requests", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const fields of [{ errcode: 14 }, { errcode: 14 | (3 << 8) }, { code: "EACCES" }, { code: "EPERM" }]) {
    const response = peStorageErrorResponse(Object.assign(new Error("unable to open database file"), fields));
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /磁盘空间和目录读写权限/u);
  }
});

test("does not misclassify missing projects, malformed data or circular causes", () => {
  const circular = new Error("Project not found");
  circular.cause = circular;
  for (const error of [circular, { code: "ENOENT" }, { errcode: 19 }, null, "ENOSPC"]) {
    assert.equal(peStorageErrorResponse(error), null);
  }
});
