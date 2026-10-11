import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  asrConfigView,
  defaultPeAsrConfig,
  parsePeAsrConfig,
  readPeAsrConfig,
  requireConfiguredPeAsr,
  writePeAsrConfig,
  PE_ASR_NOT_CONFIGURED_MESSAGE,
} = await jiti.import("./config.ts");

test("empty or missing config is not configured", () => {
  const root = mkdtempSync(join(tmpdir(), "pe-asr-"));
  try {
    const config = readPeAsrConfig(join(root, "missing.json"));
    assert.deepEqual(config, defaultPeAsrConfig());
    assert.equal(asrConfigView(config).configured, false);
    assert.throws(() => requireConfiguredPeAsr(config), new RegExp(PE_ASR_NOT_CONFIGURED_MESSAGE));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects non-http URLs and out-of-range chunk seconds", () => {
  assert.throws(() => parsePeAsrConfig({ serverUrl: "ftp://example.test" }), /http or https/u);
  assert.throws(() => parsePeAsrConfig({ serverUrl: "https://asr.example", maxChunkSeconds: 9 }), /10 to 600/u);
  assert.throws(() => parsePeAsrConfig({ serverUrl: "https://asr.example", maxChunkSeconds: 601 }), /10 to 600/u);
});

test("saves a trimmed https URL and reports configured", () => {
  const root = mkdtempSync(join(tmpdir(), "pe-asr-"));
  try {
    const path = join(root, "asr.json");
    const saved = writePeAsrConfig({
      serverUrl: "https://asr.example.test:8443/",
      maxChunkSeconds: 120,
      language: " Chinese ",
    }, path);
    assert.equal(saved.serverUrl, "https://asr.example.test:8443");
    assert.equal(saved.maxChunkSeconds, 120);
    assert.equal(saved.language, "Chinese");
    assert.equal(asrConfigView(saved).configured, true);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).serverUrl, saved.serverUrl);
    assert.deepEqual(readPeAsrConfig(path), saved);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
