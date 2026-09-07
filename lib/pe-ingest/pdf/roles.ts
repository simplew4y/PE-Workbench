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

const ROLE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "disclosure", pattern: /免责声明|分析师声明|信息披露|风险提示|analyst certification|important disclosure/iu },
  { label: "rating_history", pattern: /历史评级|评级历史|rating history/iu },
  { label: "valuation_method", pattern: /估值方法|估值假设|目标价测算|valuation method|price target/iu },
  { label: "exhibit", pattern: /(?:图|表)\s*\d+|exhibit\s*\d+|figure\s*\d+|table\s*\d+/iu },
];

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
  const signals: PePdfRoleSignals = {
    matchedKeywords,
    numericLineRatio,
    tableLineRatio,
    embeddedImageCount: imageStatistics.embeddedImageCount,
    largeEmbeddedImageCount: imageStatistics.largeEmbeddedImageCount,
    drawingOperatorCount: imageStatistics.drawingOperatorCount,
  };

  let role: PePdfPageRole = "body";
  if (pageNumber === 1) {
    role = "cover";
  } else if (matchedKeywords.includes("disclosure") || (
    pageNumber >= Math.max(2, totalPages - 1) && /风险|声明|披露|免责/iu.test(text)
  )) {
    role = "disclosure_boilerplate";
  } else if (matchedKeywords.includes("rating_history")) {
    role = "rating_history";
  } else if (matchedKeywords.includes("valuation_method")) {
    role = "valuation_method";
  } else if (tableLineRatio >= 0.28 || (numericLineRatio >= 0.6 && nonEmptyBlocks.length >= 5)) {
    role = "table_heavy";
  } else if (matchedKeywords.includes("exhibit") && (
    imageStatistics.drawingOperatorCount >= 12 || imageStatistics.embeddedImageCount > 0
  )) {
    role = "exhibit_chart";
  } else if (imageStatistics.embeddedImageCount > 0 && text.length < 800) {
    role = "exhibit_image";
  }
  return { role, signals };
}
