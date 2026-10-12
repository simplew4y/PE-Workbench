import { downloadDisclosure, type FetchImplementation, record, safeProviderUrl, text } from "../http.ts";
import type { DownloadedDisclosure, InformationSubscription, SourceAdapter, SourceDisclosure } from "../types.ts";

function disclosuresFromColumns(
	value: unknown,
	issuer: string,
	cik: string,
	startDate: string,
	endDate: string,
	requestedForms: string[] | undefined,
): SourceDisclosure[] {
	const columns = record(value, "SEC filing columns");
	const accessions = Array.isArray(columns.accessionNumber) ? columns.accessionNumber : undefined;
	const dates = Array.isArray(columns.filingDate) ? columns.filingDate : undefined;
	const forms = Array.isArray(columns.form) ? columns.form : undefined;
	const documents = Array.isArray(columns.primaryDocument) ? columns.primaryDocument : undefined;
	if (!accessions || !dates || !forms || !documents) throw new Error("Invalid SEC filing columns");
	if (
		dates.length !== accessions.length ||
		forms.length !== accessions.length ||
		documents.length !== accessions.length
	) {
		throw new Error("SEC filing columns have inconsistent lengths");
	}
	const results: SourceDisclosure[] = [];
	for (let index = 0; index < accessions.length; index++) {
		const accession = text(accessions[index]);
		const publishedAt = text(dates[index]);
		const form = text(forms[index]);
		const primary = text(documents[index]);
		if (!accession || !publishedAt || !form || !primary) throw new Error("SEC filing row is incomplete");
		if (publishedAt < startDate || publishedAt > endDate) continue;
		if (requestedForms?.length && !requestedForms.includes(form.toUpperCase())) continue;
		const accessionPath = accession.replaceAll("-", "");
		const archiveRoot = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionPath}/`;
		results.push({
			provider: "sec-edgar",
			externalId: accession,
			securityCode: cik,
			issuer,
			title: `${form} filing`,
			category: form,
			publishedAt: new Date(`${publishedAt}T00:00:00.000Z`).toISOString(),
			canonicalUrl: safeProviderUrl("sec-edgar", `${archiveRoot}${accessionPath}-index.html`),
			downloadUrl: safeProviderUrl("sec-edgar", `${archiveRoot}${encodeURIComponent(primary)}`),
		});
	}
	return results;
}

export class SecEdgarAdapter implements SourceAdapter {
	readonly provider = "sec-edgar" as const;
	readonly #request: FetchImplementation;
	readonly #userAgent: string;

	constructor(userAgent: string, request: FetchImplementation = fetch) {
		if (!userAgent.trim() || !userAgent.includes("@")) {
			throw new Error("SEC_EDGAR_USER_AGENT must identify the application and include a contact email");
		}
		this.#userAgent = userAgent.trim();
		this.#request = request;
	}

	async discover(
		subscription: InformationSubscription,
		startDate: string,
		endDate: string,
		signal?: AbortSignal,
	): Promise<SourceDisclosure[]> {
		const cik = subscription.securityCode.padStart(10, "0");
		const response = await this.#request(`https://data.sec.gov/submissions/CIK${cik}.json`, {
			headers: { accept: "application/json", "user-agent": this.#userAgent },
			signal,
		});
		if (!response.ok) throw new Error(`SEC submissions request failed with HTTP ${response.status}`);
		const root = record(await response.json(), "SEC submissions response");
		const filings = record(root.filings, "SEC filings");
		const requestedForms = subscription.query
			?.split(",")
			.map((value) => value.trim().toUpperCase())
			.filter(Boolean);
		const issuer = text(root.name) || `CIK ${cik}`;
		const results = disclosuresFromColumns(filings.recent, issuer, cik, startDate, endDate, requestedForms);
		const seen = new Set(results.map((result) => result.externalId));
		const historicalFiles = Array.isArray(filings.files) ? filings.files : [];
		for (const value of historicalFiles) {
			if (results.length >= subscription.maxDocuments) break;
			const file = record(value, "SEC historical submissions descriptor");
			const name = text(file.name);
			const filingFrom = text(file.filingFrom);
			const filingTo = text(file.filingTo);
			if (!name || !filingFrom || !filingTo || !/^[A-Za-z0-9._-]+$/u.test(name)) {
				throw new Error("Invalid SEC historical submissions descriptor");
			}
			if (filingTo < startDate || filingFrom > endDate) continue;
			const historical = await this.#request(`https://data.sec.gov/submissions/${name}`, {
				headers: { accept: "application/json", "user-agent": this.#userAgent },
				signal,
			});
			if (!historical.ok)
				throw new Error(`SEC historical submissions request failed with HTTP ${historical.status}`);
			for (const disclosure of disclosuresFromColumns(
				await historical.json(),
				issuer,
				cik,
				startDate,
				endDate,
				requestedForms,
			)) {
				if (!seen.has(disclosure.externalId)) {
					seen.add(disclosure.externalId);
					results.push(disclosure);
				}
			}
		}
		return results
			.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
			.slice(0, subscription.maxDocuments);
	}

	download(disclosure: SourceDisclosure, signal?: AbortSignal): Promise<DownloadedDisclosure> {
		return downloadDisclosure(disclosure, this.#request, this.#userAgent, signal);
	}
}
