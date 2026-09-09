import { execFile } from "node:child_process";
import { chmod, chown, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PeGatewayConfig } from "./config.ts";
import type { GatewaySession, PeGatewaySessionStore } from "./session-store.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const WORKER_LABEL = "com.capoo.pe.worker";
const USER_LABEL = "com.capoo.pe.user-id";
const NAMESPACE_LABEL = "com.capoo.pe.data-namespace";

export interface WorkerContainerState {
  running: boolean;
  health: "healthy" | "starting" | "unhealthy" | "none";
  capability: string | null;
  hostPort: number | null;
  labels: Record<string, string>;
}

export interface WorkerContainerSpec {
  name: string;
  networkName: string;
  image: string;
  userId: string;
  dataNamespace: string;
  homeStorage: "bind" | "volume";
  homeSource: string;
  capability: string;
  cpuLimit: number;
  memoryMb: number;
  pidsLimit: number;
  uid: number;
  gid: number;
}

export interface WorkerEngine {
  ensureNetwork(name: string, dataNamespace: string): Promise<void>;
  ensureVolume(name: string, dataNamespace: string): Promise<void>;
  inspectContainer(name: string): Promise<WorkerContainerState | null>;
  createContainer(spec: WorkerContainerSpec): Promise<void>;
  startContainer(name: string): Promise<void>;
  stopContainer(name: string): Promise<void>;
  removeContainer(name: string): Promise<void>;
}

