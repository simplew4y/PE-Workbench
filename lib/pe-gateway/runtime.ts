import { PeGatewayAuthService } from "./auth-service.ts";
import { PeBackendClient } from "./backend-client.ts";
import { loadPeGatewayConfig, type PeGatewayConfig } from "./config.ts";
import { PeGatewaySessionStore } from "./session-store.ts";
import { GatewayTokenCipher } from "./token-cipher.ts";
import { PeGatewayModelService } from "./model-service.ts";

export interface PeGatewayRuntime {
  config: PeGatewayConfig;
  store: PeGatewaySessionStore;
  backend: PeBackendClient;
  auth: PeGatewayAuthService;
  models: PeGatewayModelService;
}

declare global {
  var __peGatewayRuntime: PeGatewayRuntime | undefined;
}

export function getPeGatewayRuntime(): PeGatewayRuntime {
  if (globalThis.__peGatewayRuntime) return globalThis.__peGatewayRuntime;
  const config = loadPeGatewayConfig();
  const store = new PeGatewaySessionStore(
    config.databasePath,
    new GatewayTokenCipher(config.sessionSecret),
  );
  const backend = new PeBackendClient(config.backendUrl, config.backendTimeoutMs);
  globalThis.__peGatewayRuntime = {
    config,
    store,
    backend,
    auth: new PeGatewayAuthService(backend, store, config.sessionTtlSeconds),
    models: new PeGatewayModelService(backend, store),
  };
  return globalThis.__peGatewayRuntime;
}
