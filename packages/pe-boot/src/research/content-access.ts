import type { FrameworkContent, StoredFrameworkContent } from "./model.ts";

export function isFrameworkDocument(value: StoredFrameworkContent): value is FrameworkContent {
	return "schemaVersion" in value && value.schemaVersion === 2;
}

export function getFrameworkItems(value: StoredFrameworkContent) {
	return isFrameworkDocument(value) ? value.sections.investmentJudgments.items : value.items;
}

export function getFrameworkCoverageGaps(value: StoredFrameworkContent): string[] {
	return isFrameworkDocument(value) ? value.sections.evidenceAndChanges.coverageGaps : value.coverageGaps;
}
