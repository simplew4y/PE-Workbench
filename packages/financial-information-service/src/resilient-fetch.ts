import { setTimeout as wait } from "node:timers/promises";
import type { FetchImplementation } from "./http.ts";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface ResilientFetchOptions {
	maxAttempts?: number;
	minimumIntervalMs?: (url: URL) => number;
	wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function retryAfterMilliseconds(response: Response, now = Date.now()): number | undefined {
	const value = response.headers.get("retry-after")?.trim();
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.min(Math.max(0, date - now), 60_000) : undefined;
}

function defaultMinimumInterval(url: URL): number {
	if (url.hostname === "data.sec.gov" || url.hostname === "www.sec.gov") return 150;
	if (url.hostname.endsWith("cninfo.com.cn") || url.hostname.endsWith("hkexnews.hk")) return 100;
	return 0;
}

export function createResilientFetch(
	request: FetchImplementation = fetch,
	options: ResilientFetchOptions = {},
): FetchImplementation {
	const maxAttempts = options.maxAttempts ?? 4;
	const minimumInterval = options.minimumIntervalMs ?? defaultMinimumInterval;
	const pause =
		options.wait ??
		(async (milliseconds: number, signal?: AbortSignal) => {
			if (milliseconds > 0) await wait(milliseconds, undefined, { signal });
		});
	const queues = new Map<string, Promise<void>>();
	const nextAllowedAt = new Map<string, number>();

	return async (input, init) => {
		const url = new URL(String(input));
		const origin = url.origin;
		const prior = queues.get(origin) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = prior.then(() => current);
		queues.set(origin, queued);
		await prior;
		try {
			let lastError: unknown;
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				init?.signal?.throwIfAborted();
				const delay = Math.max(0, (nextAllowedAt.get(origin) ?? 0) - Date.now());
				await pause(delay, init?.signal ?? undefined);
				nextAllowedAt.set(origin, Date.now() + minimumInterval(url));
				try {
					const response = await request(input, init);
					if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) return response;
					await response.body?.cancel().catch(() => undefined);
					const retryDelay = retryAfterMilliseconds(response) ?? Math.min(4000, 250 * 2 ** (attempt - 1));
					nextAllowedAt.set(origin, Math.max(nextAllowedAt.get(origin) ?? 0, Date.now() + retryDelay));
				} catch (error) {
					lastError = error;
					if (attempt === maxAttempts) throw error;
					nextAllowedAt.set(origin, Date.now() + Math.min(4000, 250 * 2 ** (attempt - 1)));
				}
			}
			throw lastError;
		} finally {
			release();
			if (queues.get(origin) === queued) queues.delete(origin);
		}
	};
}

export { retryAfterMilliseconds };
