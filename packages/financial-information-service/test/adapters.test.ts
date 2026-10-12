import { expect, it, vi } from "vitest";
import { CninfoAdapter } from "../src/adapters/cninfo.ts";
import { HkexAdapter, parseHkexRows } from "../src/adapters/hkex.ts";
import { SecEdgarAdapter } from "../src/adapters/sec-edgar.ts";
import type { InformationSubscription } from "../src/types.ts";

function subscription(provider: InformationSubscription["provider"], securityCode: string): InformationSubscription {
	return {
		id: "subscription-1",
		datasetId: "dataset-1",
		provider,
		securityCode,
		intervalMinutes: 30,
		lookbackDays: 30,
		maxDocuments: 20,
		enabled: true,
		nextRunAt: 0,
		lastCheckedAt: null,
		createdAt: "2026-10-12T00:00:00.000Z",
		updatedAt: "2026-10-12T00:00:00.000Z",
	};
}

it("parses CNINFO official search results and filters the requested security", async () => {
	const request = vi.fn(
		async (_input: string | URL) =>
			new Response(
				JSON.stringify({
					hasMore: false,
					announcements: [
						{
							secCode: "600519",
							secName: "贵州茅台",
							announcementId: "1224906219",
							announcementTitle: "<em>贵州茅台</em>2025年年度报告",
							announcementTime: Date.parse("2026-03-30T00:00:00+08:00"),
							adjunctUrl: "finalpage/2026-03-30/1224906219.PDF",
							announcementType: "annual_report",
						},
						{
							secCode: "000001",
							secName: "Other",
							announcementId: "other",
							announcementTitle: "Other report",
							announcementTime: Date.now(),
							adjunctUrl: "finalpage/other.PDF",
						},
					],
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	const results = await new CninfoAdapter(request).discover(
		{ ...subscription("cninfo", "600519"), query: "贵州茅台 财务报告" },
		"2026-03-01",
		"2026-03-31",
	);
	expect(results).toHaveLength(1);
	expect(results[0]).toMatchObject({
		provider: "cninfo",
		externalId: "1224906219",
		securityCode: "600519",
		title: "贵州茅台 2025年年度报告",
	});
	expect(results[0].downloadUrl).toBe("https://static.cninfo.com.cn/finalpage/2026-03-30/1224906219.PDF");
	expect(String(request.mock.calls[0]?.[0])).toContain("searchkey=600519");
});

it("posts the verified HKEX title-search form and parses disclosure rows", async () => {
	const html = `<html><div class="total-records">Total records found: 1</div><table><tbody><tr>
	<td class="text-right release-time"><span class="mobile-list-heading">Release Time: </span>12/10/2026 08:00</td>
	<td class="stock-short-code"><span class="mobile-list-heading">Stock Code: </span>00700<br/>80700</td>
	<td class="stock-short-name"><span class="mobile-list-heading">Stock Short Name: </span>TENCENT<br/>TENCENT-R</td>
	<td><div class="headline">Financial Statements</div>
	<a href="/listedco/listconews/sehk/2026/1012/2026101200045.pdf">INTERIM RESULTS</a></td></tr></tbody></table></html>`;
	const parsed = parseHkexRows(html, subscription("hkex", "700"));
	expect(parsed[0]).toMatchObject({ externalId: "2026101200045", securityCode: "00700", issuer: "TENCENT" });
	const request = vi.fn(async (input: string | URL, init?: RequestInit) => {
		if (String(input).includes("activestock")) {
			return new Response(JSON.stringify([{ i: 7609, c: "00700", n: "TENCENT" }]));
		}
		expect(init?.method).toBe("POST");
		expect(String(init?.body)).toContain("stockId=7609");
		expect(String(init?.body)).toContain("from=20261001");
		return new Response(html, { headers: { "content-type": "text/html" } });
	});
	const results = await new HkexAdapter(request).discover(subscription("hkex", "700"), "2026-10-01", "2026-10-12");
	expect(results).toEqual(parsed);
});

it("uses SEC submissions with the required contact user-agent and form filtering", async () => {
	const request = vi.fn(async (_input: string | URL, init?: RequestInit) => {
		expect(init?.headers).toMatchObject({ "user-agent": "PE Workbench research@example.com" });
		return new Response(
			JSON.stringify({
				name: "Example Corp",
				filings: {
					recent: {
						accessionNumber: ["0000000001-26-000001", "0000000001-26-000002"],
						filingDate: ["2026-10-10", "2026-10-11"],
						form: ["10-Q", "8-K"],
						primaryDocument: ["quarter.htm", "event.htm"],
					},
				},
			}),
		);
	});
	const config = { ...subscription("sec-edgar", "1"), query: "10-Q" };
	const results = await new SecEdgarAdapter("PE Workbench research@example.com", request).discover(
		config,
		"2026-10-01",
		"2026-10-12",
	);
	expect(results).toHaveLength(1);
	expect(results[0]).toMatchObject({ externalId: "0000000001-26-000001", category: "10-Q" });
});

it("loads SEC historical submission shards when the requested range predates recent filings", async () => {
	const request = vi.fn(async (input: string | URL, init?: RequestInit) => {
		expect(init?.headers).toMatchObject({ "user-agent": "PE Workbench research@example.com" });
		if (String(input).endsWith("CIK0000000001.json")) {
			return Response.json({
				name: "Example Corp",
				filings: {
					recent: { accessionNumber: [], filingDate: [], form: [], primaryDocument: [] },
					files: [
						{ name: "CIK0000000001-submissions-001.json", filingFrom: "2024-01-01", filingTo: "2024-12-31" },
					],
				},
			});
		}
		return Response.json({
			accessionNumber: ["0000000001-24-000001"],
			filingDate: ["2024-08-10"],
			form: ["10-Q"],
			primaryDocument: ["quarter.htm"],
		});
	});
	const results = await new SecEdgarAdapter("PE Workbench research@example.com", request).discover(
		{ ...subscription("sec-edgar", "1"), query: "10-Q" },
		"2024-01-01",
		"2024-12-31",
	);

	expect(results).toHaveLength(1);
	expect(results[0]?.externalId).toBe("0000000001-24-000001");
	expect(request).toHaveBeenCalledTimes(2);
});