export interface WorkerTarget {
  containerName: string;
  baseUrl: string;
  capability: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandRunner = (
  args: string[],
  options?: { env?: Record<string, string> },
) => Promise<CommandResult>;

function canonicalUuid(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new Error(`${name} must be a canonical UUID`);
  return normalized;
}

export function workerContainerName(dataNamespace: string): string {
  return `pe-worker-${canonicalUuid(dataNamespace, "dataNamespace").replaceAll("-", "")}`;
}

export function workerNetworkName(dataNamespace: string): string {
  return `pe-net-${canonicalUuid(dataNamespace, "dataNamespace").replaceAll("-", "")}`;
}

export function workerVolumeName(dataNamespace: string): string {
  return `pe-home-${canonicalUuid(dataNamespace, "dataNamespace").replaceAll("-", "")}`;
}

export function workerHomePath(dataRoot: string, dataNamespace: string): string {
  return join(dataRoot, canonicalUuid(dataNamespace, "dataNamespace"), "home");
}

function execDocker(args: string[], options: { env?: Record<string, string> } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const dockerCommand = process.env.PE_DOCKER_COMMAND?.trim() || "docker";
    const childEnv: NodeJS.ProcessEnv = options.env
      ? { ...process.env, ...options.env }
      : { ...process.env };
    if (dockerCommand.toLowerCase().endsWith(".exe") && options.env) {
      const forwarded = Object.keys(options.env).map((name) => `${name}/w`);
      const existing = childEnv.WSLENV?.split(":").filter(Boolean) ?? [];
      childEnv.WSLENV = [...new Set([...existing, ...forwarded])].join(":");
    }
    execFile(dockerCommand, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
      env: childEnv,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(stderr.trim() || error.message), {
          code: (error as NodeJS.ErrnoException).code,
          stdout,
          stderr,
        }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isMissingDockerObject(error: unknown): boolean {
  return error instanceof Error
    && /(?:no such (?:object|container|network|volume)|(?:network|volume) .* not found)/iu.test(error.message);
}

export function isTransientWslInteropError(error: unknown): boolean {
  return error instanceof Error
    && /WSL .*ERROR: (?:UtilAcceptVsock|CreateProcess(?:Entry|Parse)Common).*failed/iu.test(error.message);
}

interface DockerInspectContainer {
  Config?: {
    Env?: string[];
    Labels?: Record<string, string>;
  };
  State?: {
    Running?: boolean;
    Health?: { Status?: string };
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
}

export class DockerCliWorkerEngine implements WorkerEngine {
  constructor(
    private readonly run: CommandRunner = execDocker,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly retryWslInterop = (process.env.PE_DOCKER_COMMAND?.trim() || "docker")
      .toLowerCase()
      .endsWith(".exe"),
  ) {}

  private async command(
    args: string[],
    options?: { env?: Record<string, string> },
  ): Promise<CommandResult> {
    const maxAttempts = this.retryWslInterop ? 4 : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.run(args, options);
      } catch (error) {
        if (attempt >= maxAttempts || !isTransientWslInteropError(error)) throw error;
        await this.sleep(200 * 2 ** (attempt - 1));
      }
    }
  }

  async ensureNetwork(name: string, dataNamespace: string): Promise<void> {
    try {
      const result = await this.command(["network", "inspect", name]);
      const networks = JSON.parse(result.stdout) as Array<{ Labels?: Record<string, string> }>;
      const labels = networks[0]?.Labels ?? {};
      if (labels[WORKER_LABEL] !== "true" || labels[NAMESPACE_LABEL] !== dataNamespace) {
        throw new Error(`Docker network ${name} is not owned by PE Workbench`);
      }
      return;
    } catch (error) {
      if (!isMissingDockerObject(error)) throw error;
    }
    await this.command([
      "network", "create",
      "--driver", "bridge",
      "--label", `${WORKER_LABEL}=true`,
      "--label", `${NAMESPACE_LABEL}=${dataNamespace}`,
      name,
    ]);
  }

  async ensureVolume(name: string, dataNamespace: string): Promise<void> {
    try {
      const result = await this.command(["volume", "inspect", name]);
      const volumes = JSON.parse(result.stdout) as Array<{ Labels?: Record<string, string> }>;
      const labels = volumes[0]?.Labels ?? {};
      if (labels[WORKER_LABEL] !== "true" || labels[NAMESPACE_LABEL] !== dataNamespace) {
        throw new Error(`Docker volume ${name} is not owned by PE Workbench`);
      }
      return;
    } catch (error) {
      if (!isMissingDockerObject(error)) throw error;
    }
    await this.command([
      "volume", "create",
      "--label", `${WORKER_LABEL}=true`,
      "--label", `${NAMESPACE_LABEL}=${dataNamespace}`,
      name,
    ]);
  }

  async inspectContainer(name: string): Promise<WorkerContainerState | null> {
    let result: CommandResult;
    try {
      result = await this.command(["container", "inspect", name]);
    } catch (error) {
      if (isMissingDockerObject(error)) return null;
      throw error;
    }
    const containers = JSON.parse(result.stdout) as DockerInspectContainer[];
    const container = containers[0];
    if (!container) throw new Error(`Docker returned no inspection data for ${name}`);
    const capabilityEntry = container.Config?.Env?.find((entry) => entry.startsWith("PE_WORKER_CAPABILITY="));
    const published = container.NetworkSettings?.Ports?.["30141/tcp"] ?? [];
    const loopbackPort = published?.find((entry) => entry.HostIp === "127.0.0.1")?.HostPort;
    const parsedPort = loopbackPort ? Number(loopbackPort) : NaN;
    const health = container.State?.Health?.Status;
    return {
      running: container.State?.Running === true,
      health: health === "healthy" || health === "starting" || health === "unhealthy"
        ? health
        : "none",
      capability: capabilityEntry?.slice("PE_WORKER_CAPABILITY=".length) || null,
      hostPort: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : null,
      labels: container.Config?.Labels ?? {},
    };
  }

  async createContainer(spec: WorkerContainerSpec): Promise<void> {
    const homeMount = spec.homeStorage === "bind"
      ? `type=bind,src=${spec.homeSource},dst=/home/pi`
      : `type=volume,src=${spec.homeSource},dst=/home/pi`;
    await this.command([
      "container", "create",
      "--name", spec.name,
      "--hostname", spec.name,
      "--init",
      "--restart", "unless-stopped",
      "--user", `${spec.uid}:${spec.gid}`,
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(spec.pidsLimit),
      "--memory", `${spec.memoryMb}m`,
      "--cpus", String(spec.cpuLimit),
      "--label", `${WORKER_LABEL}=true`,
      "--label", `${USER_LABEL}=${spec.userId}`,
      "--label", `${NAMESPACE_LABEL}=${spec.dataNamespace}`,
      "--network", spec.networkName,
      "--env", "PE_WORKER_CAPABILITY",
      "--mount", homeMount,
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m",
      "--tmpfs", "/workspace/PE-Workbench-pi-web/.next/cache:rw,noexec,nosuid,nodev,size=256m",
      "--publish", "127.0.0.1::30141",
      spec.image,
    ], { env: { PE_WORKER_CAPABILITY: spec.capability } });
  }

  async startContainer(name: string): Promise<void> {
    await this.command(["container", "start", name]);
  }

  async stopContainer(name: string): Promise<void> {
    await this.command(["container", "stop", "--time", "20", name]);
  }

  async removeContainer(name: string): Promise<void> {
    await this.command(["container", "rm", name]);
  }
}

function assertOwnedContainer(
  state: WorkerContainerState,
  userId: string,
  dataNamespace: string,
): void {
  if (
    state.labels[WORKER_LABEL] !== "true"
    || state.labels[USER_LABEL] !== userId
    || state.labels[NAMESPACE_LABEL] !== dataNamespace
  ) {
    throw new Error("Refusing to operate on a Docker container not owned by this PE user");
  }
}

export class PeWorkerOrchestrator {
  private readonly locks = new Map<string, Promise<WorkerTarget>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: PeGatewayConfig["worker"],
    private readonly store: PeGatewaySessionStore,
    private readonly engine: WorkerEngine = new DockerCliWorkerEngine(),
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly scheduleIdle = true,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  private async prepareHome(dataNamespace: string): Promise<string> {
    if (this.config.storage === "volume") {
      const volumeName = workerVolumeName(dataNamespace);
      await this.engine.ensureVolume(volumeName, dataNamespace);
      return volumeName;
    }
    const homePath = workerHomePath(this.config.dataRoot, dataNamespace);
    await mkdir(homePath, { recursive: true, mode: 0o700 });
    await chmod(homePath, 0o700);
    if (process.platform !== "win32") await chown(homePath, this.config.uid, this.config.gid);
    return homePath;
  }

  private async waitUntilHealthy(name: string): Promise<WorkerContainerState> {
    const deadline = Date.now() + this.config.startTimeoutMs;
    for (;;) {
      const state = await this.engine.inspectContainer(name);
      if (!state || !state.running) throw new Error(`Worker ${name} stopped during startup`);
      if (state.health === "healthy") return state;
      if (state.health === "unhealthy") throw new Error(`Worker ${name} failed its health check`);
      if (Date.now() >= deadline) throw new Error(`Worker ${name} did not become healthy in time`);
      await this.sleep(500);
    }
  }

  private scheduleIdleStop(dataNamespace: string): void {
    if (!this.scheduleIdle) return;
    const existing = this.idleTimers.get(dataNamespace);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.idleTimers.delete(dataNamespace);
      void this.stopIdleWorkers().catch((error) => {
        console.error("Failed to stop idle PE workers", error);
      });
    }, this.config.idleSeconds * 1000);
    timer.unref();
    this.idleTimers.set(dataNamespace, timer);
  }

