import { createHash } from "node:crypto";
import { extname } from "node:path";
import { preparePeDocument, registerPeDocuments } from "./documents.ts";
import { sourceId } from "./source.ts";
import { openPeDataset, openWritablePeDataset, sourceMarkdownCitation } from "./tools/database.ts";

export const OFFICIAL_FILING_PROVIDERS = ["cninfo", "hkex", "sec-edgar"] as const;
export type OfficialFilingProvider = (typeof OFFICIAL_FILING_PROVIDERS)[number];

export interface OfficialFilingQuery {
	provider: OfficialFilingProvider;
	securityCode: string;
	startDate: string;
	endDate: string;
	query?: string;
	limit?: number;
}

export interface OfficialFilingCandidate {
	schemaVersion: 1;
	id: string;
	subscriptionId: string;
	datasetId: string;
	provider: OfficialFilingProvider;
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
	importance: "high" | "medium" | "low";
	reasons: string[];
	requiresReview: true;
	createdAt: string;
}

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const PROVIDER_HOSTS: Record<OfficialFilingProvider, ReadonlySet<string>> = {
	cninfo: new Set(["www.cninfo.com.cn", "static.cninfo.com.cn"]),
	hkex: new Set(["www1.hkexnews.hk", "www.hkexnews.hk"]),
	"sec-edgar": new Set(["data.sec.gov", "www.sec.gov"]),
};

function validDate(value: string): boolean {
	if (!DATE_PATTERN.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateQuery(input: OfficialFilingQuery): void {
	if (!OFFICIAL_FILING_PROVIDERS.includes(input.provider))
		throw new Error("Select a supported official filing provider");
	if (!validDate(input.startDate) || !validDate(input.endDate) || input.startDate > input.endDate) {
		throw new Error("Official filing dates must form an ordered YYYY-MM-DD range");
	}
	if (input.provider === "cninfo" && !/^\d{6}$/u.test(input.securityCode)) {
		throw new Error("CNINFO securityCode must contain six digits");
	}
	if (input.provider === "hkex" && !/^\d{1,5}$/u.test(input.securityCode)) {
		throw new Error("HKEX securityCode must contain one to five digits");
	}
	if (input.provider === "sec-edgar" && !/^\d{1,10}$/u.test(input.securityCode)) {
		throw new Error("SEC securityCode must be a CIK containing one to ten digits");
	}
	if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
		throw new Error("Official filing limit must be 1–100");
	}
}

function safeUrl(provider: OfficialFilingProvider, value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:" || !PROVIDER_HOSTS[provider].has(url.hostname)) {
		throw new Error(`${provider} candidate contains an unsupported URL`);
	}
	return url.href;
}

function required(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`Invalid ${label}`);
	return value.trim();
}

