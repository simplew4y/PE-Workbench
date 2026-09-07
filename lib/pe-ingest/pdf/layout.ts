import type { PePdfBlock, PePdfBlockType, PePdfLine, PePdfTextToken } from "../contracts.ts";
import { stablePeId } from "../paths.ts";

interface WorkingLine {
  tokens: PePdfTextToken[];
  centerY: number;
}

type LineGeometry = Omit<PePdfLine, "columnNo" | "readingOrder">;

/** A run of tokens on one physical line with no large horizontal gap inside it. */
interface Segment extends LineGeometry {
  tokens: PePdfTextToken[];
  physicalLine: number;
}

interface Gutter {
  start: number;
  end: number;
}

interface VerticalRange {
  top: number;
  bottom: number;
}

export interface PePdfLayoutResult {
  text: string;
  blocks: PePdfBlock[];
  lines: PePdfLine[];
  twoColumn: boolean;
}

/**
 * Segments at least this long, or this wide relative to the page, vote for column boundaries.
 * Numeric table cells and short labels do not, so tables are not mistaken for columns.
 */
const PROSE_MIN_CHARS = 20;
const PROSE_MIN_WIDTH_RATIO = 0.12;
/** Segments on each side of a gutter needed before a page counts as two-column. */
const MIN_COLUMN_SEGMENTS = 3;
/** Each line spanning the gutter inside the column region costs this many column votes. */
const SPANNING_LINE_PENALTY = 3;
/**
 * Full-width content bounds the column region: a table row whose cells span this share of the
 * page, or one prose segment this wide. Prose in a wide main column beside a sidebar can reach
 * about three quarters of the page, so single segments need the higher bar.
 */
const WIDE_TABLE_ROW_RATIO = 0.6;
const WIDE_PROSE_RATIO = 0.8;
/** A line crossing the gutter still belongs to one column when this share of it lies there. */
const COLUMN_MAJORITY_RATIO = 0.8;

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

