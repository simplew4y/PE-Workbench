import assert from "node:assert/strict";
import test from "node:test";

const {
  findCanonicalPeProject,
  normalizedPeTicker,
  peCompaniesMatch,
} = await import("./pe-auto-project.ts");

test("normalizes company suffixes and exchange suffixes like the original router", () => {
  assert.equal(peCompaniesMatch("阳光电源", "阳光电源股份有限公司"), true);
  assert.equal(peCompaniesMatch("NVIDIA", "NVIDIA Corporation"), true);
  assert.equal(normalizedPeTicker("300274.SZ"), "300274");
  assert.equal(normalizedPeTicker("300274.SH"), "300274");
});

test("uses the oldest canonical project for the same company", () => {
  const base = {
    status: "ready", root: "/tmp/project", projectKey: "key", companyTicker: "",
    fileCount: 0, updatedAt: "2026-01-01T00:00:00Z",
  };
  const projects = [
    { ...base, datasetId: "new", name: "阳光电源二期", companyName: "阳光电源股份有限公司", createdAt: "2026-02-01T00:00:00Z" },
    { ...base, datasetId: "main", name: "阳光电源主项目", companyName: "阳光电源股份有限公司", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const match = findCanonicalPeProject({
    company_name: "阳光电源", company_ticker: "", company_confidence: 0.97,
    ticker_confidence: 0, method: "filename_company",
  }, projects);
  assert.equal(match?.datasetId, "main");
});
