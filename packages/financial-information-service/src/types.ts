export const INFORMATION_PROVIDERS = ["cninfo", "hkex", "sec-edgar"] as const;
export type InformationProvider = (typeof INFORMATION_PROVIDERS)[number];

export interface SubscriptionInput {
	datasetId: string;
	provider: InformationProvider;
	securityCode: string;
	query?: string;
	intervalMinutes?: number;
	lookbackDays?: number;
	maxDocuments?: number;
	enabled?: boolean;
}

export interface InformationSubscription {
	id: string;
	datasetId: string;
	provider: InformationProvider;
	securityCode: string;
	query?: string;
	intervalMinutes: number;
	lookbackDays: number;
	maxDocuments: number;
	enabled: boolean;
	nextRunAt: number;
	lastCheckedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface SourceDisclosure {
	provider: InformationProvider;
	externalId: string;
	securityCode: string;
	issuer: string;
	title: string;
	category?: string;
	publishedAt: string;
	canonicalUrl: string;
	downloadUrl: string;
}

export interface DownloadedDisclosure {
	disclosure: SourceDisclosure;
	bytes: Uint8Array;
	contentType: string;
	retrievedUrl: string;
}

export type InformationImportance = "high" | "medium" | "low";

export interface FrameworkUpdateCandidate {
	schemaVersion: 1;
	id: string;
	subscriptionId: string;
	datasetId: string;
	provider: InformationProvider;
	externalId: string;
	securityCode: string;
	issuer: string;
	title: string;
	category?: string;
	publishedAt: string;
	canonicalUrl: string;
	retrievedUrl: string;
	contentHash: string;
	contentType: string;
	filename: string;
	importance: InformationImportance;
	reasons: string[];
	requiresReview: true;
	createdAt: string;
}

export interface SourceAdapter {
	readonly provider: InformationProvider;
	discover(
		subscription: InformationSubscription,
		startDate: string,
		endDate: string,
		signal?: AbortSignal,
	): Promise<SourceDisclosure[]>;
	download(disclosure: SourceDisclosure, signal?: AbortSignal): Promise<DownloadedDisclosure>;
}

export interface RunResult {
	runId: string;
	subscriptionId: string;
	provider: InformationProvider;
	discovered: number;
	created: number;
	duplicates: number;
	candidateIds: string[];
	startedAt: string;
	finishedAt: string;
}
