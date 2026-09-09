import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { getPeUserRoot, isPeMultiUserMode, isPeUserPathAllowed } = await createJiti(import.meta.url)
  .import("./pe-multi-user-paths.ts");

test("recognizes the explicit multi-user mode flag", () => {
  assert.equal(isPeMultiUserMode({ PE_MULTI_USER_MODE: "true" }), true);
  assert.equal(isPeMultiUserMode({ PE_MULTI_USER_MODE: "0" }), false);
  assert.equal(isPeMultiUserMode({}), false);
});

test("restricts paths and resolved symlinks to the configured user root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-user-root-"));
  const outside = await mkdtemp(join(tmpdir(), "pe-user-outside-"));
  const child = join(root, "project");
  await mkdir(child);
  await symlink(outside, join(root, "escape"));
  const env = { PE_MULTI_USER_MODE: "1", PE_USER_ROOT: root };
  try {
    assert.equal(getPeUserRoot(env), root);
    assert.equal(isPeUserPathAllowed(root, env), true);
    assert.equal(isPeUserPathAllowed(child, env), true);
    assert.equal(isPeUserPathAllowed(join(root, "new-project"), env), true);
    assert.equal(isPeUserPathAllowed(outside, env), false);
    assert.equal(isPeUserPathAllowed(join(root, "escape"), env), false);
    assert.equal(isPeUserPathAllowed(join(root, "escape", "not-created-yet"), env), false);
    assert.equal(isPeUserPathAllowed(join(root, "project", "..", "escape", "nested"), env), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("preserves unrestricted local Pi Web behavior when multi-user mode is off", () => {
  assert.equal(isPeUserPathAllowed("/", { PE_MULTI_USER_MODE: "0" }), true);
});
