#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createResilientFetch } from "./resilient-fetch.ts";
import { createInformationHttpServer } from "./server.ts";
import { FinancialInformationService } from "./service.ts";
import { InformationStore } from "./store.ts";

const dataDirectory = resolve(process.env.FINANCIAL_INFORMATION_DATA_DIR || ".financial-information");
const port = Number(process.env.FINANCIAL_INFORMATION_PORT || "30241");
const token = process.env.FINANCIAL_INFORMATION_SERVICE_TOKEN?.trim() || "";
const secUserAgent = process.env.SEC_EDGAR_USER_AGENT?.trim() || "";
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid FINANCIAL_INFORMATION_PORT");
mkdirSync(dataDirectory, { recursive: true });
const store = new InformationStore(resolve(dataDirectory, "information.sqlite3"), dataDirectory);
const workbenchUrl = process.env.PE_WORKBENCH_URL?.trim();
const workbenchToken = process.env.PE_WORKBENCH_INGEST_TOKEN?.trim();
const service = new FinancialInformationService({
	store,
	secUserAgent,
	request: createResilientFetch(),
	...(workbenchUrl && workbenchToken ? { delivery: { workbenchUrl, token: workbenchToken } } : {}),
});
const server = createInformationHttpServer(service, token);
const controller = new AbortController();
const timer = setInterval(() => {
	service.runDue(controller.signal).catch((error) => console.error("Scheduled information run failed", error));
}, 30_000);
timer.unref();
server.listen(port, "127.0.0.1", () => {
	console.log(`Financial information service listening on http://127.0.0.1:${port}`);
});
for (const name of ["SIGINT", "SIGTERM"] as const) {
	process.once(name, () => {
		controller.abort();
		clearInterval(timer);
		server.close(() => {
			store.close();
			process.exit(0);
		});
	});
}
