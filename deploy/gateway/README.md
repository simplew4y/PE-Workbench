# PE Workbench Gateway deployment

The Gateway owns browser sessions and starts one isolated worker per PE user.
It therefore needs the Docker socket and must be treated as a host-privileged
service. It runs with host networking because worker ports are intentionally
published only on `127.0.0.1`.

Build the worker first from the directory containing both repositories:

```bash
docker build -f PE-Workbench-pi-web/deploy/worker/Dockerfile \
  -t pe-workbench-worker:local .
```

Copy `gateway.env.example` to `gateway.env`, replace the session secret, then:

```bash
docker compose -f PE-Workbench-pi-web/deploy/gateway/compose.host.yaml up -d --build
curl -fsS http://127.0.0.1:30141/api/health
```

The web app currently uses root-relative routes, so production Nginx must give
it a dedicated HTTPS hostname. The sample server block preserves SSE and upload
streaming. DNS and a certificate for that hostname must exist before enabling
it.

Before production rollout, provide enough free memory and disk for at least the
Gateway plus one worker. Do not deploy onto a host already close to memory or
disk exhaustion. Configure swap as a safety net, but do not count swap as worker
capacity.
