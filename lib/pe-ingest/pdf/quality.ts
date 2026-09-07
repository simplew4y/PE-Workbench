import type { PePdfQualitySignals, PePdfTextQuality } from "../contracts.ts";

export interface PePdfQualityResult {
  quality: PePdfTextQuality;
  signals: PePdfQualitySignals;
}

export function evaluatePePdfTextQuality(text: string): PePdfQualityResult {
  const characters = [...text].filter((character) => !/\s/u.test(character));
  const characterCount = characters.length;
  const replacementCharacters = characters.filter((character) => character === "\uFFFD").length;
  const suspiciousCharacters = characters.filter((character) => (
    character === "\u0000"
    || /[\uE000-\uF8FF]/u.test(character)
    || (/\p{Cc}/u.test(character) && character !== "\t" && character !== "\n" && character !== "\r")
  )).length;
  const readableCharacters = characters.filter((character) => (
    /[\p{L}\p{N}\p{P}\p{S}]/u.test(character)
    && character !== "\uFFFD"
    && !/[\uE000-\uF8FF]/u.test(character)
  )).length;
  const denominator = Math.max(1, characterCount);
  const replacementCharacterRatio = replacementCharacters / denominator;
  const suspiciousCharacterRatio = suspiciousCharacters / denominator;
  const readableCharacterRatio = readableCharacters / denominator;
  const reasons: string[] = [];
  if (characterCount === 0) reasons.push("no_extractable_text");
  if (replacementCharacterRatio > 0.02) reasons.push("replacement_characters");
  if (suspiciousCharacterRatio > 0.02) reasons.push("suspicious_characters");
  if (characterCount >= 50 && readableCharacterRatio < 0.55) reasons.push("low_readable_character_ratio");
  return {
    quality: reasons.length > 0 ? "needs_ocr" : "passed",
    signals: {
      characterCount,
      replacementCharacterRatio,
      suspiciousCharacterRatio,
      readableCharacterRatio,
      reasons,
    },
  };
}
