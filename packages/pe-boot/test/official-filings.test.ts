import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { resolvePeEvidenceSource } from "../src/evidence.ts";
import {
	fetchOfficialFilings,
	ingestOfficialFilingCandidate,
	type OfficialFilingCandidate,
} from "../src/official-filings.ts";
import { captureResearchInputs } from "../src/research/framework.ts";
import { openPeDataset } from "../src/tools/database.ts";

const roots: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "pe-official-filings-test-"));
	roots.push(root);
	mkdirSync(join(root, "raw"));
	mkdirSync(join(root, "meta"));
	initializePeCollectionDatabase(join(root, "meta/collection.sqlite3"), {
		datasetId: "dataset_test",
		name: "Test",
	});
	return root;
}

function candidate(bytes: Uint8Array): OfficialFilingCandidate {
	return {
		schemaVersion: 1,
		id: "candidate-1",
		subscriptionId: "subscription-1",
		datasetId: "dataset_test",
		provider: "sec-edgar",
		externalId: "0000000001-26-000001",
		securityCode: "0000000001",
		issuer: "Example Corp",
		title: "10-Q filing",
		category: "10-Q",
		publishedAt: "2026-10-10T00:00:00.000Z",
		canonicalUrl: "https://www.sec.gov/Archives/edgar/data/1/filing-index.html",
		retrievedUrl: "https://www.sec.gov/Archives/edgar/data/1/quarter.htm",
		contentHash: createHash("sha256").update(bytes).digest("hex"),
		contentType: "text/html",
		filename: "sec-edgar-filing.html",
		importance: "high",
		reasons: ["Quarterly filing"],
		requiresReview: true,
		createdAt: "2026-10-12T00:00:00.000Z",
	};
}

it("registers a delivered filing as immutable evidence and reuses identical content", async () => {
	const root = project();
	const bytes = new TextEncoder().encode(
		"<html><body><h1>Quarterly results</h1><p>Revenue was 120 million.</p><script>ignore()</script></body></html>",
	);
	const first = await ingestOfficialFilingCandidate(root, candidate(bytes), bytes);
	expect(first.evidenceId).toMatch(/^source:/u);
	const resolved = await resolvePeEvidenceSource(root, first.evidenceId);
	expect(resolved.payload).toMatchObject({ kind: "text", doc_id: first.docId, truncated: false });
	if (resolved.payload.kind === "text") {
		expect(resolved.payload.content).toContain("Revenue was 120 million");
		expect(resolved.payload.content).not.toContain("ignore()");
	}
	const connection = openPeDataset(root);
	try {
		expect(captureResearchInputs(connection.database, connection.datasetId, [first.docId])).toHaveLength(1);
	} finally {
		connection.database.close();
	}
	const second = await ingestOfficialFilingCandidate(root, candidate(bytes), bytes);
	expect(second.docId).toBe(first.docId);
});

it("routes manual official filing requests through the independent service", async () => {
	const root = project();
	vi.stubEnv("FINANCIAL_INFORMATION_SERVICE_URL", "http://127.0.0.1:30241");
	vi.stubEnv("FINANCIAL_INFORMATION_SERVICE_TOKEN", "service-secret");
	const request = vi.fn(async (input: string | URL, init?: RequestInit) => {
		expect(String(input)).toBe("http://127.0.0.1:30241/v1/fetch");
		expect(init?.headers).toMatchObject({ authorization: "Bearer service-secret" });
		expect(JSON.parse(String(init?.body))).toMatchObject({
			datasetId: "dataset_test",
			provider: "cninfo",
			securityCode: "600519",
		});
		return new Response(JSON.stringify({ run: { created: 1 } }), { status: 202 });
	});
	await expect(
		fetchOfficialFilings(
			root,
			{
				provider: "cninfo",
				securityCode: "600519",
				startDate: "2026-01-01",
				endDate: "2026-10-12",
			},
			undefined,
			request,
		),
	).resolves.toEqual({ run: { created: 1 } });
});

it("validates provider-specific identifiers before calling the service", async () => {
	const request = vi.fn();
	await expect(
		fetchOfficialFilings(
			project(),
			{ provider: "hkex", securityCode: "not-a-code", startDate: "2026-01-01", endDate: "2026-10-12" },
			undefined,
			request,
		),
	).rejects.toThrow("one to five digits");
	expect(request).not.toHaveBeenCalled();
});
