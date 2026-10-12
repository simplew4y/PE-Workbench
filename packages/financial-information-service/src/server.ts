import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { FinancialInformationService } from "./service.ts";
import type { SubscriptionInput } from "./types.ts";

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}

function authorized(request: IncomingMessage, token: string): boolean {
	const value = request.headers.authorization;
	if (!value?.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(value.slice(7));
	const expected = Buffer.from(token);
	return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const value of request) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		size += chunk.byteLength;
		if (size > 1_000_000) throw new Error("Request body exceeds 1 MB");
		chunks.push(chunk);
	}
	const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("JSON object required");
	return parsed as Record<string, unknown>;
}

export function createInformationHttpServer(service: FinancialInformationService, token: string) {
	if (!token) throw new Error("FINANCIAL_INFORMATION_SERVICE_TOKEN is required");
	return createServer(async (request, response) => {
		try {
			const url = new URL(request.url || "/", "http://localhost");
			if (request.method === "GET" && url.pathname === "/health") {
				json(response, 200, { ok: true, service: "financial-information" });
				return;
			}
			if (!authorized(request, token)) {
				json(response, 401, { error: "Unauthorized" });
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/subscriptions") {
				json(response, 200, { subscriptions: service.listSubscriptions() });
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/subscriptions") {
				json(response, 201, {
					subscription: service.createSubscription((await body(request)) as unknown as SubscriptionInput),
				});
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/fetch") {
				const input = await body(request);
				const startDate = String(input.startDate || "");
				const endDate = String(input.endDate || "");
				const result = await service.runAdHoc(input as unknown as SubscriptionInput, startDate, endDate);
				json(response, 202, { run: result });
				return;
			}
			const run = /^\/v1\/subscriptions\/([^/]+)\/run$/u.exec(url.pathname);
			if (request.method === "POST" && run) {
				json(response, 202, { run: await service.runSubscription(decodeURIComponent(run[1])) });
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/candidates") {
				json(response, 200, { candidates: service.listCandidates(url.searchParams.get("status") || undefined) });
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/deliver") {
				json(response, 200, await service.deliver());
				return;
			}
			json(response, 404, { error: "Not found" });
		} catch (error) {
			json(response, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	});
}
