import path from "node:path";
import type { PePdfDocumentMetadata } from "../contracts.ts";

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.trim()) record[key] = entry.trim();
    else if (typeof entry === "number" || typeof entry === "boolean") record[key] = String(entry);
  }
  return record;
}

function firstMatch(text: string, pattern: RegExp): string {
  return pattern.exec(text)?.[1]?.trim() ?? "";
}

function normalizeDate(value: string): string {
  const match = /(20\d{2})[年./-]?(\d{1,2})[月./-]?(\d{1,2})日?/u.exec(value);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function inferredTitle(filename: string, firstPageText: string): string {
  const candidates = firstPageText.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && line.length <= 120)
    .filter((line) => !/^\d{4}[年./-]/u.test(line))
    .filter((line) => !/证券研究报告|research report|仅供机构投资者/iu.test(line));
  return candidates[0] ?? path.parse(filename).name;
}

function extractExhibits(pageTexts: string[]): string[] {
  const exhibits: string[] = [];
  const seen = new Set<string>();
  const pattern = /^(?:(?:图|表)\s*\d+|(?:Exhibit|Figure|Table)\s*\d+)\s*[：:.-]?\s*.{0,140}$/gimu;
  for (const text of pageTexts) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      exhibits.push(value);
      if (exhibits.length >= 100) return exhibits;
    }
  }
  return exhibits;
}

export function extractPePdfMetadata(
  originalFilename: string,
  rawPdfMetadata: unknown,
  firstPageText: string,
  pageTexts: string[],
): PePdfDocumentMetadata {
  const pdfMetadata = stringRecord(rawPdfMetadata);
  const title = pdfMetadata.Title?.trim() || inferredTitle(originalFilename, firstPageText);
  const brokerage = firstMatch(
    firstPageText,
    /^(.{2,40}(?:证券(?:股份有限公司)?|证券研究所|Securities|Capital Markets|Research))\s*$/imu,
  );
  const dateCandidates = [
    firstMatch(firstPageText, /((?:20\d{2})[年./-]\d{1,2}[月./-]\d{1,2}日?)/u),
    originalFilename,
    pdfMetadata.CreationDate ?? "",
  ];
  const documentDate = dateCandidates.map(normalizeDate).find(Boolean) ?? "";
  const rating = firstMatch(
    firstPageText,
    /(?:投资评级|公司评级|评级|Rating)\s*[：:]\s*([^\n]{1,30})/iu,
  );
  const targetPrice = firstMatch(
    firstPageText,
    /(?:目标价|目标价格|Target Price)\s*[：:]?\s*([^\n]{1,30})/iu,
  );
  return {
    title,
    brokerage,
    documentDate,
    rating,
    targetPrice,
    exhibits: extractExhibits(pageTexts),
    pdfMetadata,
  };
}