  private async ensureUnlocked(session: GatewaySession): Promise<WorkerTarget> {
    const userId = canonicalUuid(session.userId, "userId");
    const dataNamespace = canonicalUuid(session.dataNamespace, "dataNamespace");
    const name = workerContainerName(dataNamespace);
    const networkName = workerNetworkName(dataNamespace);
    const recorded = this.store.getWorkerInstance(dataNamespace);
    if (recorded && (recorded.userId !== userId || recorded.containerName !== name)) {
      throw new Error("Worker namespace ownership does not match the authenticated user");
    }
    const homeSource = await this.prepareHome(dataNamespace);
    await this.engine.ensureNetwork(networkName, dataNamespace);

    let state = await this.engine.inspectContainer(name);
    if (state) assertOwnedContainer(state, userId, dataNamespace);
    let capability = state?.capability ?? "";
    const capabilityOwner = capability ? this.store.resolveWorkerCapability(capability, this.now()) : null;
    if (
      state
      && (!capabilityOwner
        || capabilityOwner.userId !== userId
        || capabilityOwner.dataNamespace !== dataNamespace)
    ) {
      if (state.running) await this.engine.stopContainer(name);
      await this.engine.removeContainer(name);
      state = null;
      capability = "";
    }

    if (!state) {
      this.store.revokeWorkerCapabilities(userId);
      const expiresAt = Math.min(
        session.sessionExpiresAt,
        this.now() + this.config.capabilityTtlSeconds,
      );
      capability = this.store.createWorkerCapability(userId, dataNamespace, expiresAt, this.now());
      try {
        await this.engine.createContainer({
          name,
          networkName,
          image: this.config.image,
          userId,
          dataNamespace,
          homeStorage: this.config.storage,
          homeSource,
          capability,
          cpuLimit: this.config.cpuLimit,
          memoryMb: this.config.memoryMb,
          pidsLimit: this.config.pidsLimit,
          uid: this.config.uid,
          gid: this.config.gid,
        });
      } catch (error) {
        this.store.revokeWorkerCapabilities(userId);
        throw error;
      }
      state = await this.engine.inspectContainer(name);
      if (!state) throw new Error(`Worker ${name} was not created`);
      assertOwnedContainer(state, userId, dataNamespace);
    }

    if (!state.running) await this.engine.startContainer(name);
    state = await this.waitUntilHealthy(name);
    if (!state.hostPort) throw new Error(`Worker ${name} has no loopback port`);
    this.store.touchWorkerInstance(userId, dataNamespace, name, this.now());
    this.scheduleIdleStop(dataNamespace);
    return {
      containerName: name,
      baseUrl: `http://127.0.0.1:${state.hostPort}`,
      capability,
    };
  }

