import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { GatewayTokenCipher } = await jiti.import("./token-cipher.ts");
const { PeGatewaySessionStore } = await jiti.import("./session-store.ts");
const {
  DockerCliWorkerEngine,
  isTransientWslInteropError,
  PeWorkerOrchestrator,
  workerContainerName,
  workerHomePath,
  workerNetworkName,
  workerVolumeName,
} = await jiti.import("./worker-orchestrator.ts");

const alice = {
  userId: "11111111-1111-4111-8111-111111111111",
  dataNamespace: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "alice@example.com",
  accessToken: "access",
  refreshToken: "refresh",
  accessExpiresAt: 4_000,
  sessionExpiresAt: 5_000,
  createdAt: 1_000,
  updatedAt: 1_000,
};

class FakeWorkerEngine {
  networks = new Map();
  volumes = new Map();
  containers = new Map();
  containerSpecs = new Map();
  actions = [];

  async ensureNetwork(name, dataNamespace) {
    this.networks.set(name, dataNamespace);
    this.actions.push(["network", name]);
  }

  async ensureVolume(name, dataNamespace) {
    this.volumes.set(name, dataNamespace);
    this.actions.push(["volume", name]);
  }

  async inspectContainer(name) {
    const state = this.containers.get(name);
    return state ? structuredClone(state) : null;
  }

  async createContainer(spec) {
    this.actions.push(["create", spec.name]);
    this.containerSpecs.set(spec.name, structuredClone(spec));
    this.containers.set(spec.name, {
      running: false,
      health: "starting",
      capability: spec.capability,
      hostPort: 31_001,
      labels: {
        "com.capoo.pe.worker": "true",
        "com.capoo.pe.user-id": spec.userId,
        "com.capoo.pe.data-namespace": spec.dataNamespace,
      },
    });
  }

  async startContainer(name) {
    this.actions.push(["start", name]);
    const state = this.containers.get(name);
    state.running = true;
    state.health = "healthy";
  }

  async stopContainer(name) {
    this.actions.push(["stop", name]);
    const state = this.containers.get(name);
    state.running = false;
    state.health = "none";
  }

  async removeContainer(name) {
    this.actions.push(["remove", name]);
    this.containers.delete(name);
  }
}

