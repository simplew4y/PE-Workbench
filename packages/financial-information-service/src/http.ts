import type { DownloadedDisclosure, InformationProvider, SourceDisclosure } from "./types.ts";

export type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

const PROVIDER_HOSTS: Record<InformationProvider, ReadonlySet<string>> = {
	cninfo: new Set(["www.cninfo.com.cn", "static.cninfo.com.cn"]),
	hkex: new Set(["www1.hkexnews.hk", "www.hkexnews.hk"]),
	"sec-edgar": new Set(["data.sec.gov", "www.sec.gov"]),
};

export function safeProviderUrl(provider: InformationProvider, value: string, base?: string): string {
	const url = new URL(value.replace(/^http:\/\//u, "https://"), base);
	if (url.protocol !== "https:" || !PROVIDER_HOSTS[provider].has(url.hostname)) {
		throw new Error(`${provider} returned an unsupported URL: ${url.href}`);
	}
	return url.href;
}

export function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

export function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stripHtml(value: string): string {
	return value
		.replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
		.replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
		.replaceAll(/<\/?(?:p|div|table|tr|td|li|h[1-6])\b[^>]*>|<br\s*\/?>/giu, "\n")
		.replaceAll(/<[^>]+>/gu, " ")
		.replaceAll(/&nbsp;|&#160;/giu, " ")
		.replaceAll(/&amp;/giu, "&")
		.replaceAll(/&lt;/giu, "<")
		.replaceAll(/&gt;/giu, ">")
		.replaceAll(/&quot;|&#34;/giu, '"')
		.replaceAll(/&#39;|&apos;/giu, "'")
		.replaceAll(/&#x2f;/giu, "/")
		.replaceAll(/[ \t]+/gu, " ")
		.replaceAll(/\n\s+/gu, "\n")
		.trim();
}

export async function downloadDisclosure(
	disclosure: SourceDisclosure,
	request: FetchImplementation,
	userAgent: string,
	signal?: AbortSignal,
): Promise<DownloadedDisclosure> {
	const response = await request(disclosure.downloadUrl, {
		headers: {
			accept: "application/pdf, text/html, text/plain, application/xhtml+xml",
			"user-agent": userAgent,
		},
		redirect: "error",
		signal,
	});
	if (!response.ok) throw new Error(`${disclosure.provider} filing download failed with HTTP ${response.status}`);
	const retrievedUrl = safeProviderUrl(disclosure.provider, response.url || disclosure.downloadUrl);
	const reader = response.body?.getReader();
	if (!reader) throw new Error(`${disclosure.provider} filing download had no body`);
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > 50_000_000) throw new Error(`${disclosure.provider} filing exceeds the 50 MB limit`);
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	if (size === 0) throw new Error(`${disclosure.provider} filing download was empty`);
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const declared = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	const pdf = bytes.byteLength >= 5 && new TextDecoder("ascii").decode(bytes.subarray(0, 5)) === "%PDF-";
	if (declared === "application/pdf" && !pdf) {
		throw new Error(`${disclosure.provider} filing claimed to be PDF but was not a PDF`);
	}
	let contentType: string;
	if (pdf) contentType = "application/pdf";
	else if (["text/html", "application/xhtml+xml", "text/plain"].includes(declared || "")) {
		contentType = declared!;
	} else {
		let decoded: string;
		try {
			decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
		} catch {
			throw new Error(`${disclosure.provider} filing returned unsupported binary content`);
		}
		if (decoded.includes("\0")) throw new Error(`${disclosure.provider} filing returned unsupported binary content`);
		contentType = /^\s*(?:<!doctype\s+html|<html\b|<ix:)/iu.test(decoded) ? "text/html" : "text/plain";
	}
	return {
		disclosure,
		bytes,
		contentType,
		retrievedUrl,
	};
}
