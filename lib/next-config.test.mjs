import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.dirname(projectRoot);

test("scopes Next.js output file tracing to the shared local workspace", async () => {
  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });

  assert.equal(config.outputFileTracingRoot, workspaceRoot);
});

test("keeps the PE agent runtime outside the Next.js bundler", async () => {
  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });

  assert.equal(config.transpilePackages, undefined);
  assert.ok(config.serverExternalPackages.includes("@earendil-works/pe-boot"));
});

test("allows the proxy to forward PE research uploads to the bounded route parser", async () => {
  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });

  assert.equal(config.experimental.proxyClientMaxBodySize, "320mb");
});
