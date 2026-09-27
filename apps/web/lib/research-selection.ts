export function cleanResearchSelection(value: string, injectedAccessibilityText: string[]): string {
  let cleaned = value;
  for (const text of [...new Set(injectedAccessibilityText.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    cleaned = cleaned.replaceAll(text, "");
  }
  return cleaned.replace(/[\u200B-\u200D\uFEFF]/gu, "").trim();
}
