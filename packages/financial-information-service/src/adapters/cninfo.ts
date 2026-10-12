import { downloadDisclosure, type FetchImplementation, record, safeProviderUrl, stripHtml, text } from "../http.ts";
import type { DownloadedDisclosure, InformationSubscription, SourceAdapter, SourceDisclosure } from "../types.ts";

export class CninfoAdapter implements SourceAdapter {
	readonly provider = "cninfo" as const;
	readonly #request: FetchImplementation;

	constructor(request: FetchImplementation = fetch) {
		this.#request = request;
	}

	async discover(
		subscription: InformationSubscription,
		startDate: string,
		endDate: string,
		signal?: AbortSignal,
	): Promise<SourceDisclosure[]> {
		const results: SourceDisclosure[] = [];
		const pageSize = 30;
		for (let pageNum = 1; pageNum <= 5 && results.length < subscription.maxDocuments; pageNum++) {
			const url = new URL("https://www.cninfo.com.cn/new/fulltextSearch/full");
			for (const [name, value] of Object.entries({
				// Always discover by exact security code. Natural-language search keys can
				// return an empty set even when the issuer has disclosures in the range.
				searchkey: subscription.securityCode,
				sdate: startDate,
				edate: endDate,
				isfulltext: "false",
				sortName: "pubdate",
				sortType: "desc",
				pageNum: String(pageNum),
				pageSize: String(pageSize),
				type: "",
			})) {
				url.searchParams.set(name, value);
			}
			const response = await this.#request(url, {
				headers: {
					accept: "application/json",
					referer: "https://www.cninfo.com.cn/new/fulltextSearch",
					"user-agent": "PE-Financial-Information/1.0",
				},
				signal,
			});
			if (!response.ok) throw new Error(`CNINFO query failed with HTTP ${response.status}`);
			const payload = record(await response.json(), "CNINFO response");
			if (payload.announcements === null) return results;
			if (!Array.isArray(payload.announcements)) throw new Error("Invalid CNINFO announcements response");
			for (const raw of payload.announcements) {
				const row = record(raw, "CNINFO announcement");
				if (text(row.secCode) !== subscription.securityCode) continue;
				const externalId = text(row.announcementId);
				const title = text(row.announcementTitle);
				const path = text(row.adjunctUrl);
				if (!externalId || !title || !path || typeof row.announcementTime !== "number") {
					throw new Error("CNINFO announcement is missing its ID, title, URL, or publication time");
				}
				const documentUrl = safeProviderUrl("cninfo", path, "https://static.cninfo.com.cn/");
				results.push({
					provider: "cninfo",
					externalId,
					securityCode: subscription.securityCode,
					issuer: stripHtml(text(row.secName) || subscription.securityCode),
					title: stripHtml(title),
					category: text(row.announcementType),
					publishedAt: new Date(row.announcementTime).toISOString(),
					canonicalUrl: documentUrl,
					downloadUrl: documentUrl,
				});
				if (results.length >= subscription.maxDocuments) break;
			}
			if (payload.hasMore !== true || payload.announcements.length < pageSize) break;
		}
		return results;
	}

	download(disclosure: SourceDisclosure, signal?: AbortSignal): Promise<DownloadedDisclosure> {
		return downloadDisclosure(disclosure, this.#request, "PE-Financial-Information/1.0", signal);
	}
}
