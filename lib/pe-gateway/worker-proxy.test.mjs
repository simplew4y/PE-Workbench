import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  forwardPeWorkerRequest,
  isGatewayOwnedApiPath,
  isPeProxyRequestAbort,
  workerRequestNeedsUserContext,
} = await createJiti(import.meta.url).import("./worker-proxy.ts");

test("recognizes client-side request cancellation without masking other failures", () => {
  class ResponseAborted extends Error {}
  assert.equal(isPeProxyRequestAbort({ name: "AbortError" }), true);
  assert.equal(isPeProxyRequestAbort({ name: "ResponseAborted" }), true);
  assert.equal(isPeProxyRequestAbort(new ResponseAborted()), true);
  assert.equal(isPeProxyRequestAbort({ code: "UND_ERR_ABORTED" }), true);
  assert.equal(isPeProxyRequestAbort(new Error("worker failed")), false);
});

const target = {
  containerName: "pe-worker-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
  baseUrl: "http://127.0.0.1:31001",
  capability: "pew_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

test("keeps account and model-service APIs on the gateway", () => {
  assert.equal(isGatewayOwnedApiPath("/api/account/me"), true);
  assert.equal(isGatewayOwnedApiPath("/api/model-service"), true);
  assert.equal(isGatewayOwnedApiPath("/api/sessions"), false);
});

test("adds model context only to routes that may create an agent runtime", () => {
  assert.equal(workerRequestNeedsUserContext("/api/models", "GET"), true);
  assert.equal(workerRequestNeedsUserContext("/api/agent/new", "POST"), true);
  assert.equal(workerRequestNeedsUserContext("/api/agent/session-a", "POST"), true);
  assert.equal(workerRequestNeedsUserContext("/api/agent/session-a", "GET"), false);
  assert.equal(workerRequestNeedsUserContext("/api/agent/session-a/events", "GET"), true);
  assert.equal(workerRequestNeedsUserContext("/api/agent/running", "GET"), false);
  assert.equal(workerRequestNeedsUserContext("/api/sessions/session-a/auto-name", "POST"), true);
});

test("streams requests to loopback workers without forwarding browser credentials", async () => {
  let captured;
  const request = new Request("https://capoo.fun/api/agent/new?mode=one", {
    method: "POST",
    headers: {
      Authorization: "Bearer browser-secret",
      Cookie: "pe_session=browser-secret",
      "Content-Type": "application/json",
      "X-PE-Worker-Capability": "forged",
      "X-PE-Worker-Context": "forged",
    },
    body: JSON.stringify({ type: "ensure_session" }),
  });
  const response = await forwardPeWorkerRequest(
    request,
    target,
    { userName: "Alice", source: "custom" },
    async (url, init) => {
      captured = { url: String(url), init };
      return new Response("event: ready\n\n", {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Set-Cookie": "worker=secret",
          "Content-Length": "14",
        },
      });
    },
  );
  assert.equal(captured.url, "http://127.0.0.1:31001/api/agent/new?mode=one");
  assert.equal(captured.init.headers.get("authorization"), null);
  assert.equal(captured.init.headers.get("cookie"), null);
  assert.equal(captured.init.headers.get("x-pe-worker-capability"), target.capability);
  assert.notEqual(captured.init.headers.get("x-pe-worker-context"), "forged");
  assert.equal(await new Response(captured.init.body).text(), JSON.stringify({ type: "ensure_session" }));
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("x-pe-worker-proxied"), "1");
  assert.equal(await response.text(), "event: ready\n\n");
});
