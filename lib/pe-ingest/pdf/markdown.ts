import {
  PE_PDF_PARSER_NAME,
  PE_PDF_PARSER_VERSION,
  type PePdfDocumentMetadata,
  type PePdfPageArtifact,
} from "../contracts.ts";

function commentValue(value: string): string {
  return value.replace(/--/gu, "-").replace(/[\r\n]+/gu, " ").trim();
}

function pageExhibit(page: PePdfPageArtifact): string {
  return page.text.split(/\r?\n/u).find((line) => (
    /^(?:(?:图|表)\s*\d+|(?:Exhibit|Figure|Table)\s*\d+)/iu.test(line.trim())
  ))?.trim() ?? "";
}

export function renderPePdfMarkdown(
  originalFilename: string,
  metadata: PePdfDocumentMetadata,
  pages: PePdfPageArtifact[],
): string {
  const sections = pages.map((page) => {
    const header = [
      originalFilename,
      metadata.brokerage,
      metadata.documentDate,
      `p.${page.pageNumber}/${pages.length}`,
      pageExhibit(page),
    ].filter(Boolean).join(" · ");
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
