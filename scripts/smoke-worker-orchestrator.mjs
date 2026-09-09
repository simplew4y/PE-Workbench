import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);
const jiti = createJiti(import.meta.url);
const { GatewayTokenCipher } = await jiti.import("../lib/pe-gateway/token-cipher.ts");
const { PeGatewaySessionStore } = await jiti.import("../lib/pe-gateway/session-store.ts");
const {
  PeWorkerOrchestrator,
  workerContainerName,
  workerNetworkName,
  workerVolumeName,
} = await jiti.import("../lib/pe-gateway/worker-orchestrator.ts");

const dockerCommand = process.env.PE_DOCKER_COMMAND?.trim() || "docker";
const dataNamespace = randomUUID();
const userId = randomUUID();
const containerName = workerContainerName(dataNamespace);
const networkName = workerNetworkName(dataNamespace);
const volumeName = workerVolumeName(dataNamespace);
const root = await mkdtemp(join(tmpdir(), "pe-worker-smoke-"));
const store = new PeGatewaySessionStore(
  join(root, "gateway.sqlite3"),
  new GatewayTokenCipher(Buffer.alloc(32, 9)),
);

async function docker(args) {
  return execFileAsync(dockerCommand, args, { encoding: "utf8", timeout: 120_000 });
}

async function cleanup() {
  for (const args of [
    ["container", "rm", "--force", containerName],
    ["network", "rm", networkName],
    ["volume", "rm", volumeName],
  ]) {
    try {
      await docker(args);
    } catch {
      // A resource may not have been created if the smoke test failed early.
    }
  }
}

try {
  const now = Math.floor(Date.now() / 1000);
  const orchestrator = new PeWorkerOrchestrator(
    {
      storage: "volume",
      image: process.env.PE_WORKER_IMAGE?.trim() || "pe-workbench-worker:local",
      dataRoot: join(root, "unused-bind-root"),
      idleSeconds: 1_800,
      capabilityTtlSeconds: 3_600,
      startTimeoutMs: 120_000,
      cpuLimit: 2,
      memoryMb: 4_096,
      pidsLimit: 256,
      uid: 1_000,
      gid: 1_000,
    },
    store,
    undefined,
    () => now,
    undefined,
    false,
  );
  const target = await orchestrator.ensureWorker({
    userId,
    dataNamespace,
    email: "smoke@example.test",
    accessToken: "unused",
    refreshToken: "unused",
    accessExpiresAt: now + 1_800,
    sessionExpiresAt: now + 3_600,
    createdAt: now,
    updatedAt: now,
  });
  const unauthorized = await fetch(`${target.baseUrl}/api/agent/running`, { cache: "no-store" });
  const authorized = await fetch(`${target.baseUrl}/api/agent/running`, {
    cache: "no-store",
    headers: { "X-PE-Worker-Capability": target.capability },
  });
  const { stdout: inspectOutput } = await docker([
    "container",
    "inspect",
    containerName,
    "--format",
    "{{json .Mounts}}|{{json .HostConfig.SecurityOpt}}|{{json .HostConfig.PortBindings}}",
  ]);
  if (unauthorized.status !== 401 || authorized.status !== 200) {
    throw new Error(`Unexpected worker authorization statuses: ${unauthorized.status}/${authorized.status}`);
  }
  if (!inspectOutput.includes(volumeName) || !inspectOutput.includes("no-new-privileges")) {
    throw new Error("Worker inspection did not contain the expected volume and security policy");
  }
  console.log(JSON.stringify({
    containerName,
    networkName,
    volumeName,
    unauthorizedStatus: unauthorized.status,
    authorizedStatus: authorized.status,
    cleanup: "pending",
  }));
} catch (error) {
  try {
    const { stdout, stderr } = await docker(["container", "logs", containerName]);
    console.error(stdout || stderr);
  } catch {
    // The container might not exist yet.
  }
  throw error;
} finally {
  store.close();
  await cleanup();
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: "complete" }));
}
