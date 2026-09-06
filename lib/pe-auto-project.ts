import type { PeUploadIdentity } from "./pe-ingest";
import type { PeProjectSummary } from "./pe-project-types";

export const PE_UPLOAD_AUTO_CREATE_THRESHOLD = 0.92;

export function normalizedPeCompany(value: string): string {
  let text = value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "");
  for (const suffix of [
    "股份有限公司", "有限责任公司", "有限公司", "corporation", "incorporated",
    "holdings", "limited", "corp", "inc", "ltd",
  ]) {
    if (text.endsWith(suffix) && text.length > suffix.length) {
      text = text.slice(0, -suffix.length);
      break;
    }
  }
  return text;
}

export function normalizedPeTicker(value: string): string {
  let text = value.replace(/[^A-Za-z0-9]+/gu, "").toUpperCase();
  for (const suffix of ["SZ", "SH", "BJ", "HK", "OQ", "US", "CH", "PA", "DE", "L", "N"]) {
    if (text.endsWith(suffix) && text.length > suffix.length + 1) {
      text = text.slice(0, -suffix.length);
      break;
    }
  }
  return text;
}

export function peCompaniesMatch(left: string, right: string): boolean {
  const leftKey = normalizedPeCompany(left);
  const rightKey = normalizedPeCompany(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;
  return Math.min(leftKey.length, rightKey.length) >= 4
    && (leftKey.includes(rightKey) || rightKey.includes(leftKey));
}

export function findCanonicalPeProject(
  identity: PeUploadIdentity,
  projects: PeProjectSummary[],
): PeProjectSummary | null {
  const oldest = (candidates: PeProjectSummary[]) => [...candidates].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.datasetId.localeCompare(right.datasetId),
  )[0] ?? null;
  const ticker = normalizedPeTicker(identity.company_ticker);
  if (ticker) {
    const match = oldest(projects.filter(
      (project) => normalizedPeTicker(project.companyTicker) === ticker,
    ));
    if (match) return match;
  }
  if (!identity.company_name) return null;
  return oldest(projects.filter((project) => (
    peCompaniesMatch(identity.company_name, project.companyName)
    || peCompaniesMatch(identity.company_name, project.name)
  )));
}
