import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
	captureResearchInputs,
	createResearchDraftAsync,
	getResearchFramework,
	publishResearchDraftAsync,
} from "./framework.ts";
import { getFrameworkIteration, validateIterationRevision } from "./iteration.ts";
import type { FrameworkIteration, IterationImpacts, IterationObservations } from "./iteration-model.ts";
import { type FrameworkContent, isFrameworkDocument, ResearchError, validateFrameworkContent } from "./model.ts";
import { researchTransaction, withResearchDatabase } from "./storage.ts";

export type IterationChangeDecision = "pending" | "accepted" | "rejected";
export interface IterationChange {
	id: string;
	path: string[];
	section: string;
	groupId: string;
	judgmentIds: string[];
	evidenceIds: string[];
	observationIds: string[];
	reasons: string[];
	before: unknown;
	after: unknown;
	beforeExists: boolean;
	afterExists: boolean;
	/** Related groups are review hints, not mandatory acceptance dependencies. */
	dependencies: string[];
}
export interface IterationReviewPlan {
	id: string;
	runId: string;
	basisVersionId: string;
	modelId: string;
	processorVersion: string;
	documents: { docId: string; filename: string; version: number }[];
	changes: IterationChange[];
	createdAt: string;
}
export interface IterationReviewEvent {
	revision: number;
	changeIds: string[];
	decision: IterationChangeDecision;
	note: string;
	actorId: string;
	at: string;
}
export interface IterationChangeReview {
	plan: IterationReviewPlan;
	revision: number;
	decisions: Record<string, { decision: IterationChangeDecision; note: string; at: string; actorId: string }>;
	events: IterationReviewEvent[];
	preview: FrameworkContent | null;
	errors: string[];
	warnings: string[];
	publication: { versionId: string; revision: number; at: string; actorId: string | null } | null;
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS framework_iteration_review_plans(
 plan_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,dataset_id TEXT NOT NULL,plan_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS framework_iteration_review_events(
 plan_id TEXT NOT NULL,revision INTEGER NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(plan_id,revision)
);
CREATE TABLE IF NOT EXISTS framework_iteration_review_publications(
 plan_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,version_id TEXT NOT NULL,receipt_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS framework_iteration_review_drafts(
 plan_id TEXT NOT NULL,revision INTEGER NOT NULL,draft_id TEXT NOT NULL,
 content_json TEXT NOT NULL,inputs_json TEXT NOT NULL,PRIMARY KEY(plan_id,revision)
);
CREATE TRIGGER IF NOT EXISTS iteration_review_plan_no_update BEFORE UPDATE ON framework_iteration_review_plans BEGIN SELECT RAISE(ABORT,'Review plans are immutable'); END;
CREATE TRIGGER IF NOT EXISTS iteration_review_plan_no_delete BEFORE DELETE ON framework_iteration_review_plans BEGIN SELECT RAISE(ABORT,'Review plans are immutable'); END;
CREATE TRIGGER IF NOT EXISTS iteration_review_event_no_update BEFORE UPDATE ON framework_iteration_review_events BEGIN SELECT RAISE(ABORT,'Review events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS iteration_review_event_no_delete BEFORE DELETE ON framework_iteration_review_events BEGIN SELECT RAISE(ABORT,'Review events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS iteration_review_publication_no_update BEFORE UPDATE ON framework_iteration_review_publications BEGIN SELECT RAISE(ABORT,'Review receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS iteration_review_publication_no_delete BEFORE DELETE ON framework_iteration_review_publications BEGIN SELECT RAISE(ABORT,'Review receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS iteration_review_draft_no_update BEFORE UPDATE ON framework_iteration_review_drafts BEGIN SELECT RAISE(ABORT,'Review drafts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS iteration_review_draft_no_delete BEFORE DELETE ON framework_iteration_review_drafts BEGIN SELECT RAISE(ABORT,'Review drafts are immutable'); END;`;
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
function references(value: unknown): string[] {
	if (Array.isArray(value)) return [...new Set(value.flatMap(references))];
	if (!record(value)) return [];
	return [
		...new Set([
			...strings(value.evidenceIds),
			...strings(value.counterEvidenceIds),
			...(typeof value.evidenceId === "string" ? [value.evidenceId] : []),
			...Object.values(value).flatMap(references),
		]),
	];
}
export function buildIterationChanges(
	basis: FrameworkContent,
	candidate: FrameworkContent,
	impacts: IterationImpacts,
): IterationChange[] {
	const changes: IterationChange[] = [];
	function visit(
		before: unknown,
		after: unknown,
		path: string[],
		ownerIds: string[] = [],
		ownerEvidence: string[] = [],
	): void {
		if (isDeepStrictEqual(before, after)) return;
		if (path[1] === "evidenceAndChanges" && path[2] === "changes") return;
		const section = path[1] || "document";
		const object = record(after) ? after : record(before) ? before : null;
		const judgmentIds =
			object && path.includes("investmentJudgments") && typeof object.id === "string"
				? [object.id]
				: object && Array.isArray(object.judgmentIds)
					? strings(object.judgmentIds)
					: ownerIds;
		const evidence = object ? references(object) : ownerEvidence;
		if (record(before) && record(after)) {
			for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
				visit(before[key], after[key], [...path, key], judgmentIds, evidence);
			return;
		}
		if (Array.isArray(before) && Array.isArray(after)) {
			const combined = [...before, ...after];
			const key =
				combined.length && combined.every((entry) => record(entry) && typeof entry.id === "string")
					? "id"
					: combined.length && combined.every((entry) => record(entry) && typeof entry.evidenceId === "string")
						? "evidenceId"
						: null;
			if (key) {
				const old = new Map(before.map((entry) => [String((entry as Record<string, unknown>)[key]), entry]));
				const next = new Map(after.map((entry) => [String((entry as Record<string, unknown>)[key]), entry]));
				if (old.size === before.length && next.size === after.length) {
					for (const id of new Set([...old.keys(), ...next.keys()]))
						visit(old.get(id), next.get(id), [...path, `@${key}:${id}`], judgmentIds, evidence);
					const appliedOrder = [...old.keys()]
						.filter((id) => next.has(id))
						.concat([...next.keys()].filter((id) => !old.has(id)));
					if (!isDeepStrictEqual(appliedOrder, [...next.keys()])) {
						visit(
							[...old.keys()],
							[...next.keys()],
							[...path, `@order:${key}`],
							section === "investmentJudgments" ? [...new Set([...old.keys(), ...next.keys()])] : judgmentIds,
							evidence,
						);
					}
					return;
				}
			}
		}
		const direct = impacts.impacts.filter(
			(impact) =>
				impact.proposedChange &&
				(judgmentIds.length
					? impact.judgmentIds.some((id) => judgmentIds.includes(id))
					: impact.sections.includes(section)),
		);
		const related = direct.length
			? direct
			: impacts.impacts.filter(
					(impact) =>
						impact.proposedChange &&
						impact.sections.includes(section) &&
						impact.evidenceIds.some((id) => evidence.includes(id)),
				);
		const newJudgment =
			section === "investmentJudgments" &&
			judgmentIds.some((id) => !basis.sections.investmentJudgments.items.some((item) => item.id === id));
		const ids = judgmentIds.length
			? [...new Set([...judgmentIds, ...(newJudgment ? related.flatMap((impact) => impact.judgmentIds) : [])])]
			: ["currentAssessment", "researchSetup", "evidenceAndChanges"].includes(section)
				? []
				: [...new Set(related.flatMap((impact) => impact.judgmentIds))];
		const sourcePosition = path.find((segment) => segment.startsWith("@evidenceId:"));
		const groupId = ids.length
			? `judgments:${[...ids].sort().join(",")}`
			: section === "evidenceAndChanges"
				? sourcePosition
					? `catalog:${sourcePosition.slice(12)}`
					: `metadata:${path.slice(1, 4).join("/")}`
				: `section:${section}`;
		changes.push({
			id: createHash("sha256").update(JSON.stringify({ path, before, after })).digest("hex").slice(0, 24),
			path,
			section,
			groupId,
			judgmentIds: ids,
			evidenceIds: [
				...new Set([...evidence, ...references(after), ...related.flatMap((impact) => impact.evidenceIds)]),
			],
			observationIds: [...new Set(related.flatMap((impact) => impact.observationIds))],
			reasons: [...new Set(related.map((impact) => impact.reason))],
			before: before ?? null,
			after: after ?? null,
			beforeExists: before !== undefined,
			afterExists: after !== undefined,
			dependencies: [],
		});
	}
	visit(basis, candidate, []);
	for (const change of changes) {
		change.dependencies = [
			...new Set(
				changes
					.filter(
						(other) =>
							other.groupId !== change.groupId &&
							(change.section === "currentAssessment"
								? other.judgmentIds.length > 0
								: change.judgmentIds.some((id) => other.judgmentIds.includes(id))),
					)
					.map((other) => other.groupId),
			),
		];
	}
	return changes;
}
function applyChange(content: FrameworkContent, change: IterationChange): void {
	let parent: unknown = content;
	for (const segment of change.path.slice(0, -1)) {
		if (segment.startsWith("@") && Array.isArray(parent)) {
			const separator = segment.indexOf(":");
			const key = segment.slice(1, separator),
				value = segment.slice(separator + 1);
			parent = parent.find((entry) => record(entry) && entry[key] === value);
		} else if (record(parent)) parent = parent[segment];
		else throw new ResearchError(409, "修改位置不再存在，请重新生成。");
	}
	const last = change.path.at(-1)!;
	if (last.startsWith("@order:") && Array.isArray(parent)) {
		const key = last.slice(7);
		const entries = new Map(parent.map((entry) => [record(entry) ? String(entry[key]) : "", entry]));
		const order = strings(change.after);
		if (order.length !== parent.length || order.some((id) => !entries.has(id)))
			throw new ResearchError(409, "排序修改依赖的新增或删除内容未被采用，请同时审查这些位置。");
		parent.splice(0, parent.length, ...order.map((id) => entries.get(id)));
	} else if (last.startsWith("@") && Array.isArray(parent)) {
		const separator = last.indexOf(":"),
			key = last.slice(1, separator),
			value = last.slice(separator + 1);
		const index = parent.findIndex((entry) => record(entry) && entry[key] === value);
		if (!change.afterExists) {
			if (index >= 0) parent.splice(index, 1);
		} else if (index < 0) parent.push(structuredClone(change.after));
		else parent[index] = structuredClone(change.after);
	} else if (record(parent)) {
		if (change.afterExists) parent[last] = structuredClone(change.after);
		else delete parent[last];
	} else throw new ResearchError(409, "修改位置无效。");
}
function proposal(cwd: string, datasetId: string, run: FrameworkIteration) {
	const state = getResearchFramework(cwd, datasetId);
	const basis = state.versions.find((version) => version.id === run.basisVersionId)?.content;
	const candidate = run.artifacts.find((artifact) => artifact.stage === "revise")?.value;
	const impacts = run.artifacts.find((artifact) => artifact.stage === "impact")?.value as IterationImpacts | undefined;
	const observations = run.artifacts.find((artifact) => artifact.stage === "extract")?.value as
		| IterationObservations
		| undefined;
	if (!basis || !isFrameworkDocument(basis) || !candidate || !impacts || !observations) return null;
	return {
		basis,
		candidate: validateFrameworkContent(candidate),
		impacts,
		observations,
		published: state.versions.find((version) => version.id === run.versionId)?.content,
	};
}
function readEvents(db: DatabaseSync, planId: string): IterationReviewEvent[] {
	return db
		.prepare("SELECT event_json FROM framework_iteration_review_events WHERE plan_id=? ORDER BY revision")
		.all(planId)
		.map((row) => JSON.parse(String(row.event_json)) as IterationReviewEvent);
}
/** Assemble exactly the selected fields; the generation validator checks the resulting document. */
export function assembleIterationReview(
	basis: FrameworkContent,
	candidate: FrameworkContent,
	impacts: IterationImpacts,
	observations: IterationObservations,
	changes: IterationChange[],
	decisions: IterationChangeReview["decisions"],
): Pick<IterationChangeReview, "preview" | "errors" | "warnings"> {
	const accepted = changes.filter((change) => decisions[change.id].decision === "accepted");
	const pending = changes.filter((change) => decisions[change.id].decision === "pending");
	const errors = pending.length ? [`还有 ${pending.length} 处修改尚未决定。`] : [];
	const warnings: string[] = [];
	if (!accepted.length) return { preview: null, errors, warnings };
	const partial = accepted.length !== changes.length;
	if (partial) {
		warnings.push(
			"部分采纳：仅应用已接受的修改，其余字段沿用基线。未执行新的模型语义审核，请核对判断、依据、估值和监控的一致性。",
		);
		if (!accepted.some((change) => change.section === "currentAssessment"))
			warnings.push("整体摘要沿用基线，尚未根据本轮实际采用内容重新综合。");
		const related = changes.filter(
			(change) =>
				decisions[change.id].decision !== "accepted" &&
				accepted.some((entry) => entry.groupId === change.groupId || entry.dependencies.includes(change.groupId)),
		);
		if (related.length)
			warnings.push(
				`有 ${related.length} 处关联建议未采用或尚未决定。关联位置可以分别决定，请核查配套内容是否仍成立。`,
			);
	}
	try {
		const assembled = structuredClone(basis);
		for (const change of accepted) applyChange(assembled, change);
		const changedItems = assembled.sections.investmentJudgments.items.filter(
			(item) =>
				!isDeepStrictEqual(
					item,
					basis.sections.investmentJudgments.items.find((before) => before.id === item.id),
				),
		);
		const changedIds = new Set(changedItems.map((item) => item.id));
		for (const item of changedItems) {
			const existing = basis.sections.investmentJudgments.items.some((before) => before.id === item.id);
			const supporting = impacts.impacts.filter(
				(impact) => impact.proposedChange && (!existing || impact.judgmentIds.includes(item.id)),
			);
			if (!references(item).some((id) => supporting.some((impact) => impact.evidenceIds.includes(id))))
				throw new ResearchError(
					400,
					`判断 ${item.id} 的已采用修改缺少本轮证据；请审查该判断的来源关联或反面证据。`,
				);
		}
		if (partial) {
			assembled.sections.evidenceAndChanges.changes = changedItems.map((item) => {
				const before = basis.sections.investmentJudgments.items.find((entry) => entry.id === item.id);
				const usedEvidence = references(item);
				const supportingEvidence = impacts.impacts
					.filter((impact) => impact.proposedChange && (!before || impact.judgmentIds.includes(item.id)))
					.flatMap((impact) => impact.evidenceIds);
				const adopted = accepted.filter(
					(change) => change.section === "investmentJudgments" && change.path.includes(`@id:${item.id}`),
				);
				return {
					judgmentIds: [item.id],
					before: before?.claim || "原框架没有该判断。",
					after: item.claim,
					reason:
						`逐项审查采用 ${adopted.length} 处修改：${adopted.map((change) => change.path.slice(4).join("/") || "新增判断").join("、")}。${before?.claim === item.claim ? "判断正文保留基线。" : ""}完整差异、模型建议理由及审查备注见本轮审查记录。`.slice(
							0,
							8000,
						),
					evidenceIds: [
						...new Set([...usedEvidence.filter((id) => supportingEvidence.includes(id)), ...usedEvidence]),
					].slice(0, 100),
				};
			});
			if (!changedItems.length)
				assembled.sections.evidenceAndChanges.changes = [
					{
						judgmentIds: [],
						before: "原框架对应字段。",
						after: "仅采用逐项审查通过的配套修改，投资判断正文保留基线。",
						reason:
							`逐项审查采用 ${accepted.length} 处修改：${accepted.map((change) => change.path.slice(1).join("/")).join("、")}。完整差异、来源和备注见本轮审查记录。`.slice(
								0,
								8000,
							),
						evidenceIds: [
							...new Set(
								accepted.flatMap((change) => {
									const key = change.path.at(-1);
									const source = change.path.find((segment) => segment.startsWith("@evidenceId:"));
									return [
										...references(change.after),
										...(key === "evidenceIds" || key === "counterEvidenceIds" ? strings(change.after) : []),
										...(source ? [source.slice(12)] : []),
									];
								}),
							),
						].slice(0, 100),
					},
				];
		} else assembled.sections.evidenceAndChanges.changes = candidate.sections.evidenceAndChanges.changes;
		const filtered: IterationImpacts = {
			...impacts,
			impacts: impacts.impacts.flatMap((impact) => {
				if (!impact.proposedChange) return [];
				const supportsNewItem = changedItems.some(
					(item) =>
						!basis.sections.investmentJudgments.items.some((before) => before.id === item.id) &&
						references(item).some((id) => impact.evidenceIds.includes(id)),
				);
				const sections = impact.sections.filter((section) => {
					if (
						section === "investmentJudgments" &&
						impact.judgmentIds.length &&
						changedItems.length &&
						!supportsNewItem &&
						!impact.judgmentIds.some((id) => changedIds.has(id))
					)
						return false;
					return !isDeepStrictEqual(
						basis.sections[section as keyof FrameworkContent["sections"]],
						assembled.sections[section as keyof FrameworkContent["sections"]],
					);
				});
				return sections.length
					? [
							{
								...impact,
								sections,
								judgmentIds: sections.includes("investmentJudgments")
									? impact.judgmentIds.filter((id) => changedIds.has(id))
									: [],
							},
						]
					: [];
			}),
		};
		const preview = validateFrameworkContent(assembled);
		validateIterationRevision(basis, preview, filtered, observations);
		return { preview, errors, warnings };
	} catch (error) {
		errors.push(error instanceof Error ? error.message : "组装框架校验失败");
		return { preview: null, errors: [...new Set(errors)], warnings };
	}
}
export function getIterationChangeReview(
	cwd: string,
	datasetId: string,
	run: FrameworkIteration,
): IterationChangeReview | null {
	const source = proposal(cwd, datasetId, run);
	if (!source) return null;
	const planId = createHash("sha256")
		.update(
			JSON.stringify({
				reviewFormat: 3,
				runId: run.id,
				basis: run.basisVersionId,
				inputs: run.inputs,
				modelId: run.modelId,
				processorVersion: run.processorVersion,
				candidate: source.candidate,
				impacts: source.impacts,
				observations: source.observations,
			}),
		)
		.digest("hex");
	const stored = withResearchDatabase(cwd, datasetId, (db) => {
		db.exec(SCHEMA);
		// A completed review keeps its original plan even when the diff algorithm changes.
		const receiptPlan = run.versionId
			? db
					.prepare("SELECT plan_id FROM framework_iteration_review_publications WHERE version_id=?")
					.get(run.versionId)
			: undefined;
		const effectivePlanId = receiptPlan ? String(receiptPlan.plan_id) : planId;
		const plan: IterationReviewPlan = {
			id: effectivePlanId,
			runId: run.id,
			basisVersionId: run.basisVersionId,
			modelId: run.modelId,
			processorVersion: run.processorVersion,
			documents: run.inputs.map((input) => {
				const document = db
					.prepare("SELECT original_filename FROM documents WHERE dataset_id=? AND doc_id=?")
					.get(datasetId, input.docId);
				return {
					docId: input.docId,
					filename: String(document?.original_filename || input.docId),
					version: input.version,
				};
			}),
			changes: buildIterationChanges(source.basis, source.candidate, source.impacts),
			createdAt: new Date().toISOString(),
		};
		db.prepare("INSERT OR IGNORE INTO framework_iteration_review_plans VALUES(?,?,?,?)").run(
			effectivePlanId,
			run.id,
			datasetId,
			JSON.stringify(plan),
		);
		const row = db
			.prepare("SELECT plan_json FROM framework_iteration_review_plans WHERE plan_id=? AND dataset_id=?")
			.get(effectivePlanId, datasetId)!;
		const receipt = db
			.prepare("SELECT receipt_json FROM framework_iteration_review_publications WHERE plan_id=?")
			.get(effectivePlanId);
		return {
			plan: JSON.parse(String(row.plan_json)) as IterationReviewPlan,
			events: readEvents(db, effectivePlanId),
			publication: receipt
				? (JSON.parse(String(receipt.receipt_json)) as IterationChangeReview["publication"])
				: null,
		};
	});
	const decisions: IterationChangeReview["decisions"] = {};
	for (const change of stored.plan.changes)
		decisions[change.id] = { decision: "pending", note: "", at: "", actorId: "" };
	for (const event of stored.events)
		for (const id of event.changeIds)
			decisions[id] = { decision: event.decision, note: event.note, at: event.at, actorId: event.actorId };
	if (stored.publication)
		return {
			...stored,
			revision: stored.publication.revision,
			decisions,
			preview: source.published && isFrameworkDocument(source.published) ? source.published : null,
			errors: [],
			warnings: stored.plan.changes.some((change) => decisions[change.id].decision !== "accepted")
				? ["本版本仅采用部分修改，其余字段沿用基线；未执行新的模型语义审核，完整差异和决定见审查轨迹。"]
				: [],
		};
	return {
		...stored,
		revision: stored.events.at(-1)?.revision || 0,
		decisions,
		...assembleIterationReview(
			source.basis,
			source.candidate,
			source.impacts,
			source.observations,
			stored.plan.changes,
			decisions,
		),
	};
}
export function listIterationChangeReviewHistory(
	cwd: string,
	datasetId: string,
	runId: string,
): {
	plan: IterationReviewPlan;
	events: IterationReviewEvent[];
	publication: IterationChangeReview["publication"];
}[] {
	getFrameworkIteration(cwd, datasetId, runId);
	return withResearchDatabase(cwd, datasetId, (db) => {
		db.exec(SCHEMA);
		return db
			.prepare(
				"SELECT plan_json FROM framework_iteration_review_plans WHERE dataset_id=? AND run_id=? ORDER BY rowid",
			)
			.all(datasetId, runId)
			.map((row) => {
				const plan = JSON.parse(String(row.plan_json)) as IterationReviewPlan;
				const receipt = db
					.prepare("SELECT receipt_json FROM framework_iteration_review_publications WHERE plan_id=?")
					.get(plan.id);
				return {
					plan,
					events: readEvents(db, plan.id),
					publication: receipt
						? (JSON.parse(String(receipt.receipt_json)) as IterationChangeReview["publication"])
						: null,
				};
			});
	});
}
export function saveIterationChangeDecisions(
	cwd: string,
	datasetId: string,
	run: FrameworkIteration,
	input: { planId: string; revision: number; changeIds: string[]; decision: IterationChangeDecision; note: string },
	actorId: string,
): IterationChangeReview {
	run = getFrameworkIteration(cwd, datasetId, run.id);
	const review = getIterationChangeReview(cwd, datasetId, run);
	if (!review || review.plan.id !== input.planId) throw new ResearchError(409, "候选版本已变化，请刷新审查。");
	if (
		!Number.isSafeInteger(input.revision) ||
		input.revision < 0 ||
		!["accepted", "rejected", "pending"].includes(input.decision) ||
		!input.changeIds.length ||
		input.note.length > 2000 ||
		!actorId
	)
		throw new ResearchError(400, "无效审查决定。");
	const selected = review.plan.changes.filter((change) => input.changeIds.includes(change.id));
	if (selected.length !== new Set(input.changeIds).size) throw new ResearchError(400, "包含未知修改位置。");
	const changeIds = selected.map((change) => change.id);
	withResearchDatabase(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			const row = db
				.prepare("SELECT status,record_json FROM framework_iterations WHERE dataset_id=? AND id=?")
				.get(datasetId, run.id);
			if (row?.status !== "review_required") throw new ResearchError(409, "当前运行不允许修改审查决定。");
			const events = readEvents(db, review.plan.id);
			if ((events.at(-1)?.revision || 0) !== input.revision)
				throw new ResearchError(409, "审查记录已变化，请刷新后重试。");
			const event: IterationReviewEvent = {
				revision: input.revision + 1,
				changeIds,
				decision: input.decision,
				note: input.note,
				actorId,
				at: new Date().toISOString(),
			};
			db.prepare("INSERT INTO framework_iteration_review_events VALUES(?,?,?)").run(
				review.plan.id,
				event.revision,
				JSON.stringify(event),
			);
			// Enrolling an existing pending run also fences its old whole-draft confirmation path.
			db.prepare(
				"UPDATE framework_iterations SET record_json=json_set(record_json,'$.changeReview',json('true'),'$.automatic',json('false'),'$.updatedAt',?) WHERE dataset_id=? AND id=?",
			).run(event.at, datasetId, run.id);
		}),
	);
	return getIterationChangeReview(cwd, datasetId, run)!;
}
export async function publishIterationChangeReview(
	cwd: string,
	datasetId: string,
	run: FrameworkIteration,
	input: { planId: string; revision: number; acknowledgeWarnings: boolean; actorId?: string },
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	run = getFrameworkIteration(cwd, datasetId, run.id);
	const review = getIterationChangeReview(cwd, datasetId, run);
	if (!review || review.plan.id !== input.planId || review.revision !== input.revision)
		throw new ResearchError(409, "审查记录已变化，请刷新。");
	if (review.publication) return review.publication.versionId;
	if (run.status !== "review_required" || review.errors.length || !review.preview)
		throw new ResearchError(409, review.errors.join("\n") || "没有可发布的已接受修改。");
	if (review.warnings.length && !input.acknowledgeWarnings)
		throw new ResearchError(409, "请先核查并确认部分采纳的限制。");
	const prepared = withResearchDatabase(cwd, datasetId, (db) =>
		db
			.prepare("SELECT draft_id,content_json FROM framework_iteration_review_drafts WHERE plan_id=? AND revision=?")
			.get(review.plan.id, review.revision),
	);
	if (prepared && prepared.content_json !== JSON.stringify(review.preview))
		throw new ResearchError(409, "组装规则已变化，请重新保存一次审查决定后发布；原记录保留。");
	let draftId = prepared ? String(prepared.draft_id) : null;
	if (!draftId) {
		if (
			JSON.stringify(
				withResearchDatabase(cwd, datasetId, (db) =>
					captureResearchInputs(
						db,
						datasetId,
						run.inputs.map((entry) => entry.docId),
					),
				),
			) !== JSON.stringify(run.inputs)
		)
			throw new ResearchError(409, "冻结证据已变化，请新建运行。");
		const candidate = await createResearchDraftAsync(
			cwd,
			datasetId,
			review.preview,
			run.inputs.map((entry) => entry.docId),
			run.basisVersionId,
			{ signal },
		);
		try {
			draftId = withResearchDatabase(cwd, datasetId, (db) =>
				researchTransaction(db, () => {
					signal.throwIfAborted();
					const existing = db
						.prepare("SELECT draft_id FROM framework_iteration_review_drafts WHERE plan_id=? AND revision=?")
						.get(review.plan.id, review.revision);
					if (existing) {
						db.prepare(
							"UPDATE research_drafts SET status='rejected',revision=revision+1 WHERE draft_id=? AND status='open'",
						).run(candidate.id);
						return String(existing.draft_id);
					}
					const row = db
						.prepare("SELECT record_json,status FROM framework_iterations WHERE id=? AND dataset_id=?")
						.get(run.id, datasetId);
					if (
						row?.status !== "review_required" ||
						(readEvents(db, review.plan.id).at(-1)?.revision || 0) !== review.revision
					)
						throw new ResearchError(409, "运行或审查决定已变化，草稿保留。");
					if (JSON.stringify(candidate.inputs) !== JSON.stringify(run.inputs))
						throw new ResearchError(409, "冻结证据已变化，请新建运行。");
					const value = JSON.parse(String(row.record_json)) as FrameworkIteration;
					if (value.draftId)
						db.prepare(
							"UPDATE research_drafts SET status='rejected',revision=revision+1 WHERE draft_id=? AND status='open'",
						).run(value.draftId);
					value.draftId = candidate.id;
					value.automatic = false;
					value.changeReview = true;
					db.prepare("INSERT INTO framework_iteration_review_drafts VALUES(?,?,?,?,?)").run(
						review.plan.id,
						review.revision,
						candidate.id,
						JSON.stringify(candidate.content),
						JSON.stringify(candidate.inputs),
					);
					db.prepare("UPDATE framework_iterations SET record_json=? WHERE id=? AND dataset_id=?").run(
						JSON.stringify(value),
						run.id,
						datasetId,
					);
					return candidate.id;
				}),
			);
		} catch (error) {
			withResearchDatabase(cwd, datasetId, (db) =>
				db
					.prepare(
						"UPDATE research_drafts SET status='rejected',revision=revision+1 WHERE draft_id=? AND status='open'",
					)
					.run(candidate.id),
			);
			throw error;
		}
	}
	const version = await publishResearchDraftAsync(
		cwd,
		datasetId,
		{
			draftId,
			revision: 1,
			expectedVersionId: run.basisVersionId,
			requestId: `iteration_review_${run.id}`,
			iteration: {
				runId: run.id,
				automatic: false,
				reviewPlanId: review.plan.id,
				reviewRevision: review.revision,
				reviewActorId: input.actorId || review.events.at(-1)?.actorId,
			},
		},
		{ signal },
	);
	return version.id;
}