function cleanHtml(value: string): string {
	return value
		.replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
		.replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
		.replaceAll(/<\/?(?:p|div|table|tr|td|li|h[1-6])\b[^>]*>|<br\s*\/?>/giu, "\n")
		.replaceAll(/<[^>]+>/gu, " ")
		.replaceAll(/&nbsp;|&#160;/giu, " ")
		.replaceAll(/&amp;/giu, "&")
		.replaceAll(/&lt;/giu, "<")
		.replaceAll(/&gt;/giu, ">")
		.replaceAll(/[ \t]+/gu, " ")
		.replaceAll(/\n\s+/gu, "\n")
		.trim();
}

function validateCandidate(value: OfficialFilingCandidate): OfficialFilingCandidate {
	if (value.schemaVersion !== 1 || !OFFICIAL_FILING_PROVIDERS.includes(value.provider)) {
		throw new Error("Unsupported official filing candidate schema");
	}
	for (const [label, content, limit] of [
		["candidate id", value.id, 256],
		["subscription id", value.subscriptionId, 256],
		["dataset id", value.datasetId, 256],
		["external id", value.externalId, 256],
		["security code", value.securityCode, 32],
		["issuer", value.issuer, 500],
		["title", value.title, 2000],
		["content hash", value.contentHash, 64],
	] as const) {
		required(content, label, limit);
	}
	if (!/^[a-f0-9]{64}$/u.test(value.contentHash)) throw new Error("Invalid candidate content hash");
	if (!/^(?:high|medium|low)$/u.test(value.importance) || value.requiresReview !== true) {
		throw new Error("Invalid candidate review classification");
	}
	required(value.filename, "candidate filename", 255);
	if (!Number.isFinite(Date.parse(value.publishedAt)) || !Number.isFinite(Date.parse(value.createdAt))) {
		throw new Error("Invalid candidate timestamp");
	}
	if (!["application/pdf", "text/html", "application/xhtml+xml", "text/plain"].includes(value.contentType)) {
		throw new Error("Unsupported official filing content type");
	}
	safeUrl(value.provider, value.canonicalUrl);
	safeUrl(value.provider, value.retrievedUrl);
	if (
		!Array.isArray(value.reasons) ||
		value.reasons.some((reason) => typeof reason !== "string" || reason.length > 2000)
	) {
		throw new Error("Invalid candidate reasons");
	}
	return value;
}

function snapshot(candidate: OfficialFilingCandidate, bytes: Uint8Array): Uint8Array {
	const raw = new TextDecoder().decode(bytes);
	const body = candidate.contentType === "text/plain" ? raw : cleanHtml(raw);
	return new TextEncoder().encode(
		[
			`Provider: ${candidate.provider}`,
			`Issuer: ${candidate.issuer}`,
			`Security code: ${candidate.securityCode}`,
			`Title: ${candidate.title}`,
			`Category: ${candidate.category ?? "unknown"}`,
			`Published: ${candidate.publishedAt}`,
			`Canonical URL: ${candidate.canonicalUrl}`,
			`Retrieved URL: ${candidate.retrievedUrl}`,
			`Importance: ${candidate.importance}`,
			"",
			body,
		].join("\n"),
	);
}

export async function fetchOfficialFilings(
	cwd: string,
	input: OfficialFilingQuery,
	signal?: AbortSignal,
	request: FetchImplementation = fetch,
) {
	validateQuery(input);
	const serviceUrl = process.env.FINANCIAL_INFORMATION_SERVICE_URL?.trim();
	const token = process.env.FINANCIAL_INFORMATION_SERVICE_TOKEN?.trim();
	if (!serviceUrl || !token) {
		throw new Error("Configure FINANCIAL_INFORMATION_SERVICE_URL and FINANCIAL_INFORMATION_SERVICE_TOKEN");
	}
	const connection = openPeDataset(cwd);
	const datasetId = connection.datasetId;
	connection.database.close();
	const response = await request(new URL("/v1/fetch", serviceUrl), {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({
			datasetId,
			provider: input.provider,
			securityCode: input.securityCode,
			startDate: input.startDate,
			endDate: input.endDate,
			query: input.query,
			maxDocuments: input.limit,
			enabled: false,
		}),
		signal,
	});
	if (!response.ok) {
		throw new Error(
			`Financial information service failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
		);
	}
	return response.json();
}

export async function ingestOfficialFilingCandidate(
	cwd: string,
	metadata: OfficialFilingCandidate,
	bytes: Uint8Array,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const candidate = validateCandidate(metadata);
	if (bytes.byteLength === 0 || bytes.byteLength > 50_000_000)
		throw new Error("Official filing must be 1–50000000 bytes");
	if (createHash("sha256").update(bytes).digest("hex") !== candidate.contentHash) {
		throw new Error("Official filing content hash does not match the candidate");
	}
	const pdf = bytes.byteLength >= 5 && new TextDecoder("ascii").decode(bytes.subarray(0, 5)) === "%PDF-";
	if (candidate.contentType === "application/pdf" && !pdf)
		throw new Error("Official filing claimed to be PDF but is not a PDF");
	const connection = openPeDataset(cwd, candidate.datasetId);
	const { datasetId, workspaceRoot } = connection;
	connection.database.close();
	if (datasetId !== candidate.datasetId) throw new Error("Candidate belongs to another project");
	const id = candidate.externalId.replaceAll(/[^A-Za-z0-9_-]+/gu, "-").slice(0, 100);
	const name = `${candidate.provider}-${id}${pdf ? ".pdf" : ".txt"}`;
	const storedBytes = pdf ? bytes : snapshot(candidate, bytes);
	const document = registerPeDocuments(workspaceRoot, datasetId, [{ name, bytes: storedBytes }]).documents[0];
	const writable = openWritablePeDataset(workspaceRoot, datasetId);
	try {
		writable.database
			.prepare(`UPDATE documents SET title=?,document_date=?,doc_type=?,company_name=?,company_ticker=?,source_name=?,
			metadata_json=?,status=CASE WHEN file_type='txt' THEN 'completed' ELSE status END,
			parser_name=CASE WHEN file_type='txt' THEN 'official_filing_snapshot' ELSE parser_name END,
			parser_version=CASE WHEN file_type='txt' THEN '1' ELSE parser_version END WHERE dataset_id=? AND doc_id=?`)
			.run(
				candidate.title,
				candidate.publishedAt.slice(0, 10),
				candidate.category ?? "official_filing",
				candidate.issuer,
				candidate.securityCode,
				candidate.provider,
				JSON.stringify(candidate),
				datasetId,
				document.doc_id,
			);
	} finally {
		writable.database.close();
	}
	let evidenceId: string;
	let location: { page_start: number; page_end: number } | { line_start: number; line_end: number };
	if (extname(name) === ".pdf") {
		const prepared = await preparePeDocument(workspaceRoot, { docId: String(document.doc_id), datasetId }, signal);
		if (Number(prepared.document.page_count) < 1) throw new Error("Official filing PDF produced no readable pages");
		evidenceId = sourceId({ docId: String(document.doc_id), location: { kind: "pdf", pageStart: 1, pageEnd: 1 } });
		location = { page_start: 1, page_end: 1 };
	} else {
		const lineEnd = Math.min(new TextDecoder().decode(storedBytes).split("\n").length, 100);
		evidenceId = sourceId({ docId: String(document.doc_id), location: { kind: "text", lineStart: 1, lineEnd } });
		location = { line_start: 1, line_end: lineEnd };
	}
	return {
		candidateId: candidate.id,
		docId: String(document.doc_id),
		version: Number(document.version_no),
		filename: name,
		evidenceId,
		markdownCitation: sourceMarkdownCitation({ ...document, ...location }, evidenceId),
	};
}
