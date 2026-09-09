import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const proxySource = await readFile(new URL("./proxy.ts", import.meta.url), "utf8");

test("keeps account endpoints public so their own handlers can bootstrap sessions", () => {
  assert.match(proxySource, /PUBLIC_PE_API_PATHS = new Set\(\[[\s\S]*?"\/api\/runtime-mode"/);
  assert.match(proxySource, /pathname\.startsWith\("\/api\/account\/"\)/);
  assert.doesNotMatch(proxySource, /PUBLIC_PE_API_PATHS[\s\S]*?\/api\/sessions/);
  assert.doesNotMatch(proxySource, /PUBLIC_PE_API_PATHS[\s\S]*?\/api\/agent/);
  assert.doesNotMatch(proxySource, /PUBLIC_PE_API_PATHS[\s\S]*?\/api\/files/);
});

test("requires a valid account session before dispatching protected local APIs", () => {
  assert.match(proxySource, /if \(!isPeMultiUserMode\(\) \|\| isPublicPeApiPath/);
  assert.match(proxySource, /sessionIdFromRequest\(request, gateway\.config\)/);
  assert.match(proxySource, /await gateway\.auth\.requireSession\(sessionId\)/);
  assert.match(proxySource, /if \(!session\)/);
  assert.match(proxySource, /await gateway\.auth\.currentUser\(sessionId\)/);
  assert.match(proxySource, /return null;/);
  assert.match(proxySource, /if \(dispatched\) return dispatched/);
});

test("does not dispatch APIs through a Docker worker", () => {
  assert.doesNotMatch(proxySource, /pe-runtime-role|worker-proxy|ensureWorker|forwardPeWorkerRequest/);
  assert.doesNotMatch(proxySource, /worker_unavailable|PE worker proxy failed/);
});

test("fails closed and clears rejected sessions", () => {
  assert.match(proxySource, /if \(!sessionId\) return unauthenticated\(\)/);
  assert.match(proxySource, /clearSessionCookie\(response, gateway\.config\)/);
  assert.match(proxySource, /response\.status === 401 \|\| response\.status === 403/);
});
