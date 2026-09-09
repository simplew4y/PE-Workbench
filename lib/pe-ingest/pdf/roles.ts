import type {
  PePdfBlock,
  PePdfImageStatistics,
  PePdfPageRole,
  PePdfRoleSignals,
} from "../contracts.ts";

export interface PePdfRoleResult {
  role: PePdfPageRole;
  signals: PePdfRoleSignals;
}

/** A caption line such as "EXHIBIT 3: ..." or "图表 5：..." at the start of a line. */
export const EXHIBIT_CAPTION_PATTERN = /^\s*(?:(?:图表|图|表)\s*\d+|(?:Exhibit|Figure|Table|Chart)\s*\d+)\s*[：:.．\-–—]?\s*\S.*$/gimu;

const ROLE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    // Section headings that open a disclosure appendix, on a line of their own.
    label: "disclosure",
    pattern: new RegExp(
      [
        "^\\s*(?:[ivx]+\\.\\s*)?(?:disclosure appendix|required disclosures?|analyst certifications?:?",
        "|[\\w ]{0,40}disclaimer|important disclosures?|company disclosures?)\\s*$",
        "|^.{0,20}(?:免责声明|分析师声明|分析师承诺|信息披露|法律声明|评级说明|投资评级说明).{0,20}$",
      ].join(""),
      "imu",
    ),
  },
  {
    label: "rating_history",
    pattern: /rating history|ratings? and price target history|历史评级|评级历史|评级变动/iu,
  },
  {
    // A valuation section heading; passing mentions such as "valuation methods may differ" do not count.
    label: "valuation_method",
    pattern: /^\s*(?:valuation method(?:ology)?(?: and risk statement)?|target price (?:methodology|derivation)|估值方法|估值假设|目标价测算)\b.{0,60}$/imu,
  },
  { label: "exhibit", pattern: new RegExp(EXHIBIT_CAPTION_PATTERN.source, "imu") },
];

/** Legal vocabulary that is dense on disclaimer and rating-definition pages and sparse in analysis. */
const DISCLOSURE_VOCABULARY = new RegExp(
  [
    "disclos", "disclaim", "regulat", "affiliat", "investment banking", "liabilit", "jurisdiction",
    "solicit", "certif", "compensat", "conflict", "authori[sz]ed", "licen[cs]ed", "prohibit",
    "responsib", "broker", "finra", "\\bsec\\b", "recipient", "warrant", "copyright", "rights reserved",
    "securities", "entit(?:y|ies)", "distribut", "\\blegal\\b", "\\bact\\b", "registered",
    "research analyst", "this (?:report|document|publication)", "\\bfirm\\b", "\\bpersons?\\b",
    "\\bratings?\\b", "benchmark", "market index", "coverage suspended", "not rated",
    "本报告", "未经", "授权", "法律", "监管", "责任", "仅供", "版权", "评级", "分析师",
  ].join("|"),
  "giu",
);
const DISCLOSURE_DENSITY_PER_THOUSAND = 6;
const DISCLOSURE_MIN_CHARS = 1_200;
/** Charts and exhibit tables draw far more vector paths than the boxes on a rating-distribution page. */
const DISCLOSURE_MAX_DRAWING_OPERATORS = 200;

const RATING_WORD_PATTERN = /\b(?:Buy|Neutral|Sell|Hold|Outperform|Market-?Perform|Underperform|Overweight|Equal-?weight|Underweight)\b/giu;
const DATE_PATTERN = /\b(?:20\d{2}-\d{2}-\d{2}|\d{2}\/\d{2}\/20\d{2}|\d{1,2}\s+[A-Z][a-z]{2,8}\s+20\d{2})\b/gu;

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/** A rating history table lists dates with price targets and rating words even without a heading. */
function looksLikeRatingHistoryTable(text: string): boolean {
  return /price target|目标价/iu.test(text)
    && /\brating\b|评级/iu.test(text)
    && countMatches(text, DATE_PATTERN) >= 4
    && countMatches(text, RATING_WORD_PATTERN) >= 3;
}

export function classifyPePdfPageRole(
  pageNumber: number,
  totalPages: number,
  text: string,
  blocks: PePdfBlock[],
  imageStatistics: PePdfImageStatistics,
): PePdfRoleResult {
  const matchedKeywords = ROLE_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);
  const nonEmptyBlocks = blocks.filter((block) => block.text.trim());
  const numericLines = nonEmptyBlocks.filter((block) => /\d/u.test(block.text));
  const tableLines = nonEmptyBlocks.filter((block) => block.blockType === "table_row");
  const denominator = Math.max(1, nonEmptyBlocks.length);
  const numericLineRatio = numericLines.length / denominator;
  const tableLineRatio = tableLines.length / denominator;
  const characterCount = text.replace(/\s+/gu, "").length;
  const disclosureDensity = countMatches(text, DISCLOSURE_VOCABULARY) / (Math.max(1, characterCount) / 1_000);
  const signals: PePdfRoleSignals = {
    matchedKeywords,
    numericLineRatio,
    tableLineRatio,
    disclosureDensity: Math.round(disclosureDensity * 100) / 100,
    embeddedImageCount: imageStatistics.embeddedImageCount,
    largeEmbeddedImageCount: imageStatistics.largeEmbeddedImageCount,
    drawingOperatorCount: imageStatistics.drawingOperatorCount,
  };
  const hasExhibit = matchedKeywords.includes("exhibit");
  const plainTextPage = !hasExhibit && imageStatistics.drawingOperatorCount < DISCLOSURE_MAX_DRAWING_OPERATORS;
  // An explicit appendix heading is decisive on its own: disclosure pages often carry a captioned
  // ratings-distribution table, which would otherwise disqualify them through hasExhibit. The
  // weaker vocabulary and trailing-page heuristics still require a plain text page.
  const isDisclosure = matchedKeywords.includes("disclosure")
    || (plainTextPage && (
      (characterCount >= DISCLOSURE_MIN_CHARS && disclosureDensity >= DISCLOSURE_DENSITY_PER_THOUSAND)
      || (pageNumber >= Math.max(2, totalPages - 1) && /风险|声明|披露|免责/u.test(text))
    ));

  let role: PePdfPageRole = "body";
  if (pageNumber === 1) {
    role = "cover";
  } else if (matchedKeywords.includes("rating_history") || looksLikeRatingHistoryTable(text)) {
    role = "rating_history";
  } else if (matchedKeywords.includes("valuation_method")) {
    role = "valuation_method";
  } else if (isDisclosure) {
    role = "disclosure_boilerplate";
  } else if (imageStatistics.largeEmbeddedImageCount >= 2 && text.length < 1_500) {
    // Screenshots and photos: the logo image most brokers repeat on every page never counts alone.
    role = "exhibit_image";
  } else if (tableLineRatio >= 0.28 || (numericLineRatio >= 0.6 && nonEmptyBlocks.length >= 5)) {
    role = "table_heavy";
  } else if (hasExhibit && (
    imageStatistics.drawingOperatorCount >= 12 || imageStatistics.largeEmbeddedImageCount >= 2
  )) {
    role = "exhibit_chart";
  } else if (hasExhibit && imageStatistics.embeddedImageCount > 0 && text.length < 800) {
    role = "exhibit_image";
  }
  return { role, signals };
}
