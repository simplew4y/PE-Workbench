import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDocument,
  PasswordException,
  Util,
  version as pdfJsVersion,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  TextItem,
  TextMarkedContent,
} from "pdfjs-dist/types/src/display/api.js";
import {
  PE_MAX_PDF_PAGES,
  PE_PDF_PARSER_NAME,
  PE_PDF_PARSER_VERSION,
  type PeParsedPdfDocument,
  type PePdfPageArtifact,
  type PePdfTextToken,
} from "../contracts.ts";
import { pePdfDocumentName, registeredPePdfArtifactPaths, sha256, stablePeId } from "../paths.ts";
import { buildPePdfLayout } from "./layout.ts";
import { pePdfPageHeader, renderPePdfLayoutJson, renderPePdfMarkdown } from "./markdown.ts";
import { extractPePdfMetadata } from "./metadata.ts";
import { evaluatePePdfTextQuality } from "./quality.ts";
import { renderPePdfPage } from "./renderer.ts";
import { classifyPePdfPageRole } from "./roles.ts";

export interface ProcessPePdfOptions {
  datasetId: string;
  originalFilename: string;
  rawPath: string;
  rawAbsolutePath: string;
  sha256: string;
  stagingDocumentDirectory: string;
  registeredDocument?: { docId: string; generation: string };
}

function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
  return "str" in item;
}

function numericTransform(transform: unknown[]): number[] {
  return transform.map((value) => typeof value === "number" ? value : 0);
}

function textTokens(page: PDFPageProxy, items: Array<TextItem | TextMarkedContent>): PePdfTextToken[] {
  const viewport = page.getViewport({ scale: 1 });
  return items.filter(isTextItem).map((item) => {
    const transformed = Util.transform(viewport.transform, numericTransform(item.transform));
    const fontHeight = Math.max(1, Math.hypot(transformed[2], transformed[3]) || item.height);
    return {
      text: item.str,
      x: transformed[4],
      y: transformed[5] - fontHeight,
      width: Math.max(0, item.width),
      height: fontHeight,
      fontName: item.fontName,
      direction: item.dir,
      hasEol: item.hasEOL,
    };
  });
}

function pdfJsRoot(): string {
  return path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
}

interface OpenPePdfResult {
  document: PDFDocumentProxy;
  loadingTask: PDFDocumentLoadingTask;
}

async function openPdf(content: Buffer): Promise<OpenPePdfResult> {
  const dependencyRoot = pdfJsRoot();
  const task = getDocument({
    data: new Uint8Array(content),
    // PDF.js's NodeBinaryDataFactory calls fs.readFile with these strings,
    // so local resources require filesystem paths rather than file:// URLs.
    cMapUrl: `${path.join(dependencyRoot, "cmaps")}${path.sep}`,
    cMapPacked: true,
    standardFontDataUrl: `${path.join(dependencyRoot, "standard_fonts")}${path.sep}`,
    wasmUrl: `${path.join(dependencyRoot, "wasm")}${path.sep}`,
    useSystemFonts: true,
    // Recover usable text and page images when optional or hidden PDF objects
    // contain malformed font references. Page quality checks still flag weak text.
    stopAtErrors: false,
  });
  try {
    return {
      document: await task.promise,
      loadingTask: task,
    };
  } catch (error) {
    if (error instanceof PasswordException) throw new Error("Encrypted PDF is not supported");
    throw error;
  }
}

