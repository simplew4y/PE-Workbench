import assert from "node:assert/strict";
import test from "node:test";
import { isAuthorizedInformationDelivery } from "./information-candidate-auth.ts";

test("service credentials authorize only the exact information delivery operation", () => {
  const token = "test-only-delivery-token";
  const request = (path, method = "POST", authorization = `Bearer ${token}`) => new Request(`http://localhost${path}`, {
    method, headers: { authorization },
  });
  assert.equal(isAuthorizedInformationDelivery(request("/api/pe/information-candidates"), token), true);
  for (const path of ["/api/files", "/api/pe/framework-iterations", "/api/pe/information-candidates/extra"]) {
    assert.equal(isAuthorizedInformationDelivery(request(path), token), false);
  }
  for (const method of ["GET", "DELETE", "PUT"]) {
    assert.equal(isAuthorizedInformationDelivery(request("/api/pe/information-candidates", method), token), false);
  }
  for (const supplied of ["", "Bearer invalid", `bearer ${token}`, `Bearer ${token}x`]) {
    assert.equal(isAuthorizedInformationDelivery(request("/api/pe/information-candidates", "POST", supplied), token), false);
  }
  assert.equal(isAuthorizedInformationDelivery(request("/api/pe/information-candidates"), ""), false);
});
