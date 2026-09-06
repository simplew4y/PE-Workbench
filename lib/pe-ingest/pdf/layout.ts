import type { PePdfBlock, PePdfBlockType, PePdfLine, PePdfTextToken } from "../contracts.ts";
import { stablePeId } from "../paths.ts";

interface WorkingLine {
  tokens: PePdfTextToken[];
  centerY: number;
}

export interface PePdfLayoutResult {
  text: string;
  blocks: PePdfBlock[];
  lines: PePdfLine[];
  twoColumn: boolean;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function normalizedTokenText(value: string): string {
  return value.replace(/[\t\r\n ]+/gu, " ").trim();
}

function lineFromTokens(tokens: PePdfTextToken[]): Omit<PePdfLine, "columnNo" | "readingOrder"> {
  const ordered = [...tokens].sort((left, right) => left.x - right.x);
  const textParts: string[] = [];
  let previousRight = 0;
  let previousHeight = 0;
  for (const token of ordered) {
    const text = normalizedTokenText(token.text);
    if (!text) continue;
    if (textParts.length > 0) {
      const gap = token.x - previousRight;
      const threshold = Math.max(1.5, Math.min(previousHeight, token.height) * 0.16);
      if (gap > threshold && !textParts.at(-1)?.endsWith(" ")) textParts.push(" ");
    }
    textParts.push(text);
    previousRight = Math.max(previousRight, token.x + token.width);
    previousHeight = token.height;
  }
  const x = Math.min(...ordered.map((token) => token.x));
  const y = Math.min(...ordered.map((token) => token.y));
  const right = Math.max(...ordered.map((token) => token.x + token.width));
  const bottom = Math.max(...ordered.map((token) => token.y + token.height));
  return {
    text: textParts.join(""),
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
    fontNames: [...new Set(ordered.map((token) => token.fontName).filter(Boolean))],
    directions: [...new Set(ordered.map((token) => token.direction).filter(Boolean))],
  };
}

function splitLineTokens(tokens: PePdfTextToken[], pageWidth: number): PePdfTextToken[][] {
  const ordered = [...tokens].sort((left, right) => left.x - right.x);
  const groups: PePdfTextToken[][] = [];
  for (const token of ordered) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    if (current && previous && token.x - (previous.x + previous.width) <= Math.max(36, pageWidth * 0.1)) {
      current.push(token);
    } else {
      groups.push([token]);
    }
  }
  return groups;
}

function groupLines(
  tokens: PePdfTextToken[],
  pageWidth: number,
): Array<Omit<PePdfLine, "columnNo" | "readingOrder">> {
  const visible = tokens.filter((token) => normalizedTokenText(token.text));
  if (visible.length === 0) return [];
  const typicalHeight = Math.max(4, median(visible.map((token) => token.height).filter((height) => height > 0)));
  const tolerance = Math.max(1.75, typicalHeight * 0.45);
  const ordered = [...visible].sort((left, right) => (
    (left.y + left.height / 2) - (right.y + right.height / 2) || left.x - right.x
  ));
  const working: WorkingLine[] = [];

  for (const token of ordered) {
    const centerY = token.y + token.height / 2;
    const current = working.at(-1);
    if (current && Math.abs(current.centerY - centerY) <= tolerance) {
      current.tokens.push(token);
      current.centerY = current.tokens.reduce(
        (sum, item) => sum + item.y + item.height / 2,
        0,
      ) / current.tokens.length;
    } else {
      working.push({ tokens: [token], centerY });
    }
  }
  return working
    .flatMap((line) => splitLineTokens(line.tokens, pageWidth))
    .map((line) => lineFromTokens(line))
    .filter((line) => line.text);
}

