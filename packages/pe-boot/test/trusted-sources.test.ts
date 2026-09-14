import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { preparePeDocument } from "../src/documents.ts";
import { resolvePeEvidenceSource } from "../src/evidence.ts";
import { createResearchDraft, publishResearchDraft } from "../src/research/framework.ts";
import { readResearchInput } from "../src/research/pi-engine.ts";
import { sourceId } from "../src/source.ts";
import { fetchWindSnapshot, listWindSnapshots, queryWind } from "../src/trusted-sources.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project() {
	const root = mkdtempSync(join(tmpdir(), "pe-wind-test-"));
	roots.push(root);
	mkdirSync(join(root, "raw"));
	mkdirSync(join(root, "meta"));
	initializePeCollectionDatabase(join(root, "meta/collection.sqlite3"), { datasetId: "dataset_test", name: "Test" });
	return root;
}
function mockWind(payload: unknown) {
	vi.stubEnv("WIND_API_KEY", "test-wind-key");
	const mock = vi.fn(async (_url: string, options: RequestInit) => {
		const request = JSON.parse(String(options.body));
		const result = request.method === "initialize" ? { protocolVersion: "2025-03-26" } : payload;
		return new Response(
			`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\r\n\r\n`,
			{ headers: { "mcp-session-id": "session-test" } },
		);
	});
	vi.stubGlobal("fetch", mock);
	return mock;
}
const response = (price: number) => ({
	content: [
		{
			type: "text",
			text: JSON.stringify({ data: { columns: ["price"], rows: [[price]], unit: "HKD" }, error: null }),
		},
	],
	isError: false,
});

it("saves immutable evidence, deduplicates, resolves historical citations and publishes a framework with snapshot inputs", async () => {
	const root = project();
	const mock = mockWind(response(400));
	const query = { category: "quote" as const, query: "0700.HK" };
	const first = await fetchWindSnapshot(root, query);
	expect(mock.mock.calls[1][1].headers).toMatchObject({
		Authorization: "Bearer test-wind-key",
		"Mcp-Session-Id": "session-test",
	});
	expect(first.status).toBe("saved");
	expect(first.preview).not.toContain("test-wind-key");
	expect((await fetchWindSnapshot(root, query)).docId).toBe(first.docId);
	expect(listWindSnapshots(root)).toHaveLength(1);
	const content = {
		title: "腾讯研究",
		objective: "验证增长",
		horizon: "一年",
		coverageGaps: [],
		items: [
			{
				id: "price",
				kind: "metric" as const,
				claim: "供应商返回价格400港元",
				rationale: "行情观察",
				subject: "腾讯",
				verification: "后续行情",
				invalidation: "价格变化",
				origin: "research" as const,
				evidenceIds: [first.evidenceId],
			},
		],
	};
	const draft = createResearchDraft(root, "dataset_test", content, [first.docId], null);
	const job = { objective: "test", inputs: draft.inputs, asOf: first.checkedAt };
	expect(readResearchInput(root, "dataset_test", job, { docId: first.docId })).toMatchObject({
		evidenceId: first.evidenceId,
	});
	const prepared = await preparePeDocument(root, { docId: first.docId });
	expect(readFileSync(prepared.readablePath, "utf8")).toContain("#pe-source");
	expect(prepared.document.parser_name).toBe("wind_snapshot");
	mockWind(response(401));
	const second = await fetchWindSnapshot(root, query);
	expect(second.version).toBe(2);
	expect(second.docId).not.toBe(first.docId);
	expect((await resolvePeEvidenceSource(root, first.evidenceId)).payload).toMatchObject({
		kind: "text",
		version_no: 1,
	});
	expect(
		publishResearchDraft(root, "dataset_test", {
			draftId: draft.id,
			revision: 1,
			expectedVersionId: null,
			requestId: "publish",
		}).inputs,
	).toEqual(draft.inputs);
	const forged = sourceId({ docId: first.docId, location: { kind: "text", lineStart: 1, lineEnd: 1999 } });
	await expect(resolvePeEvidenceSource(root, forged)).rejects.toThrow("lines");
	expect(() => createResearchDraft(root, "other", content, [first.docId], null)).toThrow("does not match");
	writeFileSync(prepared.filePath, "tampered");
	await expect(resolvePeEvidenceSource(root, first.evidenceId)).rejects.toThrow("modified");
});

it("never stores authentication or backend failures as research evidence", async () => {
	const root = project();
	mockWind({ content: [{ type: "text", text: JSON.stringify({ error: "quota exhausted test-wind-key" }) }] });
	await expect(fetchWindSnapshot(root, { category: "news", query: "腾讯 2026-09-14 新闻" })).rejects.toThrow(
		"WIND_BACKEND_ERROR",
	);
	expect(listWindSnapshots(root)).toHaveLength(0);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("secret", { status: 403 })),
	);
	await expect(queryWind({ category: "quote", query: "AAPL.O" })).rejects.toThrow("WIND_HTTP_403");
});

it("routes announcements with query and caps retrieval, without inferring full coverage", async () => {
	const root = project();
	const mock = mockWind({ content: [{ type: "text", text: "No matching documents" }], isError: false });
	const result = await fetchWindSnapshot(root, {
		category: "announcements",
		query: "Apple 2026-09-01 至 2026-09-14 高管变动公告",
	});
	expect(mock.mock.calls[1][0]).toBe("https://mcp.wind.com.cn/vserver_financial_docs/mcp/");
	expect(JSON.parse(String(mock.mock.calls[1][1].body)).params).toMatchObject({
		name: "get_company_announcements",
		arguments: { top_k: 5 },
	});
	expect(result.preview).toContain("query_result_not_exhaustive");
});

it("routes valuation computations to Alice Market and fetches again even when the evidence is unchanged", async () => {
	const root = project();
	const mock = mockWind(response(120));
	const query = { category: "analytics" as const, query: "0700.HK EPS 10 HKD，按同业 PE 8/12/15 倍计算情景价格" };
	const first = await fetchWindSnapshot(root, query);
	const second = await fetchWindSnapshot(root, query);
	expect(mock).toHaveBeenCalledTimes(4);
	expect(mock.mock.calls[1][0]).toBe("https://mcp.wind.com.cn/vserver_analytics_data/mcp/");
	expect(JSON.parse(String(mock.mock.calls[1][1].body)).params).toEqual({
		name: "get_financial_data",
		arguments: { question: query.query },
	});
	expect(second.docId).toBe(first.docId);
	expect(first.preview).toContain("computed_data");
});

it("makes the tail of long news responses accessible through bounded line citations", async () => {
	const root = project();
	mockWind({ content: [{ type: "text", text: `${"长".repeat(25000)}END_OF_NEWS` }], isError: false });
	const result = await fetchWindSnapshot(root, { category: "news", query: "腾讯 2026-09-14 新闻" });
	const snapshot = listWindSnapshots(root)[0];
	const prepared = await preparePeDocument(root, { docId: String(snapshot.doc_id) });
	const lines = readFileSync(prepared.filePath, "utf8").split("\n");
	const line = lines.findIndex((value) => value.includes("END_OF_NEWS")) + 1;
	const citation = sourceId({ docId: result.docId, location: { kind: "text", lineStart: line, lineEnd: line } });
	const resolved = await resolvePeEvidenceSource(root, citation);
	expect(resolved.payload).toMatchObject({ truncated: false });
	if (resolved.payload.kind === "text") expect(resolved.payload.content).toContain("END_OF_NEWS");
});
