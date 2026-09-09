import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const root = await mkdtemp(join(tmpdir(), "pe-worker-isolation-"));
const store = new PeGatewaySessionStore(
  join(root, "gateway.sqlite3"),
  new GatewayTokenCipher(Buffer.alloc(32, 10)),
);
const now = Math.floor(Date.now() / 1000);

function testUser(label) {
  return {
    userId: randomUUID(),
    dataNamespace: randomUUID(),
    email: `${label}@example.test`,
    accessToken: "unused",
    refreshToken: "unused",
    accessExpiresAt: now + 1_800,
    sessionExpiresAt: now + 3_600,
    createdAt: now,
    updatedAt: now,
  };
}

const alice = testUser("alice");
const bob = testUser("bob");
const users = [alice, bob];

async function docker(args) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await execFileAsync(dockerCommand, args, { encoding: "utf8", timeout: 120_000 });
    } catch (error) {
      if (attempt >= 4 || !/WSL .*ERROR: UtilAcceptVsock.*failed/iu.test(String(error?.message))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));
    }
  }
}

async function cleanup() {
  for (const user of users) {
    const resources = [
      ["container", "rm", "--force", workerContainerName(user.dataNamespace)],
      ["network", "rm", workerNetworkName(user.dataNamespace)],
      ["volume", "rm", workerVolumeName(user.dataNamespace)],
    ];
    for (const args of resources) {
      try {
        await docker(args);
      } catch {
        // A resource may not exist if startup failed early.
      }
    }
  }
}

try {
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
  const aliceTarget = await orchestrator.ensureWorker(alice);
  const bobTarget = await orchestrator.ensureWorker(bob);
  const markerPath = "/home/pi/.pe-isolation-marker";
  const markerScript = "require('node:fs').writeFileSync(process.argv[1], process.argv[2], {mode: 0o600})";
  await docker(["container", "exec", aliceTarget.containerName, "node", "-e", markerScript, markerPath, "alice-only"]);
  await docker(["container", "exec", bobTarget.containerName, "node", "-e", markerScript, markerPath, "bob-only"]);
  const readScript = "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))";
  const aliceMarker = (await docker([
    "container", "exec", aliceTarget.containerName, "node", "-e", readScript, markerPath,
  ])).stdout;
  const bobMarker = (await docker([
    "container", "exec", bobTarget.containerName, "node", "-e", readScript, markerPath,
  ])).stdout;
  const wrongCapability = await fetch(`${aliceTarget.baseUrl}/api/agent/running`, {
    headers: { "X-PE-Worker-Capability": bobTarget.capability },
    cache: "no-store",
  });
  const ownCapability = await fetch(`${aliceTarget.baseUrl}/api/agent/running`, {
    headers: { "X-PE-Worker-Capability": aliceTarget.capability },
    cache: "no-store",
  });
  const { stdout: aliceMounts } = await docker([
    "container", "inspect", aliceTarget.containerName, "--format", "{{json .Mounts}}",
  ]);
  const aliceVolume = workerVolumeName(alice.dataNamespace);
  const bobVolume = workerVolumeName(bob.dataNamespace);
  if (
    aliceTarget.containerName === bobTarget.containerName
    || aliceTarget.capability === bobTarget.capability
    || aliceMarker !== "alice-only"
    || bobMarker !== "bob-only"
    || wrongCapability.status !== 401
    || ownCapability.status !== 200
    || !aliceMounts.includes(aliceVolume)
    || aliceMounts.includes(bobVolume)
  ) {
    throw new Error("Alice/Bob worker isolation assertion failed");
  }
  console.log(JSON.stringify({
    alice: {
      container: aliceTarget.containerName,
      network: workerNetworkName(alice.dataNamespace),
      volume: aliceVolume,
      marker: aliceMarker,
    },
    bob: {
      container: bobTarget.containerName,
      network: workerNetworkName(bob.dataNamespace),
      volume: bobVolume,
      marker: bobMarker,
    },
    crossCapabilityStatus: wrongCapability.status,
    ownCapabilityStatus: ownCapability.status,
    isolated: true,
    cleanup: "pending",
  }));
} finally {
  store.close();
  await cleanup();
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: "complete" }));
}
