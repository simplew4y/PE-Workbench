import { expect, it, vi } from "vitest";
import { downloadDisclosure } from "../src/http.ts";
import type { SourceDisclosure } from "../src/types.ts";

const disclosure: SourceDisclosure = {
	provider: "sec-edgar",
	externalId: "filing-1",
	securityCode: "0000000001",
	issuer: "Example",
	title: "10-Q filing",
	publishedAt: "2026-01-01T00:00:00.000Z",
	canonicalUrl: "https://www.sec.gov/Archives/filing-index.html",
	downloadUrl: "https://www.sec.gov/Archives/filing.htm",
};

it("normalizes textual filings served as generic content", async () => {
	const request = vi.fn(
		async () =>
			new Response("<!doctype html><html><body>Quarterly filing</body></html>", {
				headers: { "content-type": "application/octet-stream" },
			}),
	);
	const downloaded = await downloadDisclosure(disclosure, request, "Example test@example.com");
	expect(downloaded.contentType).toBe("text/html");
});

it("rejects unknown binary payloads instead of archiving them as evidence", async () => {
	const request = vi.fn(
		async () =>
			new Response(new Uint8Array([0, 159, 146, 150]), {
				headers: { "content-type": "application/octet-stream" },
			}),
	);
	await expect(downloadDisclosure(disclosure, request, "Example test@example.com")).rejects.toThrow(
		"unsupported binary content",
	);
});
