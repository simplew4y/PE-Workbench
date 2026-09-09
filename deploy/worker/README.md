# PE Workbench worker image

Build from the directory that contains both repositories:

```bash
docker build \
  -f PE-Workbench-pi-web/deploy/worker/Dockerfile \
  -t pe-workbench-worker:local \
  .
```

The worker image is intentionally not published directly. It runs as UID/GID
`1000:1000`, persists all user state below `/home/pi`, binds an ephemeral port
only on host loopback, and accepts protected API traffic only when the Gateway
supplies the worker's capability in `X-PE-Worker-Capability`.

On a native Linux host, use `PE_WORKER_STORAGE=bind`; the Gateway creates the
host directory and makes it writable by UID/GID 1000. With Docker Desktop for
Windows, use `PE_WORKER_STORAGE=volume` so a labeled, deterministic Docker
volume is used instead of a WSL `/home` bind mount. Generate a unique capability
for every worker; never reuse the Gateway session secret or place backend
credentials in the worker environment.

Every user gets a separate bridge network. It is deliberately not Docker's
`internal: true` mode: platform and custom models need outbound HTTPS. Isolation
comes from one network per `data_namespace`, no public bind, a signed request
context, and the worker capability. The Gateway process is expected to run on
the Docker host and forwards requests through the loopback-only port.

Run the real orchestration smoke test from the web repository with:

```bash
PE_DOCKER_COMMAND=docker.exe node scripts/smoke-worker-orchestrator.mjs
```

The script uses random resource names and removes its container, network,
volume, and temporary database on completion.

To verify two real workers have separate volumes, files, networks, and
capabilities, run:

```bash
PE_DOCKER_COMMAND=docker.exe node scripts/smoke-worker-isolation.mjs
```

This test also uses random namespaces and cleans up only the resources it
created. It does not touch workers belonging to signed-in development users.
