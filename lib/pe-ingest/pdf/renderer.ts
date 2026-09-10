import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFOperatorList, PDFPageProxy } from "pdfjs-dist/types/src/display/api.js";
import type { PePdfImageStatistics } from "../contracts.ts";

export interface PePdfRenderResult {
  imagePaths: string[];
  statistics: PePdfImageStatistics;
}

const IMAGE_OPERATORS = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat,
]);

const DRAWING_OPERATORS = new Set<number>([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
  OPS.shadingFill,
  OPS.constructPath,
  OPS.rawFillPath,
]);

function imageDimensions(value: unknown): { width: number; height: number } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { width?: unknown; height?: unknown };
  return typeof candidate.width === "number" && typeof candidate.height === "number"
    ? { width: candidate.width, height: candidate.height }
    : null;
}

function resolvedImageDimensions(page: PDFPageProxy, args: unknown): { width: number; height: number } | null {
  if (!Array.isArray(args) || args.length === 0) return null;
  const inline = imageDimensions(args[0]);
  if (inline) return inline;
  const objectId = typeof args[0] === "string" ? args[0] : "";
  if (!objectId) return null;
  for (const objects of [page.objs, page.commonObjs]) {
    try {
      if (!objects.has(objectId)) continue;
      const resolved: unknown = objects.get(objectId);
      const dimensions = imageDimensions(resolved);
      if (dimensions) return dimensions;
    } catch {
      // Some lazily decoded images are unavailable for inspection after render.
    }
  }
  return null;
}

function inspectOperators(page: PDFPageProxy, operatorList: PDFOperatorList): PePdfImageStatistics {
  let embeddedImageCount = 0;
  let largeEmbeddedImageCount = 0;
  let drawingOperatorCount = 0;
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operator = operatorList.fnArray[index];
    if (DRAWING_OPERATORS.has(operator)) drawingOperatorCount += 1;
    if (!IMAGE_OPERATORS.has(operator)) continue;
    embeddedImageCount += 1;
    const dimensions = resolvedImageDimensions(page, operatorList.argsArray[index] as unknown);
    if (dimensions && dimensions.width > 500) largeEmbeddedImageCount += 1;
  }
  return { embeddedImageCount, largeEmbeddedImageCount, drawingOperatorCount };
}

async function renderAtDpi(page: PDFPageProxy, target: string, dpi: number): Promise<void> {
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    viewport,
    background: "rgb(255,255,255)",
    recordImages: true,
  }).promise;
  writeFileSync(target, canvas.toBuffer("image/png"));
}

export async function renderPePdfPage(
  page: PDFPageProxy,
  pagesDirectory: string,
  pageNumber: number,
): Promise<PePdfRenderResult> {
  mkdirSync(pagesDirectory, { recursive: true });
  const pageLabel = String(pageNumber).padStart(4, "0");
  const standardName = `page-${pageLabel}@110.png`;
  await renderAtDpi(page, path.join(pagesDirectory, standardName), 110);
  const operatorList = await page.getOperatorList();
  const statistics = inspectOperators(page, operatorList);
  const imagePaths = [`pages/${standardName}`];
  if (statistics.largeEmbeddedImageCount > 0) {
    const detailedName = `page-${pageLabel}@200.png`;
    await renderAtDpi(page, path.join(pagesDirectory, detailedName), 200);
    imagePaths.push(`pages/${detailedName}`);
  }
  return { imagePaths, statistics };
}