function lineFromTokens(tokens: PePdfTextToken[]): LineGeometry {
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

function splitTokensAtGaps(tokens: PePdfTextToken[], maxGap: number): PePdfTextToken[][] {
  const ordered = [...tokens].sort((left, right) => left.x - right.x);
  const groups: PePdfTextToken[][] = [];
  let groupRight = Number.NEGATIVE_INFINITY;
  for (const token of ordered) {
    const current = groups.at(-1);
    if (current && token.x - groupRight <= maxGap) {
      current.push(token);
    } else {
      groups.push([token]);
    }
    groupRight = Math.max(groupRight, token.x + token.width);
  }
  return groups;
}

function physicalLines(tokens: PePdfTextToken[], typicalHeight: number): WorkingLine[] {
  const tolerance = Math.max(1.75, typicalHeight * 0.45);
  const ordered = [...tokens].sort((left, right) => (
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
  return working;
}

function verticalRange(segments: LineGeometry[]): VerticalRange {
  return {
    top: Math.min(...segments.map((segment) => segment.y)),
    bottom: Math.max(...segments.map((segment) => segment.y + segment.height)),
  };
}

function isNumericText(text: string): boolean {
  const characters = [...text.replace(/\s+/gu, "")];
  if (characters.length === 0) return false;
  const numeric = characters.filter((character) => /[\d%.,()\-–]/u.test(character)).length;
  return numeric / characters.length >= 0.5;
}

/**
 * Full-width content: a single prose segment spanning most of the page, or a table row whose
 * numeric cells together span it. Columns are only searched between such lines, so a table or
 * paragraph above two side-by-side exhibits neither blocks nor gets shredded by the gutter.
 */
function wideLineRanges(segments: Segment[], pageWidth: number): VerticalRange[] {
  const ranges: VerticalRange[] = [];
  const byLine = new Map<number, Segment[]>();
  for (const segment of segments) {
    const group = byLine.get(segment.physicalLine) ?? [];
    group.push(segment);
    byLine.set(segment.physicalLine, group);
  }
  for (const group of byLine.values()) {
    // A prose line beside a sidebar shares its physical line with the sidebar's numbers;
    // only the short labels and numeric cells form the candidate table row.
    const cells = group.filter((segment) => isNumericText(segment.text) || segment.text.length < PROSE_MIN_CHARS);
    const numericCells = cells.filter((segment) => isNumericText(segment.text));
    const isTableRow = cells.length >= 3 && numericCells.length / cells.length >= 0.6;
    const units = isTableRow ? [cells] : group.map((segment) => [segment]);
    const minimumWidth = pageWidth * (isTableRow ? WIDE_TABLE_ROW_RATIO : WIDE_PROSE_RATIO);
    for (const unit of units) {
      const left = Math.min(...unit.map((segment) => segment.x));
      const right = Math.max(...unit.map((segment) => segment.x + segment.width));
      if (right - left >= minimumWidth) ranges.push(verticalRange(unit));
    }
  }
  return ranges.sort((left, right) => left.top - right.top);
}

/** The tallest vertical span free of full-width lines, where columns may exist. */
function columnSearchRegion(segments: Segment[], pageWidth: number, pageHeight: number): VerticalRange {
  const ranges = wideLineRanges(segments, pageWidth);
  if (ranges.length === 0) return { top: 0, bottom: pageHeight };
  const candidates: VerticalRange[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.top > cursor) candidates.push({ top: cursor, bottom: range.top });
    cursor = Math.max(cursor, range.bottom);
  }
  candidates.push({ top: cursor, bottom: pageHeight });
  return candidates.reduce((best, candidate) => (
    candidate.bottom - candidate.top > best.bottom - best.top ? candidate : best
  ));
}

function insideRegion(line: LineGeometry, region: VerticalRange): boolean {
  const centerY = line.y + line.height / 2;
  return centerY >= region.top && centerY <= region.bottom;
}

/**
 * Find a vertical gutter separating two text columns inside the search region. Candidate
 * positions are scored by how many prose segments lie completely on each side, minus a penalty
 * for lines that span the gutter where both columns overlap vertically. Sidebars narrower than
 * the main column (report covers) and equal two-column bodies both produce one dominant gutter,
 * while tables do not because their cells are short and their label column has no prose beside it.
 */
function detectGutter(segments: Segment[], pageWidth: number, pageHeight: number): Gutter | null {
  const region = segments.filter((segment) => segment.y > pageHeight * 0.04 && segment.y < pageHeight * 0.94);
  const prose = region.filter((segment) => (
    !isNumericText(segment.text)
    && (segment.text.length >= PROSE_MIN_CHARS || segment.width >= pageWidth * PROSE_MIN_WIDTH_RATIO)
  ));
  if (prose.length < MIN_COLUMN_SEGMENTS * 2) return null;
  const typicalHeight = Math.max(1, median(prose.map((segment) => segment.height)));
  const from = Math.floor(pageWidth * 0.2);
  const to = Math.ceil(pageWidth * 0.8);
  const runs: Array<{ start: number; end: number; score: number }> = [];
  let runStart = -1;
  let runScore = Number.NEGATIVE_INFINITY;

  const closeRun = (end: number): void => {
    if (runStart >= 0) runs.push({ start: runStart, end, score: runScore });
    runStart = -1;
  };

  for (let x = from; x <= to; x += 1) {
    const left = prose.filter((segment) => segment.x + segment.width <= x);
    const right = prose.filter((segment) => segment.x >= x);
    let score = Number.NEGATIVE_INFINITY;
    if (left.length >= MIN_COLUMN_SEGMENTS && right.length >= MIN_COLUMN_SEGMENTS) {
      const leftRange = verticalRange(left);
      const rightRange = verticalRange(right);
      const top = Math.max(leftRange.top, rightRange.top);
      const bottom = Math.min(leftRange.bottom, rightRange.bottom);
      const overlap = bottom - top;
      const columnSpan = Math.min(leftRange.bottom - leftRange.top, rightRange.bottom - rightRange.top);
      if (overlap >= Math.max(typicalHeight * 3, columnSpan * 0.45)) {
        const spanning = region.filter((segment) => (
          segment.x < x && segment.x + segment.width > x
          && segment.y + segment.height > top && segment.y < bottom
        ));
        score = Math.min(left.length, right.length) - SPANNING_LINE_PENALTY * spanning.length;
      }
    }
    if (score < MIN_COLUMN_SEGMENTS) {
      closeRun(x - 1);
      continue;
    }
    if (runStart >= 0 && score !== runScore) closeRun(x - 1);
    if (runStart < 0) {
      runStart = x;
      runScore = score;
    }
  }
  closeRun(to);
  let best: { start: number; end: number; score: number } | null = null;
  for (const run of runs) {
    if (!best || run.score > best.score || (run.score === best.score && run.end - run.start > best.end - best.start)) {
      best = run;
    }
  }
  return best ? { start: best.start, end: best.end } : null;
}

function mergeSegments(
  segments: Segment[],
  mergeGap: number,
  gutter: Gutter | null,
  region: VerticalRange,
): LineGeometry[] {
  const merged: LineGeometry[] = [];
  const byLine = new Map<number, Segment[]>();
  for (const segment of segments) {
    const group = byLine.get(segment.physicalLine) ?? [];
    group.push(segment);
    byLine.set(segment.physicalLine, group);
  }
  for (const group of byLine.values()) {
    const ordered = [...group].sort((left, right) => left.x - right.x);
    const guarded = gutter !== null && ordered.some((segment) => insideRegion(segment, region));
    let current: PePdfTextToken[] = [];
    let currentRight = Number.NEGATIVE_INFINITY;
    for (const segment of ordered) {
      const gap = segment.x - currentRight;
      const crossesGutter = guarded && gutter !== null && currentRight <= gutter.end && segment.x >= gutter.start;
      if (current.length > 0 && gap <= mergeGap && !crossesGutter) {
        current.push(...segment.tokens);
      } else {
        if (current.length > 0) merged.push(lineFromTokens(current));
        current = [...segment.tokens];
      }
      currentRight = Math.max(currentRight, segment.x + segment.width);
    }
    if (current.length > 0) merged.push(lineFromTokens(current));
  }
  return merged.filter((line) => line.text);
}

function columnOf(line: LineGeometry, gutter: Gutter): 0 | 1 | 2 {
  const right = line.x + line.width;
  if (right <= gutter.end) return 1;
  if (line.x >= gutter.start) return 2;
  const width = Math.max(1, line.width);
  if ((gutter.start - line.x) / width >= COLUMN_MAJORITY_RATIO) return 1;
  if ((right - gutter.end) / width >= COLUMN_MAJORITY_RATIO) return 2;
  return 0;
}

function orderLines(
  lines: LineGeometry[],
  gutter: Gutter | null,
  region: VerticalRange,
): { lines: PePdfLine[]; twoColumn: boolean } {
  const byPosition = [...lines].sort((left, right) => left.y - right.y || left.x - right.x);
  if (!gutter) {
    return {
      twoColumn: false,
      lines: byPosition.map((line, index) => ({ ...line, columnNo: 0, readingOrder: index })),
    };
  }
  const above = byPosition.filter((line) => line.y + line.height / 2 < region.top);
  const below = byPosition.filter((line) => line.y + line.height / 2 > region.bottom);
  const classified = byPosition
    .filter((line) => insideRegion(line, region))
    .map((line) => ({ ...line, columnNo: columnOf(line, gutter) }));
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
  const ordered = [
    ...above.map((line) => ({ ...line, columnNo: 0 as const })),
    ...prefix,
    ...left,
    ...right,
    ...middle,
    ...suffix,
    ...below.map((line) => ({ ...line, columnNo: 0 as const })),
  ];
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
  const visible = tokens.filter((token) => normalizedTokenText(token.text));
  const typicalTokenHeight = Math.max(4, median(visible.map((token) => token.height).filter((height) => height > 0)));
  // Word gaps in justified prose stay well under 1.5 line heights; wider gaps separate
  // table cells or neighbouring columns and are only rejoined when no gutter lies between them.
  const segmentGap = Math.max(12, typicalTokenHeight * 1.5);
  // Table label cells sit up to about an eighth of the page from their first value column.
  const mergeGap = Math.max(48, pageWidth * 0.12);
  const segments: Segment[] = physicalLines(visible, typicalTokenHeight).flatMap((line, physicalLine) => (
    splitTokensAtGaps(line.tokens, segmentGap)
      .map((group) => ({ ...lineFromTokens(group), tokens: group, physicalLine }))
      .filter((segment) => segment.text)
  ));
  const region = columnSearchRegion(segments, pageWidth, pageHeight);
  const gutter = detectGutter(segments.filter((segment) => insideRegion(segment, region)), pageWidth, pageHeight);
  const ordered = orderLines(mergeSegments(segments, mergeGap, gutter, region), gutter, region);
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
