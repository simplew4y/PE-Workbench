import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const proxySource = await readFile(new URL("./proxy.ts", import.meta.url), "utf8");

test("keeps only account bootstrap endpoints public in multi-user mode", () => {
  assert.match(proxySource, /PUBLIC_PE_API_PATHS = new Set\(\[[\s\S]*?"\/api\/runtime-mode"/);
  assert.match(proxySource, /!isPeWorkerRuntime\(\) && pathname\.startsWith\("\/api\/account\/"\)/);
  assert.doesNotMatch(proxySource, /PUBLIC_PE_API_PATHS[\s\S]*?\/api\/sessions/);
  assert.doesNotMatch(proxySource, /PUBLIC_PE_API_PATHS[\s\S]*?\/api\/agent/);
  assert.doesNotMatch(proxySource, /PUBLIC_PE_API_PATHS[\s\S]*?\/api\/files/);
});

test("requires a capability instead of a browser session inside workers", () => {
  assert.match(proxySource, /if \(isPeWorkerRuntime\(\)\)/);
  assert.match(proxySource, /isPeWorkerRequestAuthorized\(request\)/);
  assert.match(proxySource, /\? null\s*:\s*unauthenticated\(\)/);
});

test("requires a valid gateway session before dispatching protected APIs", () => {
  assert.match(proxySource, /if \(!isPeMultiUserMode\(\) \|\| isPublicPeApiPath/);
  assert.match(proxySource, /sessionIdFromRequest\(request, gateway\.config\)/);
  assert.match(proxySource, /await gateway\.auth\.requireSession\(sessionId\)/);
  assert.match(proxySource, /if \(!session\)/);
  assert.match(proxySource, /gateway\.workers\.ensureWorker\(session\)/);
  assert.match(proxySource, /forwardPeWorkerRequest\(request, target, context\)/);
  assert.match(proxySource, /if \(dispatched\) return dispatched/);
});

test("keeps gateway APIs local and forwards worker context only when needed", () => {
  assert.match(proxySource, /isGatewayOwnedApiPath\(request\.nextUrl\.pathname\)/);
  assert.match(proxySource, /workerRequestNeedsUserContext\(request\.nextUrl\.pathname, request\.method\)/);
  assert.match(proxySource, /workerRequestContext\(gateway, session, user\)/);
  assert.match(proxySource, /code: "worker_unavailable"/);
  assert.match(proxySource, /request\.signal\.aborted \|\| isPeProxyRequestAbort\(error\)/);
  assert.match(proxySource, /status: 499/);
});

test("fails closed and clears rejected sessions", () => {
  assert.match(proxySource, /if \(!sessionId\) return unauthenticated\(\)/);
  assert.match(proxySource, /clearSessionCookie\(response, gateway\.config\)/);
  assert.match(proxySource, /response\.status === 401 \|\| response\.status === 403/);
});