export async function processPePdf(options: ProcessPePdfOptions): Promise<PeParsedPdfDocument> {
  const content = readFileSync(options.rawAbsolutePath);
  if (sha256(content) !== options.sha256) throw new Error("Raw PDF content changed after upload");
  if (content.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Invalid PDF file header");
  }
  const { document, loadingTask } = await openPdf(content);
  try {
    if (document.numPages > PE_MAX_PDF_PAGES) {
      throw new Error(`PDF exceeds the ${PE_MAX_PDF_PAGES}-page limit`);
    }
    if (document.numPages < 1) throw new Error("PDF contains no pages");
    mkdirSync(options.stagingDocumentDirectory, { recursive: true });
    const pagesDirectory = path.join(options.stagingDocumentDirectory, "pages");
    mkdirSync(pagesDirectory);
    const docId = options.registeredDocument?.docId ?? stablePeId("doc", options.datasetId, options.sha256);
    const documentName = options.registeredDocument ? "" : pePdfDocumentName(options.originalFilename);
    const pages: PePdfPageArtifact[] = [];
    const warnings: string[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const pageId = stablePeId("page", docId, String(pageNumber));
        const textContent = await page.getTextContent({ disableNormalization: false });
        const layout = buildPePdfLayout(
          pageId,
          textTokens(page, textContent.items),
          viewport.width,
          viewport.height,
        );
        const rendered = await renderPePdfPage(page, pagesDirectory, pageNumber);
        const quality = evaluatePePdfTextQuality(layout.text);
        const role = classifyPePdfPageRole(
          pageNumber,
          document.numPages,
          layout.text,
          layout.blocks,
          rendered.statistics,
        );
        if (quality.quality === "needs_ocr") {
          warnings.push(`第 ${pageNumber} 页文字质量不足，已标记 needs_ocr。`);
        }
        pages.push({
          pageId,
          pageNumber,
          role: role.role,
          roleSignals: role.signals,
          width: viewport.width,
          height: viewport.height,
          rotation: page.rotate,
          text: layout.text,
          pageHeader: "",
          textQuality: quality.quality,
          qualitySignals: quality.signals,
          imagePaths: rendered.imagePaths,
          imageStatistics: rendered.statistics,
          blocks: layout.blocks,
        });
      } finally {
        page.cleanup();
      }
    }

    const rawMetadata = await document.getMetadata().then((value) => value.info).catch(() => ({}));
    const metadata = extractPePdfMetadata(
      options.originalFilename,
      rawMetadata,
      pages[0]?.text ?? "",
      pages.map((page) => page.text),
      pages[0]?.blocks ?? [],
    );
    for (const page of pages) {
      page.pageHeader = pePdfPageHeader(
        options.originalFilename,
        metadata,
        page,
        pages.length,
      );
    }

    const { artifactDirectory, documentMarkdownPath, layoutJsonPath } = options.registeredDocument
      ? registeredPePdfArtifactPaths(docId, options.registeredDocument.generation)
      : {
        artifactDirectory: `meta/documents/${documentName}`,
        documentMarkdownPath: `meta/text/${documentName}.md`,
        layoutJsonPath: `meta/documents/${documentName}/layout.json`,
      };
    writeFileSync(
      path.join(options.stagingDocumentDirectory, "document.md"),
      renderPePdfMarkdown(options.originalFilename, metadata, pages),
      "utf8",
    );
    writeFileSync(
      path.join(options.stagingDocumentDirectory, "layout.json"),
      renderPePdfLayoutJson({
        docId,
        datasetId: options.datasetId,
        originalFilename: options.originalFilename,
        sha256: options.sha256,
        metadata,
      }, pages),
      "utf8",
    );

    return {
      docId,
      datasetId: options.datasetId,
      originalFilename: options.originalFilename,
      rawPath: options.rawPath,
      sha256: options.sha256,
      parserName: PE_PDF_PARSER_NAME,
      parserVersion: pdfJsVersion || PE_PDF_PARSER_VERSION,
      metadata,
      pages: pages.map((page) => ({
        ...page,
        imagePaths: page.imagePaths.map((imagePath) => `${artifactDirectory}/${imagePath}`),
      })),
      artifactDirectory,
      documentMarkdownPath,
      layoutJsonPath,
      warnings,
      ...(options.registeredDocument ? {
        registrationKind: "catalog" as const,
        artifactGeneration: options.registeredDocument.generation,
      } : {}),
    };
  } finally {
    await loadingTask.destroy();
  }
}
