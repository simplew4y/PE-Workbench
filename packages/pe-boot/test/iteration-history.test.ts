import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { createResearchDraft, publishResearchDraft } from "../src/research/framework.ts";
import {
	cancelFrameworkIteration,
	createFrameworkIteration,
	listFrameworkIterations,
} from "../src/research/iteration.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

it("paginates stable iteration history without dropping older runs or accepting foreign cursors", () => {
	const root = mkdtempSync(join(tmpdir(), "pe-iteration-history-"));
	try {
		mkdirSync(join(root, "meta"));
		const datasetId = "dataset_history";
		initializePeCollectionDatabase(join(root, "meta/collection.sqlite3"), { datasetId, name: "History" });
		const draft = createResearchDraft(root, datasetId, frameworkFixture(), [], null);
		const baseline = publishResearchDraft(root, datasetId, {
			draftId: draft.id,
			revision: 1,
			expectedVersionId: null,
			requestId: "baseline",
		});
		const ids: string[] = [];
		for (let index = 0; index < 103; index++) {
			const run = createFrameworkIteration(root, datasetId, {
				requestId: `run_${index}`,
				basisVersionId: baseline.id,
				modelId: "mock",
				uploadIdentity: "mock",
				changeReview: true,
			});
			ids.push(run.id);
			cancelFrameworkIteration(root, datasetId, run.id);
		}
		const first = listFrameworkIterations(root, datasetId);
		expect(first).toHaveLength(100);
		const second = listFrameworkIterations(root, datasetId, first.at(-1)!.id);
		expect(second).toHaveLength(3);
		expect([...first, ...second].map((run) => run.id)).toEqual([...ids].reverse());
		expect(listFrameworkIterations(root, datasetId, second.at(-1)!.id)).toEqual([]);
		expect(() => listFrameworkIterations(root, datasetId, "other-project-id")).toThrow("cursor not found");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
