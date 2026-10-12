import type { FetchImplementation } from "./http.ts";
import type { InformationStore } from "./store.ts";

export interface DeliveryConfig {
	workbenchUrl: string;
	token: string;
}

export async function deliverPendingCandidates(
	store: InformationStore,
	config: DeliveryConfig | undefined,
	request: FetchImplementation = fetch,
	signal?: AbortSignal,
): Promise<{ delivered: number; failed: number; skipped: number }> {
	const pending = store.pendingCandidates();
	if (!config) return { delivered: 0, failed: 0, skipped: pending.length };
	let delivered = 0;
	let failed = 0;
	for (const item of pending) {
		signal?.throwIfAborted();
		try {
			const form = new FormData();
			form.set("metadata", JSON.stringify(item.candidate));
			form.set("file", new File([item.bytes], item.candidate.filename, { type: item.candidate.contentType }));
			const response = await request(new URL("/api/pe/information-candidates", config.workbenchUrl), {
				method: "POST",
				headers: {
					authorization: `Bearer ${config.token}`,
					"idempotency-key": item.candidate.id,
				},
				body: form,
				signal,
			});
			if (!response.ok) {
				const detail = (await response.text()).slice(0, 1000);
				throw new Error(`PE-Workbench delivery failed with HTTP ${response.status}: ${detail}`);
			}
			store.markDelivered(item.candidate.id);
			delivered++;
		} catch (error) {
			store.markDeliveryFailed(item.candidate.id, item.attempts, error);
			failed++;
		}
	}
	return { delivered, failed, skipped: 0 };
}
