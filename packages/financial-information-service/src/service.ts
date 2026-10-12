import { createHash } from "node:crypto";
import { CninfoAdapter } from "./adapters/cninfo.ts";
import { HkexAdapter } from "./adapters/hkex.ts";
import { SecEdgarAdapter } from "./adapters/sec-edgar.ts";
import { type DeliveryConfig, deliverPendingCandidates } from "./delivery.ts";
import type { FetchImplementation } from "./http.ts";
import type { InformationStore } from "./store.ts";
import type {
	InformationProvider,
	InformationSubscription,
	RunResult,
	SourceAdapter,
	SubscriptionInput,
} from "./types.ts";
import { validateDateRange, validateSubscriptionInput } from "./validation.ts";

function date(value: Date): string {
	return value.toISOString().slice(0, 10);
}

function subtractDays(value: Date, days: number): Date {
	return new Date(value.valueOf() - days * 86_400_000);
}

export interface InformationServiceOptions {
	store: InformationStore;
	secUserAgent: string;
	delivery?: DeliveryConfig;
	request?: FetchImplementation;
}

export class FinancialInformationService {
	readonly #store: InformationStore;
	readonly #delivery?: DeliveryConfig;
	readonly #request: FetchImplementation;
	readonly #adapters: ReadonlyMap<InformationProvider, SourceAdapter>;
	readonly #active = new Set<string>();

	constructor(options: InformationServiceOptions) {
		this.#store = options.store;
		this.#delivery = options.delivery;
		this.#request = options.request ?? fetch;
		const adapters: SourceAdapter[] = [
			new CninfoAdapter(this.#request),
			new HkexAdapter(this.#request),
			new SecEdgarAdapter(options.secUserAgent, this.#request),
		];
		this.#adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
	}

	createSubscription(input: SubscriptionInput): InformationSubscription {
		return this.#store.createSubscription(input);
	}

	listSubscriptions(): InformationSubscription[] {
		return this.#store.listSubscriptions();
	}

	listCandidates(status?: string) {
		return this.#store.listCandidates(status);
	}

	async runSubscription(id: string, signal?: AbortSignal): Promise<RunResult> {
		if (this.#active.has(id)) throw new Error(`Subscription is already running: ${id}`);
		this.#active.add(id);
		const subscription = this.#store.getSubscription(id);
		const run = this.#store.startRun(id);
		try {
			const result = await this.#run(subscription, run.id, run.startedAt, undefined, undefined, signal);
			this.#store.markSubscriptionChecked(subscription, result.finishedAt);
			this.#store.finishRun(result);
			await this.deliver(signal);
			return result;
		} catch (error) {
			this.#store.failRun(run.id, error);
			throw error;
		} finally {
			this.#active.delete(id);
		}
	}

	async runAdHoc(
		input: SubscriptionInput,
		startDate: string,
		endDate: string,
		signal?: AbortSignal,
	): Promise<RunResult> {
		validateDateRange(startDate, endDate);
		const config = validateSubscriptionInput({ ...input, enabled: false });
		const identity = createHash("sha256")
			.update(JSON.stringify({ ...config, startDate, endDate }))
			.digest("hex")
			.slice(0, 24);
		let subscription: InformationSubscription;
		try {
			subscription = this.#store.getSubscription(`adhoc-${identity}`);
		} catch {
			subscription = this.#store.createSubscription({ ...config, enabled: false }, `adhoc-${identity}`);
		}
		const run = this.#store.startRun(subscription.id);
		try {
			const result = await this.#run(subscription, run.id, run.startedAt, startDate, endDate, signal);
			this.#store.finishRun(result);
			await this.deliver(signal);
			return result;
		} catch (error) {
			this.#store.failRun(run.id, error);
			throw error;
		}
	}

	async runDue(signal?: AbortSignal): Promise<RunResult[]> {
		const results: RunResult[] = [];
		for (const subscription of this.#store.dueSubscriptions()) {
			signal?.throwIfAborted();
			if (this.#active.has(subscription.id)) continue;
			try {
				results.push(await this.runSubscription(subscription.id, signal));
			} catch (error) {
				if (signal?.aborted) throw error;
				this.#store.deferSubscription(subscription);
				console.error(`Information subscription ${subscription.id} failed`, error);
			}
		}
		await this.deliver(signal);
		return results;
	}

	deliver(signal?: AbortSignal) {
		return deliverPendingCandidates(this.#store, this.#delivery, this.#request, signal);
	}

	async #run(
		subscription: InformationSubscription,
		runId: string,
		startedAt: string,
		requestedStart: string | undefined,
		requestedEnd: string | undefined,
		signal?: AbortSignal,
	): Promise<RunResult> {
		const adapter = this.#adapters.get(subscription.provider);
		if (!adapter) throw new Error(`No adapter registered for ${subscription.provider}`);
		const endDate = requestedEnd ?? date(new Date());
		const startDate =
			requestedStart ??
			date(
				subscription.lastCheckedAt
					? subtractDays(new Date(subscription.lastCheckedAt), 2)
					: subtractDays(new Date(), subscription.lookbackDays),
			);
		validateDateRange(startDate, endDate);
		const disclosures = await adapter.discover(subscription, startDate, endDate, signal);
		let created = 0;
		let duplicates = 0;
		const candidateIds: string[] = [];
		for (const disclosure of disclosures) {
			signal?.throwIfAborted();
			const downloaded = await adapter.download(disclosure, signal);
			const saved = this.#store.saveDisclosure(subscription, downloaded);
			candidateIds.push(saved.candidate.id);
			if (saved.created) created++;
			else duplicates++;
		}
		return {
			runId,
			subscriptionId: subscription.id,
			provider: subscription.provider,
			discovered: disclosures.length,
			created,
			duplicates,
			candidateIds,
			startedAt,
			finishedAt: new Date().toISOString(),
		};
	}
}
