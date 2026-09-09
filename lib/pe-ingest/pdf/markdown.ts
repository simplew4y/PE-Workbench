import {
  PE_PDF_PARSER_NAME,
  PE_PDF_PARSER_VERSION,
  type PePdfDocumentMetadata,
  type PePdfPageArtifact,
} from "../contracts.ts";
import { EXHIBIT_CAPTION_PATTERN } from "./roles.ts";

const MAX_HEADER_EXHIBITS = 3;
const MAX_HEADER_EXHIBIT_CHARS = 120;

function commentValue(value: string): string {
  return value.replace(/--/gu, "-").replace(/[\r\n]+/gu, " ").trim();
}

/** Exhibit captions on the page, e.g. "EXHIBIT 3: Revenue mix", for the deterministic page header. */
export function pePdfPageExhibits(text: string): string[] {
  return [...text.matchAll(EXHIBIT_CAPTION_PATTERN)]
    .map((match) => match[0].trim().slice(0, MAX_HEADER_EXHIBIT_CHARS))
    .slice(0, MAX_HEADER_EXHIBITS);
}

/**
 * One deterministic line placed before page text in retrieval results and Markdown:
 * `document · brokerage · date · p.N/total · role · exhibit captions`.
 */
export function pePdfPageHeader(
  originalFilename: string,
  metadata: Pick<PePdfDocumentMetadata, "brokerage" | "documentDate">,
  page: Pick<PePdfPageArtifact, "pageNumber" | "role" | "text">,
  pageCount: number,
): string {
  return [
    originalFilename,
    metadata.brokerage,
    metadata.documentDate,
    `p.${page.pageNumber}/${pageCount}`,
    page.role,
    pePdfPageExhibits(page.text).join("; "),
  ].filter(Boolean).join(" · ");
}

export function renderPePdfMarkdown(
  originalFilename: string,
  metadata: PePdfDocumentMetadata,
  pages: PePdfPageArtifact[],
): string {
  const sections = pages.map((page) => {
    const header = page.pageHeader || pePdfPageHeader(originalFilename, metadata, page, pages.length);
    const body = page.text.trim() || "[本页无可提取文字，需 OCR；请查看页面图片。]";
    return [
      `<!-- page: ${page.pageNumber} -->`,
      `<!-- evidence_id: page:${commentValue(page.pageId)} -->`,
      `<!-- role: ${commentValue(page.role)} -->`,
      `<!-- image: ${commentValue(page.imagePaths[0] ?? "")} -->`,
      "",
      `> ${header}`,
      "",
      body,
    ].join("\n");
  });
  return `${sections.join("\n\n---\n\n")}\n`;
}

export function renderPePdfLayoutJson(
  document: {
    docId: string;
    datasetId: string;
    originalFilename: string;
    sha256: string;
    metadata: PePdfDocumentMetadata;
  },
  pages: PePdfPageArtifact[],
): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    parser: {
      name: PE_PDF_PARSER_NAME,
      version: PE_PDF_PARSER_VERSION,
    },
    document,
    pages: pages.map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      role: page.role,
      roleSignals: page.roleSignals,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
      text: page.text,
      pageHeader: page.pageHeader,
      textQuality: page.textQuality,
      qualitySignals: page.qualitySignals,
      imagePaths: page.imagePaths,
      imageStatistics: page.imageStatistics,
      blocks: page.blocks,
    })),
  }, null, 2)}\n`;
}