  ensureWorker(session: GatewaySession): Promise<WorkerTarget> {
    const dataNamespace = canonicalUuid(session.dataNamespace, "dataNamespace");
    const existing = this.locks.get(dataNamespace);
    if (existing) return existing;
    const pending = this.ensureUnlocked(session).finally(() => {
      if (this.locks.get(dataNamespace) === pending) this.locks.delete(dataNamespace);
    });
    this.locks.set(dataNamespace, pending);
    return pending;
  }

  async stopIdleWorkers(now = this.now()): Promise<string[]> {
    const stopped: string[] = [];
    const idleBeforeOrAt = now - this.config.idleSeconds;
    for (const instance of this.store.listIdleWorkerInstances(idleBeforeOrAt)) {
      const state = await this.engine.inspectContainer(instance.containerName);
      if (state) {
        try {
          assertOwnedContainer(state, instance.userId, instance.dataNamespace);
        } catch {
          continue;
        }
        if (state.running && state.hostPort && state.capability) {
          try {
            const response = await this.fetchImplementation(
              `http://127.0.0.1:${state.hostPort}/api/agent/running`,
              {
                headers: { "X-PE-Worker-Capability": state.capability },
                cache: "no-store",
                signal: AbortSignal.timeout(5_000),
              },
            );
            if (!response.ok) throw new Error(`Worker activity check returned ${response.status}`);
            const activity = await response.json() as { runningSessionIds?: unknown };
            if (Array.isArray(activity.runningSessionIds) && activity.runningSessionIds.length > 0) {
              this.store.touchWorkerInstance(
                instance.userId,
                instance.dataNamespace,
                instance.containerName,
                now,
              );
              this.scheduleIdleStop(instance.dataNamespace);
              continue;
            }
          } catch (error) {
            console.error(`Skipping idle stop because ${instance.containerName} activity is unknown`, error);
            this.store.touchWorkerInstance(
              instance.userId,
              instance.dataNamespace,
              instance.containerName,
              now,
            );
            this.scheduleIdleStop(instance.dataNamespace);
            continue;
          }
        }
        if (state.running) await this.engine.stopContainer(instance.containerName);
      }
      stopped.push(instance.containerName);
    }
    return stopped;
  }
}
