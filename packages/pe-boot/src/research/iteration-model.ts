import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { FrameworkContent, ResearchInput } from "./model.ts";
import { ResearchError } from "./model.ts";

const text = Type.String({ minLength: 1, maxLength: 8000 });
const strings = Type.Array(text, { maxItems: 100 });
const nullableText = Type.Union([text, Type.Null()]);
const periodKind = Type.Union([
	Type.Literal("single"),
	Type.Literal("cumulative"),
	Type.Literal("point_in_time"),
	Type.Literal("unknown"),
]);
export const ObservationContextSchema = Type.Object(
	{
		periodKind,
		asOf: nullableText,
		scope: nullableText,
		basisQuote: text,
		eventKind: Type.Union([
			Type.Literal("none"),
			Type.Literal("unveiling"),
			Type.Literal("sale"),
			Type.Literal("orders"),
			Type.Literal("delivery"),
			Type.Literal("ambiguous"),
		]),
		reviewReasons: strings,
	},
	{ additionalProperties: false },
);
export const IterationObservationsSchema = Type.Object(
	{
		observations: Type.Array(
			Type.Object(
				{
					id: text,
					docId: text,
					subject: text,
					metric: text,
					value: Type.Union([Type.Number(), Type.String(), Type.Null()]),
					period: Type.Union([text, Type.Null()]),
					unit: Type.Union([text, Type.Null()]),
					role: Type.Union([
						Type.Literal("fact"),
						Type.Literal("guidance"),
						Type.Literal("forecast"),
						Type.Literal("opinion"),
					]),
					quote: text,
					evidenceIds: Type.Array(text, { minItems: 1, maxItems: 20 }),
					gaps: strings,
					context: ObservationContextSchema,
				},
				{ additionalProperties: false },
			),
			{ maxItems: 200 },
		),
		coverage: Type.Array(
			Type.Object({ docId: text, readLocations: strings, gaps: strings }, { additionalProperties: false }),
			{ maxItems: 100 },
		),
	},
	{ additionalProperties: false },
);
export const IterationImpactsSchema = Type.Object(
	{
		substantive: Type.Boolean(),
		summary: text,
		impacts: Type.Array(
			Type.Object(
				{
					judgmentIds: strings,
					sections: strings,
					observationIds: Type.Array(text, { minItems: 1, maxItems: 100 }),
					relation: Type.Union([
						Type.Literal("supports"),
						Type.Literal("weakens"),
						Type.Literal("overturns"),
						Type.Literal("supplements"),
						Type.Literal("unresolved"),
						Type.Literal("unrelated"),
					]),
					comparable: Type.Boolean(),
					comparisonBasis: Type.Union([
						Type.Object({ period: text, periodKind, scope: text }, { additionalProperties: false }),
						Type.Null(),
					]),
					reason: text,
					proposedChange: Type.Union([text, Type.Null()]),
					evidenceIds: Type.Array(text, { minItems: 1, maxItems: 100 }),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 200 },
		),
		gaps: strings,
	},
	{ additionalProperties: false },
);
export type IterationObservations = Static<typeof IterationObservationsSchema>;
export type IterationImpacts = Static<typeof IterationImpactsSchema>;
export type IterationStage = "ingest" | "extract" | "impact" | "revise" | "validate" | "publish";
export type IterationStatus =
	| "queued"
	| "running"
	| "blocked"
	| "review_required"
	| "no_change"
	| "published"
	| "failed"
	| "cancelled"
	| "rejected";
export interface IterationArtifact {
	stage: IterationStage;
	value: unknown;
	at: string;
}
export interface FrameworkIteration {
	id: string;
	datasetId: string;
	requestId: string;
	basisVersionId: string;
	modelId: string;
	processorVersion: string;
	automatic: boolean;
	reviewReasons: string[];
	status: IterationStatus;
	stage: IterationStage;
	ingestJobId: string | null;
	inputs: ResearchInput[];
	newDocIds: string[];
	artifacts: IterationArtifact[];
	invalidArtifacts: Array<IterationArtifact & { reason: string }>;
	draftId: string | null;
	versionId: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
	usage: Array<{
		stage: string;
		elapsedMs: number;
		requests: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		totalTokens?: number;
		cost: number;
	}>;
	diagnostics: Array<{ stage: string; tool: string; args?: unknown; error?: string; at: string }>;
	leaseToken: string | null;
	leaseUntil: number;
}
export interface IterationEngine {
	extract(run: FrameworkIteration, basis: FrameworkContent, signal: AbortSignal): Promise<IterationObservations>;
	impact(
		run: FrameworkIteration,
		basis: FrameworkContent,
		observations: IterationObservations,
		signal: AbortSignal,
	): Promise<IterationImpacts>;
	revise(
		run: FrameworkIteration,
		basis: FrameworkContent,
		observations: IterationObservations,
		impacts: IterationImpacts,
		signal: AbortSignal,
	): Promise<FrameworkContent>;
}
const observationsValidator = Compile(IterationObservationsSchema);
const impactsValidator = Compile(IterationImpactsSchema);
export function validateIterationObservations(value: unknown): IterationObservations {
	if (!observationsValidator.Check(value)) throw new ResearchError(400, "Invalid extracted observations");
	if (new Set(value.observations.map((o) => o.id)).size !== value.observations.length)
		throw new ResearchError(400, "Duplicate observation IDs");
	return value;
}
export function validateIterationImpacts(value: unknown): IterationImpacts {
	if (!impactsValidator.Check(value)) throw new ResearchError(400, "Invalid framework impacts");
	return value;
}