function hasTwoColumns(
  lines: Array<Omit<PePdfLine, "columnNo" | "readingOrder">>,
  pageWidth: number,
  pageHeight: number,
): boolean {
  const midpoint = pageWidth / 2;
  const gutterTolerance = pageWidth * 0.035;
  const candidates = lines.filter((line) => (
    line.text.length >= 4
    && line.width <= pageWidth * 0.6
    && line.y > pageHeight * 0.04
    && line.y < pageHeight * 0.94
  ));
  const left = candidates.filter((line) => line.x < midpoint && line.x + line.width <= midpoint + gutterTolerance);
  const right = candidates.filter((line) => line.x >= midpoint - gutterTolerance);
  if (left.length < 3 || right.length < 3) return false;
  const leftTop = Math.min(...left.map((line) => line.y));
  const leftBottom = Math.max(...left.map((line) => line.y + line.height));
  const rightTop = Math.min(...right.map((line) => line.y));
  const rightBottom = Math.max(...right.map((line) => line.y + line.height));
  const overlap = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop);
  const columnSpan = Math.min(leftBottom - leftTop, rightBottom - rightTop);
  const typicalHeight = median(candidates.map((line) => line.height));
  return overlap >= Math.max(typicalHeight * 3, columnSpan * 0.45);
}

function orderLines(
  lines: Array<Omit<PePdfLine, "columnNo" | "readingOrder">>,
  pageWidth: number,
  pageHeight: number,
): { lines: PePdfLine[]; twoColumn: boolean } {
  const byPosition = [...lines].sort((left, right) => left.y - right.y || left.x - right.x);
  if (!hasTwoColumns(byPosition, pageWidth, pageHeight)) {
    return {
      twoColumn: false,
      lines: byPosition.map((line, index) => ({ ...line, columnNo: 0, readingOrder: index })),
    };
  }

  const midpoint = pageWidth / 2;
  const gutterTolerance = pageWidth * 0.035;
  const classified = byPosition.map((line) => {
    let columnNo: 0 | 1 | 2 = 0;
    if (line.width <= pageWidth * 0.68) {
      if (line.x + line.width <= midpoint + gutterTolerance) columnNo = 1;
      else if (line.x >= midpoint - gutterTolerance) columnNo = 2;
    }
    return { ...line, columnNo };
  });
  const columnLines = classified.filter((line) => line.columnNo !== 0);
  const columnTop = Math.min(...columnLines.map((line) => line.y));
  const columnBottom = Math.max(...columnLines.map((line) => line.y + line.height));
  const prefix = classified.filter((line) => line.columnNo === 0 && line.y + line.height <= columnTop);
  const suffix = classified.filter((line) => line.columnNo === 0 && line.y >= columnBottom);
  const middle = classified.filter((line) => (
    line.columnNo === 0 && !prefix.includes(line) && !suffix.includes(line)
  ));
  const left = classified.filter((line) => line.columnNo === 1);
  const right = classified.filter((line) => line.columnNo === 2);
  const ordered = [...prefix, ...left, ...right, ...middle, ...suffix];
  return {
    twoColumn: true,
    lines: ordered.map((line, index) => ({ ...line, readingOrder: index })),
  };
}

function blockType(line: PePdfLine, typicalHeight: number): PePdfBlockType {
  if (/^(?:主持人|分析师|研究员|管理层|公司管理层|发言人|问|答|Q|A)[：:]/iu.test(line.text)) {
    return "speaker";
  }
  const digits = [...line.text].filter((character) => /[\d%¥￥$€.,]/u.test(character)).length;
  if (line.text.length >= 6 && digits / line.text.length >= 0.28) return "table_row";
  if (line.height >= typicalHeight * 1.28 && line.text.length <= 80) return "heading";
  return "body";
}

export function buildPePdfLayout(
  pageId: string,
  tokens: PePdfTextToken[],
  pageWidth: number,
  pageHeight: number,
): PePdfLayoutResult {
  const grouped = groupLines(tokens, pageWidth);
  const ordered = orderLines(grouped, pageWidth, pageHeight);
  const typicalHeight = Math.max(1, median(ordered.lines.map((line) => line.height)));
  const blocks = ordered.lines.map((line, index): PePdfBlock => ({
    blockId: stablePeId("block", pageId, String(index), line.text),
    blockIndex: index,
    blockType: blockType(line, typicalHeight),
    text: line.text,
    x: line.x,
    y: line.y,
    width: line.width,
    height: line.height,
    readingOrder: line.readingOrder,
    columnNo: line.columnNo,
    fontNames: line.fontNames,
    directions: line.directions,
  }));
  return {
    text: blocks.map((block) => block.text).join("\n"),
    blocks,
    lines: ordered.lines,
    twoColumn: ordered.twoColumn,
  };
}
