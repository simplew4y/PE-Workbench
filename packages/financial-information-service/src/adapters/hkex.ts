import { downloadDisclosure, type FetchImplementation, stripHtml } from "../http.ts";
import type { DownloadedDisclosure, InformationSubscription, SourceAdapter, SourceDisclosure } from "../types.ts";

interface HkexStock {
	i?: unknown;
	c?: unknown;
	n?: unknown;
}

function field(row: string, className: string): string {
	const match = new RegExp(`<td[^>]*class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`, "iu").exec(row);
	return match ? stripHtml(match[1]) : "";
}

function parseRows(html: string, subscription: InformationSubscription): SourceDisclosure[] {
	const total = /Total records found:\s*([\d,]+)/iu.exec(html);
	if (total && Number(total[1].replaceAll(",", "")) > 1000) {
		throw new Error("HKEX query returned more than 1000 records; narrow the date range");
	}
	const rows = html.match(/<tr>[\s\S]*?<\/tr>/giu) ?? [];
	const results: SourceDisclosure[] = [];
	for (const row of rows) {
		const link = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/iu.exec(row);
		if (!link || !/\/listedco\/listconews\//u.test(link[1])) continue;
		const released = field(row, "release-time");
		const code = /\b\d{5}\b/u.exec(field(row, "stock-short-code"))?.[0];
		const issuer = field(row, "stock-short-name")
			.replace(/^Stock Short Name:\s*/iu, "")
			.split(/\s{2,}|\n/u)[0];
		const headline = /<div[^>]*class=["'][^"']*headline[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu.exec(row);
		const match = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/u.exec(released);
		const externalId = /\/([^/]+)\.(?:pdf|htm|html)$/iu.exec(link[1])?.[1];
		if (!match || !externalId) throw new Error("HKEX result row is missing its publication time or document ID");
		const documentUrl = new URL(link[1], "https://www1.hkexnews.hk/").href;
		results.push({
			provider: "hkex",
			externalId,
			securityCode: code || subscription.securityCode.padStart(5, "0"),
			issuer: issuer || subscription.securityCode,
			title: stripHtml(link[2]),
			category: headline ? stripHtml(headline[1]) : undefined,
			publishedAt: new Date(`${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+08:00`).toISOString(),
			canonicalUrl: documentUrl,
			downloadUrl: documentUrl,
		});
	}
	return results.slice(0, subscription.maxDocuments);
}

export class HkexAdapter implements SourceAdapter {
	readonly provider = "hkex" as const;
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
		const dictionary = await this.#request("https://www1.hkexnews.hk/ncms/script/eds/activestock_sehk_e.json", {
			headers: { accept: "application/json", "user-agent": "PE-Financial-Information/1.0" },
			signal,
		});
		if (!dictionary.ok) throw new Error(`HKEX stock dictionary failed with HTTP ${dictionary.status}`);
		const stocks: unknown = await dictionary.json();
		if (!Array.isArray(stocks)) throw new Error("Invalid HKEX stock dictionary");
		const code = subscription.securityCode.padStart(5, "0");
		const stock = (stocks as HkexStock[]).find((entry) => entry.c === code && typeof entry.i === "number");
		if (!stock || typeof stock.i !== "number") throw new Error(`HKEX stock code not found: ${code}`);
		const body = new URLSearchParams({
			lang: "EN",
			category: "0",
			market: "SEHK",
			searchType: "0",
			documentType: "-1",
			t1code: "",
			t2Gcode: "",
			t2code: "",
			stockId: String(stock.i),
			from: startDate.replaceAll("-", ""),
			to: endDate.replaceAll("-", ""),
			title: subscription.query || "",
		});
		const response = await this.#request("https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en", {
			method: "POST",
			headers: {
				accept: "text/html",
				"content-type": "application/x-www-form-urlencoded",
				referer: "https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en",
				"user-agent": "PE-Financial-Information/1.0",
			},
			body,
			signal,
		});
		if (!response.ok) throw new Error(`HKEX title search failed with HTTP ${response.status}`);
		return parseRows(await response.text(), subscription);
	}

	download(disclosure: SourceDisclosure, signal?: AbortSignal): Promise<DownloadedDisclosure> {
		return downloadDisclosure(disclosure, this.#request, "PE-Financial-Information/1.0", signal);
	}
}

export { parseRows as parseHkexRows };
