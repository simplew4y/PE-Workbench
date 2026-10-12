import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FinancialInformationService } from "../src/service.ts";
import { InformationStore } from "../src/store.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("archives, deduplicates, screens and delivers candidates through the outbox", async () => {
	const root = mkdtempSync(join(tmpdir(), "financial-information-test-"));
	roots.push(root);
	const store = new InformationStore(join(root, "information.sqlite3"), root);
	const delivered: string[] = [];
	const request = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith("https://data.sec.gov/")) {
			return new Response(
				JSON.stringify({
					name: "Example Corp",
					filings: {
						recent: {
							accessionNumber: ["0000000001-26-000001"],
							filingDate: ["2026-10-10"],
							form: ["10-Q"],
							primaryDocument: ["quarter.htm"],
						},
					},
				}),
			);
		}
		if (url.startsWith("https://www.sec.gov/")) {
			return new Response("<html><body><h1>Quarterly results</h1><p>Revenue 120 million</p></body></html>", {
				headers: { "content-type": "text/html" },
			});
		}
		if (url === "http://workbench.test/api/pe/information-candidates") {
			expect(init?.headers).toMatchObject({ authorization: "Bearer delivery-secret" });
			expect(init?.body).toBeInstanceOf(FormData);
			delivered.push(String((init?.body as FormData).get("metadata")));
			return new Response(JSON.stringify({ ok: true }), { status: 202 });
		}
		throw new Error(`Unexpected URL: ${url}`);
	});
	const service = new FinancialInformationService({
		store,
		secUserAgent: "PE Workbench research@example.com",
		delivery: { workbenchUrl: "http://workbench.test", token: "delivery-secret" },
		request,
	});
	const input = {
		datasetId: "dataset-1",
		provider: "sec-edgar" as const,
		securityCode: "1",
		query: "10-Q",
		enabled: false,
	};
	const first = await service.runAdHoc(input, "2026-10-01", "2026-10-12");
	const second = await service.runAdHoc(input, "2026-10-01", "2026-10-12");
	expect(first).toMatchObject({ discovered: 1, created: 1, duplicates: 0 });
	expect(second).toMatchObject({ discovered: 1, created: 0, duplicates: 1 });
	expect(delivered).toHaveLength(1);
	const candidates = service.listCandidates();
	expect(candidates).toHaveLength(1);
	expect(candidates[0]).toMatchObject({
		importance: "high",
		requiresReview: true,
		contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
	});
	store.close();
});

it("isolates a failed scheduled subscription and continues with the remaining sources", async () => {
	const root = mkdtempSync(join(tmpdir(), "financial-information-scheduler-"));
	roots.push(root);
	const store = new InformationStore(join(root, "information.sqlite3"), root);
	const request = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("fulltextSearch")) return new Response("upstream unavailable", { status: 503 });
		if (url.includes("CIK0000320193.json")) {
			return Response.json({
				name: "Apple Inc.",
				filings: {
					recent: {
						accessionNumber: ["0000320193-26-000001"],
						filingDate: ["2026-10-12"],
						form: ["10-Q"],
						primaryDocument: ["aapl-20260926.htm"],
					},
				},
			});
		}
		if (url.includes("aapl-20260926.htm")) {
			return new Response("<html><body>filing</body></html>", {
				headers: { "content-type": "text/html" },
			});
		}
		throw new Error(`Unexpected URL: ${url}`);
	});
	const service = new FinancialInformationService({
		store,
		secUserAgent: "PE Workbench test@example.com",
		request,
	});
	service.createSubscription({ datasetId: "dataset", provider: "cninfo", securityCode: "600519" });
	service.createSubscription({
		datasetId: "dataset",
		provider: "sec-edgar",
		securityCode: "320193",
		query: "10-Q",
	});

	const results = await service.runDue();

	expect(results).toHaveLength(1);
	expect(results[0]?.provider).toBe("sec-edgar");
	expect(store.dueSubscriptions()).toHaveLength(0);
	store.close();
});
