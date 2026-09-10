import path from "node:path";
import type { PePdfDocumentMetadata } from "../contracts.ts";
import { EXHIBIT_CAPTION_PATTERN } from "./roles.ts";

export interface PePdfTitleCandidate {
  text: string;
  height: number;
  /** Left edge; a second title line must start at the same edge to be joined. */
  x?: number;
}

/** Sell-side firms whose reports carry the name in text, e-mail domains, or file names. */
const KNOWN_BROKERAGES: Array<{ name: string; pattern: RegExp }> = [
  { name: "Bernstein", pattern: /\bbernstein\b|伯恩斯坦/iu },
  { name: "UBS", pattern: /\bubs\b|瑞银/iu },
  { name: "Goldman Sachs", pattern: /goldman\s*sachs|高盛/iu },
  { name: "Morgan Stanley", pattern: /morgan\s*stanley|摩根士丹利|大摩/iu },
  { name: "J.P. Morgan", pattern: /j\.?\s?p\.?\s?morgan|摩根大通|小摩/iu },
  { name: "Jefferies", pattern: /\bjefferies\b|杰富瑞/iu },
  { name: "Barclays", pattern: /\bbarclays\b|巴克莱/iu },
  { name: "HSBC", pattern: /\bhsbc\b|汇丰/iu },
  { name: "Citi", pattern: /\bciti(?:group|bank)?\b|花旗/iu },
  { name: "BofA Securities", pattern: /\bbofa\b|bank of america|美银/iu },
  { name: "Deutsche Bank", pattern: /deutsche\s*bank|德意志银行|德银/iu },
  { name: "Credit Suisse", pattern: /credit\s*suisse|瑞信/iu },
  { name: "Nomura", pattern: /\bnomura\b|野村/iu },
  { name: "Macquarie", pattern: /\bmacquarie\b|麦格理/iu },
  { name: "CLSA", pattern: /\bclsa\b|里昂证券/iu },
  { name: "Daiwa", pattern: /\bdaiwa\b|大和证券/iu },
  { name: "Mizuho", pattern: /\bmizuho\b|瑞穗/iu },
  { name: "BNP Paribas", pattern: /bnp\s*paribas|法国巴黎银行/iu },
  { name: "Exane", pattern: /\bexane\b/iu },
  { name: "Berenberg", pattern: /\bberenberg\b/iu },
  { name: "Kepler Cheuvreux", pattern: /kepler\s*cheuvreux/iu },
  { name: "Redburn Atlantic", pattern: /\bredburn\b/iu },
  { name: "Evercore ISI", pattern: /\bevercore\b/iu },
  { name: "Wells Fargo", pattern: /wells\s*fargo|富国银行/iu },
  { name: "RBC Capital Markets", pattern: /\brbc\b/iu },
  { name: "TD Cowen", pattern: /\bcowen\b/iu },
  { name: "Stifel", pattern: /\bstifel\b/iu },
  { name: "Baird", pattern: /\bbaird\b/iu },
  { name: "Piper Sandler", pattern: /piper\s*sandler/iu },
  { name: "Raymond James", pattern: /raymond\s*james/iu },
  { name: "Wolfe Research", pattern: /wolfe\s*research/iu },
  { name: "CICC", pattern: /\bcicc\b|中金公司|中国国际金融/iu },
  { name: "CITIC Securities", pattern: /citic\s*securities|中信证券/iu },
  { name: "Huatai Securities", pattern: /huatai/iu },
];

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

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(year: string, month: number, day: number): string {
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return "";
  const candidate = new Date(Date.UTC(Number(year), month - 1, day));
  if (
    candidate.getUTCFullYear() !== Number(year)
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthNumber(name: string): number {
  return MONTHS[name.slice(0, 4).toLowerCase()] ?? MONTHS[name.slice(0, 3).toLowerCase()] ?? 0;
}

const DATE_FORMATS: Array<{ pattern: RegExp; toIso: (match: RegExpMatchArray) => string }> = [
  {
    pattern: /(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?/gu,
    toIso: (match) => isoDate(match[1], Number(match[2]), Number(match[3])),
  },
  {
    pattern: /\b(\d{1,2})(?:st|nd|rd|th)?[ \-]([A-Za-z]{3,9})\.?,?[ \-](20\d{2})\b/gu,
    toIso: (match) => isoDate(match[3], monthNumber(match[2]), Number(match[1])),
  },
  {
    pattern: /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/gu,
    toIso: (match) => isoDate(match[3], monthNumber(match[1]), Number(match[2])),
  },
  {
    pattern: /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/gu,
    toIso: (match) => isoDate(match[1], Number(match[2]), Number(match[3])),
  },
];

const PUBLICATION_LABEL = /(?:first published|published|publication date|report date|date of (?:this )?report|发布日期|报告日期|发布时间|日期)\s*[:：]?\s*$/iu;
/** Dates describing a price snapshot or completion time rather than the report itself. */
const SNAPSHOT_LABEL = /(?:\bon|as of|as at|close|closing|completion|priced|price|截至|收盘|数据截止)\s*(?:date)?\s*[:：(（]?\s*$/iu;

/** Normalize one date string in numeric, Chinese, English, or PDF `D:` form. */
export function normalizePePdfDate(value: string): string {
  const compact = /^D:(20\d{2})(\d{2})(\d{2})/u.exec(value.trim());
  if (compact) return isoDate(compact[1], Number(compact[2]), Number(compact[3]));
  for (const { pattern, toIso } of DATE_FORMATS) {
    for (const match of value.matchAll(pattern)) {
      const iso = toIso(match);
      if (iso) return iso;
    }
  }
  return "";
}

/**
 * Pick the report date from cover text: a labelled publication date wins, otherwise the most
 * frequently repeated date, so close-price and completion dates do not displace the report date.
 */
function coverDate(firstPageText: string): string {
  const occurrences: Array<{ iso: string; index: number; weight: number }> = [];
  for (const { pattern, toIso } of DATE_FORMATS) {
    for (const match of firstPageText.matchAll(pattern)) {
      const iso = toIso(match);
      if (!iso) continue;
      const index = match.index ?? 0;
      const prefix = firstPageText.slice(Math.max(0, index - 40), index);
      const weight = PUBLICATION_LABEL.test(prefix) ? 3 : SNAPSHOT_LABEL.test(prefix) ? 0.25 : 1;
      occurrences.push({ iso, index, weight });
    }
  }
  const scores = new Map<string, { score: number; index: number }>();
  for (const item of occurrences) {
    const existing = scores.get(item.iso);
    if (existing) existing.score += item.weight;
    else scores.set(item.iso, { score: item.weight, index: item.index });
  }
  return [...scores.entries()]
    .sort((left, right) => right[1].score - left[1].score || left[1].index - right[1].index)[0]?.[0] ?? "";
}

const TITLE_EXCLUSION = /^(?:source|rating|price target|target price|valuation|close|note|ticker|highlights|analyst|tel|email|date|ric|bbg|figure|exhibit|table|chart|equities|global research|research report|证券研究报告|图|表|图表|评级|目标价|来源|资料来源|数据来源|分析师|联系人|电话|邮箱|日期|仅供机构投资者)(?=[\s:：\d(（]|$)|[@]|https?:|www\./iu;

function isTitleCandidate(line: string): boolean {
  return line.length >= 6 && line.length <= 120
    && !/^\d{4}[年./-]/u.test(line)
    && !/^[\d\s.,%()€$£¥￥-]+$/u.test(line)
    && !TITLE_EXCLUSION.test(line);
}

function isHeadlineShaped(line: string): boolean {
  return /^[^:：]{2,60}[:：]\s*\S.{3,}$/u.test(line) || /[?？]$/u.test(line);
}

/**
 * Title precedence: PDF metadata, the tallest heading on the cover (joined with an adjacent
 * line of the same size), then a "Company: headline" line, then the first plausible line.
 */
function inferredTitle(filename: string, firstPageText: string, candidates: PePdfTitleCandidate[]): string {
  const headings = candidates
    .map((candidate, index) => ({ text: candidate.text.trim(), height: candidate.height, x: candidate.x, index }))
    .filter((candidate) => candidate.height > 0 && isTitleCandidate(candidate.text));
  const bodyHeight = candidates.length > 0
    ? [...candidates.map((candidate) => candidate.height)].sort((left, right) => left - right)[Math.floor(candidates.length / 2)]
    : 0;
  const tallest = headings.reduce<typeof headings[number] | null>((best, candidate) => (
    !best || candidate.height > best.height + 0.5 ? candidate : best
  ), null);
  if (tallest && tallest.height >= bodyHeight * 1.3) {
    // A company name is often set slightly larger than the headline; prefer a headline-shaped
    // line ("Topic: message" or a question) among the large headings.
    const headline = headings.find((candidate) => (
      candidate.height >= tallest.height * 0.75 && isHeadlineShaped(candidate.text)
    ));
    const chosen = headline ?? tallest;
    const continuation = headings.find((candidate) => (
      candidate.index === chosen.index + 1
      && Math.abs(candidate.height - chosen.height) <= 0.5
      && (candidate.x === undefined || chosen.x === undefined || Math.abs(candidate.x - chosen.x) <= 8)
    ));
    return continuation ? `${chosen.text} ${continuation.text}` : chosen.text;
  }
  const lines = firstPageText.split(/\r?\n/u).map((line) => line.trim()).filter(isTitleCandidate);
  return lines.find(isHeadlineShaped) ?? lines[0] ?? path.parse(filename).name;
}

function extractExhibits(pageTexts: string[]): string[] {
  const exhibits: string[] = [];
  const seen = new Set<string>();
  for (const text of pageTexts) {
    for (const match of text.matchAll(EXHIBIT_CAPTION_PATTERN)) {
      const value = match[0].trim().slice(0, 160);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      exhibits.push(value);
      if (exhibits.length >= 100) return exhibits;
    }
  }
  return exhibits;
}

function detectBrokerage(originalFilename: string, firstPageText: string, pageTexts: string[]): string {
  const filenamePrefix = originalFilename.split(/[-－_]/u)[0]?.trim() ?? "";
  const filenameBrokerage = filenamePrefix.length >= 2 && filenamePrefix.length <= 40
    ? KNOWN_BROKERAGES.find(({ pattern }) => pattern.test(filenamePrefix))?.name
    : undefined;
  if (filenameBrokerage) return filenameBrokerage;

  const otherText = pageTexts.slice(1).join("\n");
  let best: { name: string; score: number } | null = null;
  for (const { name, pattern } of KNOWN_BROKERAGES) {
    const global = new RegExp(pattern.source, "giu");
    const coverHits = [...firstPageText.matchAll(global)].length;
    const otherHits = [...otherText.matchAll(global)].length;
    const score = coverHits * 100 + Math.min(otherHits, 30);
    if (score > 0 && (!best || score > best.score)) best = { name, score };
  }
  if (best) return best.name;
  const chineseHouse = firstMatch(
    firstPageText,
    /^(.{2,40}(?:证券(?:股份有限公司)?|证券研究所|Securities|Capital Markets|Research))\s*$/imu,
  );
  if (chineseHouse) return chineseHouse;
  return "";
}

const RATING_WORDS = "Outperform|Market-?Perform|Underperform|Buy|Neutral|Sell|Hold|Overweight|Equal-?weight|Underweight|Reduce|Accumulate|买入|增持|中性|持有|减持|卖出|强烈推荐|谨慎推荐|推荐|优于大市|同步大市|弱于大市|强于大市|跑赢行业|跑输行业";

function detectRating(firstPageText: string): string {
  const labelled = new RegExp(
    `(?:投资评级|公司评级|评级|12-month rating|rating)\\s*[：:]?\\s*\\n?\\s*(${RATING_WORDS})(?![\\p{L}])`,
    "iu",
  );
  const inline = new RegExp(`\\b(${RATING_WORDS})\\b\\s*[,，;；]?\\s*(?:price target|target price|PT\\b|目标价)`, "iu");
  const sentence = new RegExp(
    `\\b(?:we|and)\\s+(?:rate|maintain|retain|reiterate|reaffirm|initiate)\\b[^.\\n]{0,60}?\\b(${RATING_WORDS})\\b`,
    "iu",
  );
  return firstMatch(firstPageText, labelled) || firstMatch(firstPageText, inline) || firstMatch(firstPageText, sentence);
}

function detectTargetPrice(firstPageText: string): string {
  const amount = "(?:HK\\$|[€$£¥￥])?\\s?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:[A-Z]{3}\\b|元|港元|美元)?(?:\\s*\\(\\s*[\\d,.]+\\s*(?:OLD|prior|previously)\\s*\\))?(?:\\/share)?";
  const labelled = new RegExp(
    `(?:目标价格|目标价|12m price target|price target|target price)\\s*(?:\\([A-Z]{3}\\))?\\s*[：:]?\\s*(?:\\n\\s*[A-Z][A-Z0-9.]{1,10}\\s*)?\\n?\\s*(${amount})`,
    "iu",
  );
  const sentence = new RegExp(`\\bPT\\s+(?:of\\s+)?(${amount})`, "u");
  return firstMatch(firstPageText, labelled) || firstMatch(firstPageText, sentence);
}

export function extractPePdfMetadata(
  originalFilename: string,
  rawPdfMetadata: unknown,
  firstPageText: string,
  pageTexts: string[],
  firstPageBlocks: PePdfTitleCandidate[] = [],
): PePdfDocumentMetadata {
  const pdfMetadata = stringRecord(rawPdfMetadata);
  const title = pdfMetadata.Title?.trim() || inferredTitle(originalFilename, firstPageText, firstPageBlocks);
  const documentDate = [
    coverDate(firstPageText),
    normalizePePdfDate(originalFilename),
    normalizePePdfDate(pdfMetadata.CreationDate ?? ""),
  ].find(Boolean) ?? "";
  return {
    title,
    brokerage: detectBrokerage(originalFilename, firstPageText, pageTexts),
    documentDate,
    rating: detectRating(firstPageText),
    targetPrice: detectTargetPrice(firstPageText),
    exhibits: extractExhibits(pageTexts),
    pdfMetadata,
  };
}
