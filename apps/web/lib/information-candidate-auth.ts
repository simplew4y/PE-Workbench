import { timingSafeEqual } from "node:crypto";

export function isAuthorizedInformationDelivery(request: Request, token = process.env.PE_WORKBENCH_INGEST_TOKEN): boolean {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/api/pe/information-candidates") return false;
  const expected = token?.trim();
  const authorization = request.headers.get("authorization");
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}
