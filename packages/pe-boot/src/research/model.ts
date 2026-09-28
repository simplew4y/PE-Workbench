import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { isFrameworkDocument } from "./content-access.ts";

export { getFrameworkCoverageGaps, getFrameworkItems, isFrameworkDocument } from "./content-access.ts";

const text = Type.String({ minLength: 1, maxLength: 8_000, pattern: "\\S" });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
const nullableText = Type.Union([text, Type.Null()]);
const texts = Type.Array(text, { maxItems: 100 });
const evidenceId = Type.String({ minLength: 1, maxLength: 2048 });
const evidenceIds = Type.Array(evidenceId, { maxItems: 100, uniqueItems: true });
const judgmentIds = Type.Array(id, { maxItems: 100, uniqueItems: true });
const itemProperties = {
	id,
	kind: Type.Union([
		Type.Literal("thesis"),
		Type.Literal("hypothesis"),
		Type.Literal("metric"),
		Type.Literal("event"),
		Type.Literal("question"),
	]),
	claim: text,
	rationale: text,
	subject: text,
	verification: text,
	invalidation: text,
	origin: Type.Union([Type.Literal("user"), Type.Literal("research")]),
	evidenceIds,
};
const LegacyFrameworkContentSchema = Type.Object(
	{
		title: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
		objective: text,
		horizon: text,
		items: Type.Array(Type.Object(itemProperties, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
		coverageGaps: texts,
	},
	{ additionalProperties: false },
);

export const FrameworkContentSchema = Type.Object(
	{
		schemaVersion: Type.Literal(2),
		title: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
		sections: Type.Object(
			{
				researchSetup: Type.Object(
					{
						objective: text,
						horizon: text,
						preferences: nullableText,
						informationCutoff: Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), Type.Null()]),
					},
					{ additionalProperties: false },
				),
				currentAssessment: Type.Object(
					{
						summary: text,
						status: text,
						returnDrivers: texts,
						keyUncertainties: texts,
						changesSinceLastVersion: text,
						evidenceIds,
					},
					{ additionalProperties: false },
				),
				businessModel: Type.Object(
					{
						summary: text,
						evidenceIds,
						drivers: Type.Array(
							Type.Object(
								{ from: text, to: text, mechanism: text, evidenceIds },
								{ additionalProperties: false },
							),
							{ maxItems: 50 },
						),
						kpis: Type.Array(
							Type.Object(
								{ name: text, period: text, value: nullableText, impact: text, evidenceIds },
								{ additionalProperties: false },
							),
							{ maxItems: 100 },
						),
					},
					{ additionalProperties: false },
				),
				investmentJudgments: Type.Object(
					{
						items: Type.Array(
							Type.Object(
								{
									...itemProperties,
									counterEvidenceIds: evidenceIds,
									confidence: Type.Object(
										{
											level: Type.Union([
												Type.Literal("high"),
												Type.Literal("medium"),
												Type.Literal("low"),
												Type.Literal("undetermined"),
											]),
											reason: text,
										},
										{ additionalProperties: false },
									),
									alternativeExplanations: texts,
								},
								{ additionalProperties: false },
							),
							{ maxItems: 100 },
						),
					},
					{ additionalProperties: false },
				),
				valuation: Type.Object(
					{
						summary: text,
						marketExpectations: text,
						evidenceIds,
						forecastComparisons: Type.Array(
							Type.Object(
								{
									metric: text,
									period: text,
									marketExpectation: nullableText,
									ownForecast: nullableText,
									difference: nullableText,
									evidenceIds,
								},
								{ additionalProperties: false },
							),
							{ maxItems: 100 },
						),
						scenarios: Type.Array(
							Type.Object(
								{
									id,
									name: text,
									assumptions: text,
									value: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
									unit: text,
									asOf: nullableText,
									expectedReturn: nullableText,
									calculation: text,
									judgmentIds,
									evidenceIds,
								},
								{ additionalProperties: false },
							),
							{ maxItems: 20 },
						),
						catalysts: Type.Array(
							Type.Object(
								{ event: text, expectedAt: text, impact: text, judgmentIds, evidenceIds },
								{ additionalProperties: false },
							),
							{ maxItems: 100 },
						),
					},
					{ additionalProperties: false },
				),
				monitoring: Type.Object(
					{
						rules: Type.Array(
							Type.Object(
								{
									id,
									judgmentIds,
									metric: text,
									source: text,
									frequency: text,
									warningThreshold: text,
									invalidationThreshold: text,
									action: text,
									thresholdBasis: text,
									evidenceIds,
								},
								{ additionalProperties: false },
							),
							{ maxItems: 100 },
						),
					},
					{ additionalProperties: false },
				),
				evidenceAndChanges: Type.Object(
					{
						sources: Type.Array(
							Type.Object(
								{ evidenceId, description: text, quality: text, limitations: text },
								{ additionalProperties: false },
							),
							{ maxItems: 200 },
						),
						openQuestions: Type.Array(
							Type.Object(
								{
									id,
									question: text,
									judgmentIds,
									status: Type.Union([Type.Literal("open"), Type.Literal("resolved")]),
									evidenceNeeded: text,
								},
								{ additionalProperties: false },
							),
							{ maxItems: 100 },
						),
						coverageGaps: texts,
						changes: Type.Array(
							Type.Object(
								{ judgmentIds, before: text, after: text, reason: text, evidenceIds },
								{ additionalProperties: false },
							),
							{ maxItems: 100 },
						),
					},
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type FrameworkContent = Static<typeof FrameworkContentSchema>;
export type LegacyFrameworkContent = Static<typeof LegacyFrameworkContentSchema>;
export type StoredFrameworkContent = FrameworkContent | LegacyFrameworkContent;
export type FrameworkItem = FrameworkContent["sections"]["investmentJudgments"]["items"][number];

export function mapFrameworkEvidenceIds(content: FrameworkContent, map: (id: string) => string): FrameworkContent {
	function visit(value: unknown, key = ""): unknown {
		if (key === "evidenceId" && typeof value === "string") return map(value);
		if (Array.isArray(value)) {
			if (key === "evidenceIds" || key === "counterEvidenceIds") return [...new Set((value as string[]).map(map))];
			return value.map((entry) => visit(entry));
		}
		if (value && typeof value === "object")
			return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, visit(entry, name)]));
		return value;
	}
	return visit(content) as FrameworkContent;
}
export function collectFrameworkEvidenceIds(content: StoredFrameworkContent): string[] {
	const ids = new Set<string>();
	if (isFrameworkDocument(content))
		mapFrameworkEvidenceIds(content, (value) => {
			ids.add(value);
			return value;
		});
	else for (const item of content.items) for (const value of item.evidenceIds) ids.add(value);
	return [...ids];
}

export interface ResearchInput {
	docId: string;
	version: number;
	parserVersion: string | null;
	readyAt: string;
	sourceChecksum?: string;
}
export interface FrameworkDraft {
	id: string;
	baseVersionId: string | null;
	revision: number;
	status: "open" | "published" | "rejected";
	content: StoredFrameworkContent;
	inputs: ResearchInput[];
	createdAt: string;
}
export interface FrameworkVersion {
	id: string;
	version: number;
	parentVersionId: string | null;
	content: StoredFrameworkContent;
	inputs: ResearchInput[];
	createdAt: string;
}
export interface FrameworkState {
	currentVersionId: string | null;
	drafts: FrameworkDraft[];
	versions: FrameworkVersion[];
}
export class ResearchError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ResearchError";
		this.status = status;
	}
}
const validator = Compile(FrameworkContentSchema);
export function validateFrameworkContent(value: unknown): FrameworkContent {
	if (!validator.Check(value))
		throw new ResearchError(
			400,
			"Investment frameworks require schemaVersion 2 and all seven sections; read the current tool schema and submit the complete document",
		);
	const items = value.sections.investmentJudgments.items;
	if (items.length === 0 && value.sections.evidenceAndChanges.coverageGaps.length === 0)
		throw new ResearchError(400, "A framework without investment judgments must explain its evidence gaps");
	const ids = new Set(items.map((item) => item.id));
	if (ids.size !== items.length) throw new ResearchError(400, "Framework item IDs must be unique");
	for (const item of items) {
		if (item.origin === "research" && item.evidenceIds.length === 0)
			throw new ResearchError(
				400,
				"Research claims require evidence; unverified user hypotheses must be labeled user",
			);
	}
	const { valuation, monitoring, evidenceAndChanges } = value.sections;
	for (const group of [valuation.scenarios, monitoring.rules, evidenceAndChanges.openQuestions]) {
		if (new Set(group.map((entry) => entry.id)).size !== group.length)
			throw new ResearchError(400, "Framework section IDs must be unique");
	}
	for (const entry of [
		...valuation.scenarios,
		...valuation.catalysts,
		...monitoring.rules,
		...evidenceAndChanges.openQuestions,
	]) {
		if (entry.judgmentIds.some((itemId) => !ids.has(itemId)))
			throw new ResearchError(400, "Framework section references an unknown judgment ID");
	}
	// Change records may refer to retired judgments; persistence verifies those IDs against this project's history.
	return value;
}
