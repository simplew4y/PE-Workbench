import type { NextRequest } from "next/server";
import { ResearchError } from "@earendil-works/pe-boot";
import { getPeGatewayRuntime } from "./pe-gateway/runtime";
import { localAccountContext } from "./pe-gateway/local-context";
import { sessionIdFromRequest } from "./pe-gateway/route-helpers";
import { getPeProject } from "./pe-project-store";
import { assertPeUserPathAllowed } from "./pe-multi-user-paths";
import { isApiRequestAllowed } from "./request-security";

export async function iterationRequestContext(request: NextRequest, datasetId: string) {
  if (!isApiRequestAllowed(request)) throw new ResearchError(403, "Untrusted API request");
  const gateway = getPeGatewayRuntime();
  const sessionId = sessionIdFromRequest(request, gateway.config);
  const account = await localAccountContext(gateway, sessionId);
  if (!account) throw new ResearchError(401, "请登录账户后重试。");
  const project = getPeProject(datasetId);
  assertPeUserPathAllowed(project.root);
  return { project, sessionId, userId: account.user.id };
}
