import { INFORMATION_PROVIDERS, type InformationSubscription, type SubscriptionInput } from "./types.ts";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function validDate(value: string): boolean {
	if (!DATE_PATTERN.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateDateRange(startDate: string, endDate: string): void {
	if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
		throw new Error("Dates must form an ordered YYYY-MM-DD range");
	}
}

function requiredText(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
		throw new Error(`${label} is required and must not exceed ${maxLength} characters`);
	}
	return value.trim();
}

export function validateSubscriptionInput(
	input: SubscriptionInput,
): Omit<InformationSubscription, "id" | "nextRunAt" | "lastCheckedAt" | "createdAt" | "updatedAt"> {
	const datasetId = requiredText(input.datasetId, "datasetId", 256);
	if (!INFORMATION_PROVIDERS.includes(input.provider)) throw new Error("Unsupported information provider");
	const securityCode = requiredText(input.securityCode, "securityCode", 16);
	if (input.provider === "cninfo" && !/^\d{6}$/u.test(securityCode)) {
		throw new Error("CNINFO securityCode must contain six digits");
	}
	if (input.provider === "hkex" && !/^\d{1,5}$/u.test(securityCode)) {
		throw new Error("HKEX securityCode must contain one to five digits");
	}
	if (input.provider === "sec-edgar" && !/^\d{1,10}$/u.test(securityCode)) {
		throw new Error("SEC securityCode must be a CIK containing one to ten digits");
	}
	const intervalMinutes = input.intervalMinutes ?? 30;
	const lookbackDays = input.lookbackDays ?? 30;
	const maxDocuments = input.maxDocuments ?? 20;
	if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 10_080) {
		throw new Error("intervalMinutes must be an integer between 5 and 10080");
	}
	if (!Number.isSafeInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 366) {
		throw new Error("lookbackDays must be an integer between 1 and 366");
	}
	if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 100) {
		throw new Error("maxDocuments must be an integer between 1 and 100");
	}
	const query = input.query?.trim();
	if (query && query.length > 200) throw new Error("query must not exceed 200 characters");
	return {
		datasetId,
		provider: input.provider,
		securityCode,
		...(query ? { query } : {}),
		intervalMinutes,
		lookbackDays,
		maxDocuments,
		enabled: input.enabled ?? true,
	};
}