async function withOrchestrator(run) {
  const root = await mkdtemp(join(tmpdir(), "pe-worker-orchestrator-"));
  const store = new PeGatewaySessionStore(
    join(root, "gateway.sqlite3"),
    new GatewayTokenCipher(Buffer.alloc(32, 4)),
  );
  const engine = new FakeWorkerEngine();
  let currentTime = 1_000;
  const config = {
    storage: "bind",
    image: "pe-workbench-worker:test",
    dataRoot: join(root, "users"),
    idleSeconds: 60,
    capabilityTtlSeconds: 120,
    startTimeoutMs: 1_000,
    cpuLimit: 2,
    memoryMb: 4096,
    pidsLimit: 256,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  };
  const orchestrator = new PeWorkerOrchestrator(
    config,
    store,
    engine,
    () => currentTime,
    async () => {},
    false,
    async () => Response.json({ runningSessionIds: [] }),
  );
  try {
    await run({
      engine,
      orchestrator,
      store,
      setTime(value) { currentTime = value; },
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("derives deterministic worker resources only from canonical namespaces", () => {
  assert.equal(workerContainerName(alice.dataNamespace), "pe-worker-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa");
  assert.equal(workerNetworkName(alice.dataNamespace), "pe-net-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa");
  assert.equal(workerVolumeName(alice.dataNamespace), "pe-home-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa");
  assert.match(workerHomePath("/srv/pe/users", alice.dataNamespace), /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa[\\/]home$/u);
  assert.throws(() => workerContainerName("../../root"), /canonical UUID/u);
});

test("retries only recognized transient WSL docker.exe transport failures", async () => {
  const transient = new Error("<3>WSL (93313 - ) ERROR: UtilAcceptVsock:273: accept4 failed 110");
  assert.equal(isTransientWslInteropError(transient), true);
  assert.equal(isTransientWslInteropError(new Error("permission denied")), false);

  const calls = [];
  const delays = [];
  const engine = new DockerCliWorkerEngine(
    async (args) => {
      calls.push(args);
      if (calls.length === 1) throw transient;
      return {
        stdout: JSON.stringify([{
          Labels: {
            "com.capoo.pe.worker": "true",
            "com.capoo.pe.data-namespace": alice.dataNamespace,
          },
        }]),
        stderr: "",
      };
    },
    async (milliseconds) => { delays.push(milliseconds); },
    true,
  );
  await engine.ensureNetwork(workerNetworkName(alice.dataNamespace), alice.dataNamespace);
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [200]);
});

test("creates one hardened worker target for concurrent first requests", async () => {
  await withOrchestrator(async ({ engine, orchestrator, store }) => {
    const [first, second] = await Promise.all([
      orchestrator.ensureWorker(alice),
      orchestrator.ensureWorker(alice),
    ]);
    assert.deepEqual(first, second);
    assert.equal(first.baseUrl, "http://127.0.0.1:31001");
    assert.equal(engine.actions.filter(([action]) => action === "create").length, 1);
    assert.equal(engine.actions.filter(([action]) => action === "start").length, 1);
    assert.equal(store.getWorkerInstance(alice.dataNamespace).containerName, first.containerName);
  });
});

test("maps Alice and Bob to different containers, networks, homes, and capabilities", async () => {
  await withOrchestrator(async ({ engine, orchestrator }) => {
    const bob = {
      ...alice,
      userId: "22222222-2222-4222-8222-222222222222",
      dataNamespace: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      email: "bob@example.com",
    };
    const aliceTarget = await orchestrator.ensureWorker(alice);
    const bobTarget = await orchestrator.ensureWorker(bob);
    assert.notEqual(aliceTarget.containerName, bobTarget.containerName);
    assert.notEqual(aliceTarget.capability, bobTarget.capability);
    assert.equal(engine.networks.size, 2);
    const createActions = engine.actions.filter(([action]) => action === "create");
    assert.deepEqual(createActions.map(([, name]) => name).sort(), [
      aliceTarget.containerName,
      bobTarget.containerName,
    ].sort());
    assert.notEqual(
      engine.containerSpecs.get(aliceTarget.containerName).homeSource,
      engine.containerSpecs.get(bobTarget.containerName).homeSource,
    );
  });
});

test("uses a labeled deterministic Docker volume when volume storage is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-worker-volume-"));
  const store = new PeGatewaySessionStore(
    join(root, "gateway.sqlite3"),
    new GatewayTokenCipher(Buffer.alloc(32, 8)),
  );
  const engine = new FakeWorkerEngine();
  const config = {
    storage: "volume",
    image: "pe-workbench-worker:test",
    dataRoot: join(root, "unused-bind-root"),
    idleSeconds: 60,
    capabilityTtlSeconds: 120,
    startTimeoutMs: 1_000,
    cpuLimit: 2,
    memoryMb: 4096,
    pidsLimit: 256,
    uid: 1000,
    gid: 1000,
  };
  const orchestrator = new PeWorkerOrchestrator(
    config,
    store,
    engine,
    () => 1_000,
    async () => {},
    false,
  );
  try {
    const target = await orchestrator.ensureWorker(alice);
    const volumeName = workerVolumeName(alice.dataNamespace);
    assert.equal(engine.volumes.get(volumeName), alice.dataNamespace);
    assert.equal(engine.containerSpecs.get(target.containerName).homeStorage, "volume");
    assert.equal(engine.containerSpecs.get(target.containerName).homeSource, volumeName);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("starts a stopped worker without replacing its valid capability", async () => {
  await withOrchestrator(async ({ engine, orchestrator }) => {
    const first = await orchestrator.ensureWorker(alice);
    const state = engine.containers.get(first.containerName);
    state.running = false;
    state.health = "none";
    const second = await orchestrator.ensureWorker(alice);
    assert.equal(second.capability, first.capability);
    assert.equal(engine.actions.filter(([action]) => action === "create").length, 1);
    assert.equal(engine.actions.filter(([action]) => action === "start").length, 2);
  });
});

test("recreates a worker whose capability expired", async () => {
  await withOrchestrator(async ({ engine, orchestrator, setTime }) => {
    const first = await orchestrator.ensureWorker(alice);
    setTime(1_121);
    const second = await orchestrator.ensureWorker(alice);
    assert.notEqual(second.capability, first.capability);
    assert.equal(engine.actions.filter(([action]) => action === "remove").length, 1);
    assert.equal(engine.actions.filter(([action]) => action === "create").length, 2);
  });
});

test("stops only workers that crossed the persisted idle deadline", async () => {
  await withOrchestrator(async ({ engine, orchestrator }) => {
    const target = await orchestrator.ensureWorker(alice);
    assert.deepEqual(await orchestrator.stopIdleWorkers(1_059), []);
    assert.deepEqual(await orchestrator.stopIdleWorkers(1_060), [target.containerName]);
    assert.equal(engine.containers.get(target.containerName).running, false);
  });
});

test("keeps an idle worker alive while an agent session is running", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-worker-busy-"));
  const store = new PeGatewaySessionStore(
    join(root, "gateway.sqlite3"),
    new GatewayTokenCipher(Buffer.alloc(32, 6)),
  );
  const engine = new FakeWorkerEngine();
  const config = {
    storage: "bind",
    image: "pe-workbench-worker:test",
    dataRoot: join(root, "users"),
    idleSeconds: 60,
    capabilityTtlSeconds: 120,
    startTimeoutMs: 1_000,
    cpuLimit: 2,
    memoryMb: 4096,
    pidsLimit: 256,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  };
  const orchestrator = new PeWorkerOrchestrator(
    config,
    store,
    engine,
    () => 1_000,
    async () => {},
    false,
    async () => Response.json({ runningSessionIds: ["active-session"] }),
  );
  try {
    const target = await orchestrator.ensureWorker(alice);
    assert.deepEqual(await orchestrator.stopIdleWorkers(1_060), []);
    assert.equal(engine.containers.get(target.containerName).running, true);
    assert.equal(store.getWorkerInstance(alice.dataNamespace).lastAccessAt, 1_060);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("passes a capability through process environment, never Docker arguments", async () => {
  const calls = [];
  const engine = new DockerCliWorkerEngine(async (args, options) => {
    calls.push({ args, options });
    return { stdout: "", stderr: "" };
  });
  await engine.createContainer({
    name: workerContainerName(alice.dataNamespace),
    networkName: workerNetworkName(alice.dataNamespace),
    image: "pe-workbench-worker:test",
    userId: alice.userId,
    dataNamespace: alice.dataNamespace,
    homeStorage: "volume",
    homeSource: workerVolumeName(alice.dataNamespace),
    capability: "pew_secret-capability-value",
    cpuLimit: 2,
    memoryMb: 4096,
    pidsLimit: 256,
    uid: 1000,
    gid: 1000,
  });
  assert.equal(calls[0].args.includes("pew_secret-capability-value"), false);
  assert.equal(calls[0].options.env.PE_WORKER_CAPABILITY, "pew_secret-capability-value");
  assert.ok(calls[0].args.includes("127.0.0.1::30141"));
  assert.ok(calls[0].args.includes("no-new-privileges"));
  assert.ok(calls[0].args.includes(`type=volume,src=${workerVolumeName(alice.dataNamespace)},dst=/home/pi`));
});
